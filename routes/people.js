import express from "express";
import Stripe from "stripe";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import Company from "../models/Company.js";
import CompanyLogo from "../models/CompanyLogo.js";
import CampaignSend from "../models/CampaignSend.js";
import Subscription from "../models/Subscription.js";
import { SessionRegistration } from "../models/Social.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter, normalizeTicketId } from "../services/ticketAccess.js";
import { makeAgendaCache } from "../services/points.js";
import { stripeSessions } from "../services/stripeSales.js";
import { clearExhibitorCache } from "../services/exhibitorCache.js";
import { storedTypes, PERSON_TYPES } from "../services/teamRoles.js";
import { cleanCxoSwitch, cxoLabel, effectiveCxo } from "../services/cxoBreakfast.js";
import {
  REMINDER_CAMPAIGN, REMINDER_COOLDOWN_MS, campaignSendStore, makeReminderSender, reminderJob, sendRsvpReminder,
} from "../services/rsvpReminder.js";
import { sendSequentially } from "../services/profileRequest.js";
import { mergeStaffEdit } from "../services/attendeeDetails.js";
import { LIVE_RSVPS, SANITY_PROJECT, rsvpDetail, rsvpRow, rsvpOptionsPayload } from "../services/rsvp.js";
import { planStaffRsvp } from "../services/rsvpStaff.js";
import {
  buildPeople, personRow, personDetail, filterPeople, sortPeople, peopleCounts, peopleCsv, agendaFor, editInfo,
  rsvpRulesFor, planPeopleReminders, stripeMaps, REMINDER_SKIP_LABELS,
} from "../services/people.js";
import { companyKey, cleanCompanyName, cleanDomain, companyDTO, domainOfUrl, LOGO_SOURCES } from "../services/companies.js";
import { findLogoCandidates, safeFetch } from "../services/logoFetch.js";
import { prepareLogo, storeLogo, chooseStore, decodeLogoDataUrl } from "../services/logoStore.js";
import { CONTACT_SELECT, contactItemsFor, syncLinkedInItem } from "../services/contactCard.js";

/* =========================================================
   Admin → People (staff only)
   ---------------------------------------------------------
   /api/console/people
     GET    /               ?q= &type= &pass= &value= &rsvp= &exhibitor= &rsvpEmail= &vip= &status= &sort= &dir= &page=
                            → { total, page, size, rows, counts, stripe }
     GET    /export         the same view as CSV (management: it holds emails)
     GET    /reminder       ?(the same filters) → { counts, targets: [{ email, name, tickets, people }], skipped, job, cooldownHours }
                            who "Send RSVP reminder" would email (Unconfirmed, a usable email, a pass)
     POST   /reminder       { query: (the filters), confirm: "SEND", expected: n } (management)
                            → 202 { started, toSend, job }; sent in the background, 600 ms apart
     GET    /reminder/job   → { job }
     GET    /:id            the profile: person, passes, RSVP (+ catalog for the editor),
                            agenda (sessions saved in the app + RSVP special events), company,
                            contactCard (their app contact details, read only)
     PATCH  /:id            { name?, email? (management), linkedinUrl?, company?, jobTitle?, exhibitor?, vip? }
     PATCH  /:id/passes/:ticketId  { cxoBreakfast: true | false | null (automatic) }
     PUT    /:id/rsvp       { days, options, dietary, dietaryOther?, accessibility?, tier?,
                              allowOutsidePass?, basedOn?, rsvpId? } (an RSVP the attendee sent: add only)
   /api/console/companies
     GET    /candidates     ?name= &domain= : logos found on the internet + ours (rate limited)
     POST   /logo           { name, domain?, url? | data?, source?, personId?, forPerson? }
     POST   /logo/clear     { name } (company default) | { personId } (that person's own logo)
   ---------------------------------------------------------
   How people are joined, pass and RSVP status: services/people.js.
   Staff RSVPs and who wins over whom: services/rsvpStaff.js.
   Logo search and safe fetching: services/logoFetch.js; storage:
   services/logoStore.js. Every change is audited; nothing here emails
   anyone except POST /reminder (the RSVP reminder, management, after a
   confirmation), and listing never creates an account or any other record.
========================================================= */

const clean = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

async function audit(req, action, targetType = "", targetId = "", detail = "") {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType,
                            targetId: String(targetId), detail: String(detail).slice(0, 500) }).catch(() => {});
}

/* ---------- Sanity (public CDN, read only) ---------- */
const cdn = (groq) => `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(groq)}`;
const rows = (json) => (Array.isArray(json?.result) && json.result.length ? json.result : null);

const speakerCache = makeAgendaCache({
  url: cdn('*[_type=="speaker" && !(_id in path("drafts.**"))]{_id,name,title,company,linkedin,"imageUrl":image.asset->url}'),
  parse: rows, label: "PEOPLE SPEAKERS", ttlMs: 10 * 60 * 1000,
});
// Logos we already have: website partners, sponsors and the sponsor strips.
const cmsLogoCache = makeAgendaCache({
  url: cdn('*[_type in ["partner","sponsor","sponsorMarquee","homeSponsor"] && defined(logo) && !(_id in path("drafts.**"))]{_id,_type,name,url,"logoUrl":logo.asset->url}'),
  parse: rows, label: "PEOPLE CMS LOGOS", ttlMs: 10 * 60 * 1000,
});
const agendaCache = makeAgendaCache({
  url: cdn('*[_type=="session" && !(_id in path("drafts.**"))]{_id,sessionId,day,time,endTime,title,type,format,stage}'),
  parse: rows, label: "PEOPLE AGENDA", ttlMs: 60 * 1000,
});

/* ---------- Refunds and ticket values (Stripe, when configured) ---------- */
async function loadStripe() {
  if (!process.env.STRIPE_SECRET_KEY) return { refunds: null, values: null, stripe: "off" };
  const work = stripeSessions(new Stripe(process.env.STRIPE_SECRET_KEY)).then(stripeMaps);
  // Never hold the list up: a slow first read carries on in the background and fills stripeSessions' cache.
  const slow = new Promise((resolve) => setTimeout(() => resolve("slow"), 4000));
  try {
    const r = await Promise.race([work, slow]);
    if (r === "slow") { work.catch((err) => console.error("PEOPLE STRIPE ERROR:", err?.message || err)); return { refunds: null, values: null, stripe: "slow" }; }
    return { ...r, stripe: "ok" };
  } catch (err) {
    console.error("PEOPLE STRIPE ERROR:", err?.message || err);
    return { refunds: null, values: null, stripe: "error" };
  }
}

/* ---------- The directory, rebuilt at most every 20 s (and after every change made here) ---------- */
const DETAIL_FIELDS = ["firstName", "lastName", "organisation", "organization", "company", "jobTitle", "title", "linkedin"];
const USER_SELECT = ["name email role types typesOff vip banned organization jobTitle linkedinUrl companyLogoUrl lastActiveAt createdAt avatarVersion",
  "tickets.ticketId tickets.type tickets.purchaseDate tickets.checkedIn tickets.hiddenByStaff tickets.promoCode tickets.stripeSessionId tickets.cxoBreakfast",
  ...DETAIL_FIELDS.map((k) => `tickets.details.${k}`)].join(" ");
const ATTENDEE_SELECT = ["name email ticketId ticketType promoCode purchaseDate checkedIn hiddenByStaff syncDuplicate claimedBy speakerId",
  "stripeSessionId passEmailSentAt passEmailRsvp speakerNudgedAt issuedPass.label issuedPass.booth issuedPass.rsvp exhibitor vip cxoBreakfast",
  "companyLogoUrl createdAt", ...DETAIL_FIELDS.map((k) => `details.${k}`)].join(" ");

async function loadDirectory() {
  const [users, attendees, rsvps, companies, speakers, stripe, reminders] = await Promise.all([
    User.find({}).select(USER_SELECT).lean(),
    Attendee.find({}).select(ATTENDEE_SELECT).lean(),
    Rsvp.find(LIVE_RSVPS).lean(),
    Company.find({}).lean(),
    speakerCache.get(),
    loadStripe(),
    CampaignSend.find({ campaign: REMINDER_CAMPAIGN, sentAt: { $ne: null } }).select("email sentAt").lean(),
  ]);
  const built = buildPeople({
    users, attendees, rsvps, speakers: speakers || [], companies, refunds: stripe.refunds, stripe: stripe.values, reminders,
  });
  return { ...built, rsvps, stripe: stripe.stripe, speakersLoaded: !!speakers, builtAt: new Date() };
}

const DIR_TTL_MS = 20 * 1000;
let dir = { at: 0, data: null, pending: null, gen: 0 };
async function directory({ fresh = false, maxAgeMs = DIR_TTL_MS } = {}) {
  if (!fresh && dir.data && Date.now() - dir.at < maxAgeMs) return dir.data;
  if (dir.pending && !fresh) return dir.pending;
  const gen = dir.gen;
  const pending = loadDirectory().then((data) => {
    // A change made while this was loading (invalidate) wins: don't keep the older copy.
    if (dir.gen === gen) dir = { at: Date.now(), data, pending: null, gen };
    return data;
  }).catch((err) => { if (dir.pending === pending) dir.pending = null; throw err; });
  dir.pending = pending;
  return pending;
}
const invalidate = () => { dir = { at: 0, data: null, pending: null, gen: dir.gen + 1 }; };

async function findPerson(id, { fresh = false, maxAgeMs = DIR_TTL_MS } = {}) {
  const key = String(id || "").slice(0, 80);
  let d = await directory({ fresh, maxAgeMs });
  let p = d.byId.get(key);
  if (!p && !fresh) { d = await directory({ fresh: true }); p = d.byId.get(key); }
  return p || null;
}

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("PEOPLE ERROR:", err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

/* =========================================================
   /api/console/people
========================================================= */
const router = express.Router();
router.use(requireAdmin);

const PAGE = 50;

router.get("/", wrap(async (req, res) => {
  const d = await directory({ fresh: req.query.refresh === "1" });
  const list = sortPeople(filterPeople(d.people, req.query), String(req.query.sort || "name"), String(req.query.dir || "asc"));
  const page = Math.max(0, Math.floor(Number(req.query.page) || 0));
  res.json({
    total: list.length, page, size: PAGE,
    rows: list.slice(page * PAGE, (page + 1) * PAGE).map(personRow),
    counts: peopleCounts(d.people),
    stripe: d.stripe, speakersLoaded: d.speakersLoaded, builtAt: d.builtAt,
  });
}));

router.get("/export", requireManagement, wrap(async (req, res) => {
  const d = await directory({ fresh: true });
  const list = sortPeople(filterPeople(d.people, req.query), String(req.query.sort || "name"), String(req.query.dir || "asc"));
  await audit(req, "people_export", "person", "", `${list.length} rows`);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-people-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(peopleCsv(list, { profileBase: process.env.FRONTEND_URL || "https://www.thetechfestival.com" }));
}));

/* ---------- "Send RSVP reminder": the Marketing › RSVP reminders email, to the current view ----------
   Unconfirmed people with a usable email and a pass (services/people.js planPeopleReminders).
   GET shows exactly who would get it and who's left out; POST sends (management), after the page's
   confirmation, with the count it showed (`expected`): if the list changed since, nothing is sent. */
const REMINDER_GAP_MS = 600;
const REMINDER_MAX = 500; // emails per run; run it again for the rest (anyone reminded is then skipped)
const reminderRuns = makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const sendReminder = makeReminderSender({ store: campaignSendStore(CampaignSend), send: sendRsvpReminder });
const FILTER_KEYS = ["q", "type", "pass", "value", "rsvp", "exhibitor", "rsvpEmail", "vip", "status"];
const pickFilters = (src = {}) => Object.fromEntries(FILTER_KEYS.filter((k) => typeof src?.[k] === "string" && src[k]).map((k) => [k, String(src[k]).slice(0, 120)]));

async function reminderPlan(query, { fresh = false } = {}) {
  const d = await directory({ fresh });
  const list = filterPeople(d.people, query);
  const [optedOut, sends] = await Promise.all([
    Subscription.find({ subscribed: false }).select("email").lean(),
    CampaignSend.find({ campaign: REMINDER_CAMPAIGN }).select("email status sentAt").lean(),
  ]);
  return planPeopleReminders(list, { rsvps: d.rsvps, optedOut: optedOut.map((x) => x.email), sends, cooldownMs: REMINDER_COOLDOWN_MS });
}
const planOut = (plan) => ({
  counts: { ...plan.counts, toSend: Math.min(plan.targets.length, REMINDER_MAX), max: REMINDER_MAX },
  targets: plan.targets.slice(0, REMINDER_MAX).map((t) => ({ email: t.email, name: t.name, tickets: t.tickets.length, people: t.people })),
  skipped: plan.skipped.slice(0, 1000),
  skipLabels: REMINDER_SKIP_LABELS,
  cooldownHours: REMINDER_COOLDOWN_MS / 3600000,
  job: reminderJob.view(),
});

router.get("/reminder/job", (req, res) => res.json({ job: reminderJob.view() }));

router.get("/reminder", wrap(async (req, res) => {
  res.json(planOut(await reminderPlan(pickFilters(req.query), { fresh: req.query.refresh === "1" })));
}));

router.post("/reminder", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "SEND") return res.status(400).json({ error: "Confirm the send first." });
  if (reminderJob.state.running) return res.status(409).json({ error: "A reminder send is already running. Try again when it finishes.", job: reminderJob.view() });
  const filters = pickFilters(b.query);
  const plan = await reminderPlan(filters, { fresh: true });
  const todo = plan.targets.slice(0, REMINDER_MAX);
  if (Number(b.expected) !== todo.length) {
    return res.status(409).json({ code: "changed", error: "The list changed since you checked it. Look at the new count, then send again.", ...planOut(plan) });
  }
  if (!todo.length) return res.status(400).json({ error: "Nobody here needs a reminder." });
  if (!reminderRuns.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of reminder sends. Try again in an hour." });
  const by = String(req.user.email || req.user._id);
  reminderJob.start(req.user.name || req.user.email || "", "people", todo.length);
  const view = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(" ") || "everyone";
  await audit(req, "people_rsvp_reminder_start", "campaign", REMINDER_CAMPAIGN,
    `${todo.length} emails (${plan.counts.people} people) for ${view}; left out ${plan.counts.skipped}, already confirmed ${plan.counts.confirmed}`);
  res.status(202).json({ started: true, toSend: todo.length, job: reminderJob.view() });

  (async () => {
    const failures = [];
    try {
      await sendSequentially(todo, async (t) => {
        try {
          const out = await sendReminder(t, by);
          if (out === "skipped") reminderJob.state.skipped++; else reminderJob.state.sent++;
        } catch (err) {
          reminderJob.state.failed++;
          failures.push(`${t.email}: ${String(err?.message || err).slice(0, 80)}`);
          throw err;
        }
      }, { delayMs: REMINDER_GAP_MS });
    } catch (err) {
      console.error("PEOPLE RSVP REMINDER ERROR:", err?.message || err);
    } finally {
      reminderJob.finish();
      invalidate();
      const st = reminderJob.state;
      await audit(req, "people_rsvp_reminder_done", "campaign", REMINDER_CAMPAIGN,
        `sent ${st.sent}, failed ${st.failed}, skipped ${st.skipped}${failures.length ? ` · ${failures.slice(0, 5).join("; ")}` : ""}`);
    }
  })();
}));

router.get("/:id", wrap(async (req, res) => {
  // A profile is opened to check or change something: at most a few seconds old (an RSVP sent
  // from /rsvp a moment ago shows), where the list can be 20 s old.
  const p = await findPerson(req.params.id, { maxAgeMs: 3000 });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const [regs, agenda, cmsLogos, card] = await Promise.all([
    p.user ? SessionRegistration.find({ userId: p.user._id }).select("sessionId").lean() : Promise.resolve([]),
    agendaCache.get(),
    cmsLogoCache.get(),
    p.user ? User.findById(p.user._id).select(CONTACT_SELECT).lean() : Promise.resolve(null),
  ]);
  const person = personDetail(p, { management: isManagement(req.user), cmsLogos: cmsLogos || [] });
  res.json({
    canonicalId: p.id,
    person,
    rsvp: p.rsvp ? rsvpDetail(p.rsvp) : null,
    otherRsvps: p.rsvps.filter((r) => r !== p.rsvp).map(rsvpRow),
    rsvpDuplicates: p.dupRsvps.map(rsvpRow),
    agenda: { sessions: agendaFor(regs.map((r) => r.sessionId), agenda), agendaReadable: !!agenda, specialEvents: person.specialEvents },
    catalog: rsvpOptionsPayload(),
    logoStore: chooseStore(),
    // Their app contact card, read only: [{ kind, label, value, shareByDefault }] (each person picks what they share).
    contactCard: contactItemsFor(card).map((it) => ({ kind: it.kind, label: it.label, value: it.value, shareByDefault: it.shareByDefault })),
  });
}));

const LINK = /^https?:\/\/[^\s<>"]+$/i;

router.patch("/:id", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const management = isManagement(req.user);
  const info = editInfo(p, { management });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const want = {};
  if (b.name !== undefined) {
    want.name = clean(b.name, 120);
    if (!want.name) return res.status(400).json({ error: "Enter their name", field: "name" });
  }
  if (b.email !== undefined) {
    if (!management) return res.status(403).json({ error: "Only management can change email addresses" });
    want.email = clean(b.email, 200).toLowerCase();
    if (want.email && !EMAIL.test(want.email)) return res.status(400).json({ error: "Enter a valid email address", field: "email" });
  }
  if (b.linkedinUrl !== undefined) {
    want.linkedinUrl = clean(b.linkedinUrl, 300);
    if (want.linkedinUrl && !LINK.test(want.linkedinUrl)) return res.status(400).json({ error: "Enter the full LinkedIn link, starting https://", field: "linkedinUrl" });
  }
  if (b.company !== undefined) want.company = cleanCompanyName(b.company);
  if (b.jobTitle !== undefined) want.jobTitle = clean(b.jobTitle, 160);
  if (b.exhibitor !== undefined) want.exhibitor = b.exhibitor === true;
  if (b.vip !== undefined) {
    if (typeof b.vip !== "boolean") return res.status(400).json({ error: "VIP must be Yes or No", field: "vip" });
    want.vip = b.vip;
  }
  if (!Object.keys(want).length) return res.status(400).json({ error: "Nothing to change" });
  if (info.where === "none") return res.status(409).json({ error: info.reason });
  if (!info.canEdit) return res.status(403).json({ error: info.reason || "You can't change this person" });

  const changed = [];
  const note = (k, from, to) => changed.push(["exhibitor", "vip"].includes(k) ? `${k === "vip" ? "VIP" : k} ${from ? "Yes" : "No"} → ${to ? "Yes" : "No"}` : k);
  const attIds = p.attendees.map((a) => a._id);

  if (p.user) {
    const u = await User.findById(p.user._id);
    if (!u) return res.status(404).json({ error: "Person not found" });
    if (want.name && want.name !== u.name) { note("name"); u.name = want.name; }
    if (want.email !== undefined && want.email !== u.email) {
      if (!want.email) return res.status(400).json({ error: "An account needs an email address", field: "email" });
      if (await User.exists({ email: want.email, _id: { $ne: u._id } })) return res.status(409).json({ error: "Another account already uses that email", field: "email" });
      note("email"); u.email = want.email;
    }
    if (want.linkedinUrl !== undefined && want.linkedinUrl !== (u.linkedinUrl || "")) {
      note("linkedinUrl");
      const cardItems = syncLinkedInItem(u, want.linkedinUrl);   // also the first LinkedIn on their contact card
      u.linkedinUrl = want.linkedinUrl;
      if (cardItems) u.contactItems = cardItems;
    }
    if (want.company !== undefined && want.company !== (u.organization || "")) { note("company"); u.organization = want.company; }
    if (want.jobTitle !== undefined && want.jobTitle !== (u.jobTitle || "")) { note("jobTitle"); u.jobTitle = want.jobTitle; }
    if (want.exhibitor !== undefined && want.exhibitor !== p.exhibitor) {
      // The switch sets what the apps use. On: the exhibitor type (and any typesOff lifted). Off: the type staff
      // gave goes, and the automatic one (an exhibitor pass) is switched off with typesOff, so no badge or booth.
      const types = storedTypes(u.types);
      const off = storedTypes(u.typesOff);
      if (want.exhibitor) {
        u.types = PERSON_TYPES.filter((t) => t === "exhibitor" || types.includes(t));
        u.typesOff = off.filter((t) => t !== "exhibitor");
        // A pass of theirs switched off before they claimed it goes back to automatic.
        if (attIds.length) await Attendee.updateMany({ _id: { $in: attIds }, exhibitor: false }, { $unset: { exhibitor: 1 } });
      } else {
        u.types = types.filter((t) => t !== "exhibitor");
        u.typesOff = PERSON_TYPES.filter((t) => t === "exhibitor" || off.includes(t));
        if (attIds.length) await Attendee.updateMany({ _id: { $in: attIds }, exhibitor: true }, { $unset: { exhibitor: 1 } });
      }
      note("exhibitor", p.exhibitor, want.exhibitor);
    }
    if (want.vip !== undefined && (want.vip !== p.vip || typeof u.vip !== "boolean")) {
      // The VIP switch is the account's (User.vip). Their passes' own VIP marks go back to unset, so nothing contradicts it.
      u.vip = want.vip;
      if (attIds.length) await Attendee.updateMany({ _id: { $in: attIds }, vip: { $exists: true } }, { $unset: { vip: 1 } });
      if (want.vip !== p.vip) note("vip", p.vip, want.vip);
    }
    if (changed.length || u.isModified("vip")) await u.save();
  } else {
    const primaryId = p.primary?.attendeeId || String(p.attendees[0]._id);
    const a = await Attendee.findById(primaryId);
    if (!a) return res.status(404).json({ error: "Person not found" });
    if (want.name && want.name !== a.name) { note("name"); a.name = want.name; }
    if (want.email !== undefined && want.email !== (a.email || "")) {
      if (!want.email && a.ticketType !== "speaker") return res.status(400).json({ error: "This pass needs an email address", field: "email" });
      note("email"); a.email = want.email;
    }
    const edit = {};
    if (want.linkedinUrl !== undefined && want.linkedinUrl !== (a.details?.linkedin || "")) { edit.linkedin = want.linkedinUrl; note("linkedinUrl"); }
    if (want.company !== undefined && want.company !== (a.details?.organisation || "")) { edit.organisation = want.company; note("company"); }
    if (want.jobTitle !== undefined && want.jobTitle !== (a.details?.jobTitle || "")) { edit.jobTitle = want.jobTitle; note("jobTitle"); }
    if (Object.keys(edit).length) a.details = mergeStaffEdit(a.details, edit);
    if (want.exhibitor !== undefined && want.exhibitor !== p.exhibitor) {
      // On: their main pass says so (and none of their passes says No any more).
      // Off: every pass of theirs says No, an exhibitor pass included (no badge or booth in the apps).
      if (want.exhibitor) await Attendee.updateMany({ _id: { $in: attIds }, exhibitor: false }, { $unset: { exhibitor: 1 } });
      else await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { exhibitor: false } });
      a.exhibitor = want.exhibitor;
      note("exhibitor", p.exhibitor, want.exhibitor);
    }
    if (want.vip !== undefined && want.vip !== p.vip) {
      // Every pass of theirs, so the account that later claims any of them is a VIP too.
      if (want.vip) await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { vip: true } });
      else await Attendee.updateMany({ _id: { $in: attIds } }, { $unset: { vip: 1 } });
      a.vip = want.vip || undefined;
      note("vip", p.vip, want.vip);
    }
    if (changed.length) await a.save();
  }
  if (want.exhibitor !== undefined || want.vip !== undefined) clearExhibitorCache();
  if (changed.length) await audit(req, "person_edit", "person", p.id, `${p.name}: ${changed.join(", ")}`);
  invalidate();
  const after = await findPerson(p.id);
  res.json({ ok: true, changed, person: after ? personRow(after) : null });
}));

/* "CxO Breakfast included" for one pass: true / false = staff's choice, null = automatic
   (services/cxoBreakfast.js). Saved on the ticket record: the account's ticket (User.tickets) and the
   Attendee row of the same ticket, whichever exist. Never changes an RSVP. */
router.patch("/:id/passes/:ticketId", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const info = editInfo(p, { management: isManagement(req.user) });
  if (!info.canEdit) return res.status(403).json({ error: info.reason || "You can't change this person" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const want = cleanCxoSwitch(b.cxoBreakfast);
  if (want === undefined) return res.status(400).json({ error: "CxO Breakfast must be Yes, No or automatic", field: "cxoBreakfast" });
  const norm = normalizeTicketId(req.params.ticketId);
  const t = p.passList.find((x) => x.norm === norm);
  if (!t) return res.status(404).json({ error: "Pass not found" });
  const before = cxoLabel(t.cxoOverride, t.cxo);
  const op = want === null ? { $unset: { cxoBreakfast: 1 } } : { $set: { cxoBreakfast: want } };
  if (t.onAccount && p.user) {
    await User.updateOne({ _id: p.user._id, "tickets.ticketId": t.ticketId },
      want === null ? { $unset: { "tickets.$.cxoBreakfast": 1 } } : { $set: { "tickets.$.cxoBreakfast": want } });
  }
  const variants = [...new Set([t.ticketId, norm, norm.toUpperCase()])];
  await Attendee.updateMany({ ticketId: { $in: variants } }, op);
  const after = cxoLabel(want ?? undefined, effectiveCxo({ ticketType: t.type, types: p.types, override: want ?? undefined }));
  await audit(req, "pass_cxo_breakfast", "ticket", t.ticketId, `${p.name} · ${t.label} ${t.ticketId.toUpperCase()}: CxO Breakfast ${before} → ${after}`);
  invalidate();
  const fresh = await findPerson(p.id);
  res.json({ ok: true, person: fresh ? personDetail(fresh, { management: isManagement(req.user) }) : null });
}));

router.put("/:id/rsvp", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const picked = b.rsvpId ? p.rsvps.find((r) => String(r._id) === String(b.rsvpId)) : p.rsvp;
  if (b.rsvpId && !picked) return res.status(404).json({ error: "RSVP not found" });
  // The row as it is now (the directory can be a few seconds old).
  const current = picked ? await Rsvp.findOne({ _id: picked._id, ...LIVE_RSVPS }).lean() : null;
  if (picked && !current) return res.status(409).json({ error: "This RSVP changed since you opened it. Reload to see the latest.", code: "changed" });
  const plan = planStaffRsvp({
    existing: current,
    person: {
      name: p.name, firstName: p.firstName, lastName: p.lastName, email: p.email,
      pass: p.primary ? { ticketId: p.primary.ticketId, type: p.primary.type } : null,
      // CxO Breakfasts: their pass's switch (or the speaker type) and any breakfast already on their RSVP.
      ...rsvpRulesFor(p),
    },
    body: b,
    staff: { id: req.user._id, name: req.user.name },
  });
  if (plan.error) return res.status(plan.status).json({ error: plan.error, code: plan.code, field: plan.field, invalid: plan.invalid });
  let row;
  if (plan.create) {
    try {
      row = (await Rsvp.create(plan.doc)).toObject();
    } catch (err) {
      if (err?.code === 11000) return res.status(409).json({ code: "exists", error: "There's already an RSVP under this ticket or name. Find it in Leads › RSVPs." });
      throw err;
    }
  } else {
    row = await Rsvp.findOneAndUpdate({ _id: current._id, updatedAt: current.updatedAt, ...LIVE_RSVPS }, { $set: plan.set }, { new: true }).lean();
    if (!row) return res.status(409).json({ error: "This RSVP changed since you opened it. Reload to see the latest.", code: "changed" });
  }
  await audit(req, plan.audit.action, "rsvp", String(row._id), plan.audit.detail);
  invalidate();
  res.status(plan.create ? 201 : 200).json({ rsvp: rsvpDetail(row), warning: plan.warning, created: !!plan.create });
}));

/* =========================================================
   /api/console/companies
========================================================= */
export const companiesRouter = express.Router();
companiesRouter.use(requireAdmin);

const searchLimiter = makeLimiter({ max: 40, windowMs: 10 * 60 * 1000 });
const saveLimiter = makeLimiter({ max: 40, windowMs: 10 * 60 * 1000 });
const TOO_MANY = "Too many logo searches. Try again in a few minutes.";
const CMS_TYPE = { partner: "partner", sponsor: "sponsor", sponsorMarquee: "sponsor strip", homeSponsor: "home sponsor" };

const apiBase = (req) => process.env.API_URL || `${req.protocol}://${req.get("host")}`;

/** Logos already hosted by us: no fetch, no second copy. */
function ourHosted(url, req) {
  const u = String(url || "");
  const cloud = process.env.CLOUDINARY_CLOUD_NAME;
  const db = `${apiBase(req).replace(/\/+$/, "")}/api/files/company-logo/`;
  return u.startsWith(`https://cdn.sanity.io/images/${SANITY_PROJECT}/`) || u.startsWith(`https://cdn.sanity.io/files/${SANITY_PROJECT}/`)
    || (!!cloud && u.startsWith(`https://res.cloudinary.com/${cloud}/`))
    || (u.startsWith(db) && /^[a-f0-9]{24}$/.test(u.slice(db.length)));
}

async function saveToDb(logo) {
  const doc = await CompanyLogo.findOneAndUpdate(
    { sha256: logo.sha },
    { $setOnInsert: { sha256: logo.sha, contentType: logo.type, bytes: logo.buffer.length, data: logo.buffer } },
    { upsert: true, new: true },
  ).select("_id").lean();
  return String(doc._id);
}

companiesRouter.get("/candidates", wrap(async (req, res) => {
  if (!searchLimiter.hit(String(req.user._id))) return res.status(429).json({ error: TOO_MANY });
  const name = cleanCompanyName(req.query.name);
  const key = companyKey(name);
  const typed = String(req.query.domain || "").trim();
  const d = typed ? cleanDomain(typed) : null;
  if (typed && !d) return res.status(400).json({ error: "Enter the company's website, like acme.com", field: "domain" });
  if (!key && !d) return res.status(400).json({ error: "Add the company name or website first" });
  const [company, cms] = await Promise.all([key ? Company.findOne({ nameKey: key }).lean() : null, cmsLogoCache.get()]);
  const local = [];
  if (company?.logoUrl) local.push({ url: company.logoUrl, source: "current", label: "Current default" });
  for (const l of cms || []) {
    if (!l.logoUrl) continue;
    if ((key && companyKey(l.name) === key) || (d && l.url && domainOfUrl(l.url) === d.domain)) {
      local.push({ url: l.logoUrl, source: "cms", label: `Website ${CMS_TYPE[l._type] || "logo"}: ${clean(l.name, 80)}` });
    }
  }
  const found = await findLogoCandidates({ name, domain: d?.host || "", local, wikimedia: req.query.wikimedia !== "0" });
  res.json({ name, key, domain: found.domain, company: companyDTO(company), candidates: found.candidates, errors: found.errors, store: chooseStore() });
}));

companiesRouter.post("/logo", wrap(async (req, res) => {
  if (!saveLimiter.hit(String(req.user._id))) return res.status(429).json({ error: TOO_MANY });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const forPerson = b.forPerson === true;
  const person = b.personId ? await findPerson(b.personId, { fresh: true }) : null;
  if (forPerson && !person) return res.status(404).json({ error: "Person not found" });
  if (forPerson && !person.user && !person.attendees.length) {
    return res.status(409).json({ error: "This person has no account or pass yet, so a logo of their own can't be saved. Set the company's logo instead." });
  }
  const name = cleanCompanyName(b.name || person?.company || "");
  const key = companyKey(name);
  if (!forPerson && !key) return res.status(400).json({ error: "Add the company name first", field: "name" });
  const typedDomain = String(b.domain || "").trim();
  const d = typedDomain ? cleanDomain(typedDomain) : null;
  if (typedDomain && !d) return res.status(400).json({ error: "Enter the company's website, like acme.com", field: "domain" });

  let stored;
  let source;
  let sourceUrl = "";
  if (b.url && ourHosted(b.url, req)) {
    // Already ours (the current default, a website partner's logo): use it as it is.
    stored = { url: String(b.url), store: "existing", ref: "" };
    source = ["current", "cms"].includes(b.source) ? b.source : "cms";
    sourceUrl = String(b.url);
  } else {
    let buffer;
    if (typeof b.data === "string" && b.data) {
      buffer = decodeLogoDataUrl(b.data);
      if (!buffer) return res.status(400).json({ error: "Send the image as a data URL" });
      source = "upload";
    } else if (typeof b.url === "string" && b.url.trim()) {
      try {
        const r = await safeFetch(b.url.trim(), { kind: "image" });
        buffer = r.body;
        sourceUrl = r.url;
      } catch (err) {
        return res.status(400).json({ error: `Couldn't use that image: ${err.message}`, field: "url" });
      }
      source = LOGO_SOURCES.includes(b.source) && !["upload", "current", "cms"].includes(b.source) ? b.source : "url";
    } else {
      return res.status(400).json({ error: "Pick a logo, paste an image link or upload a file" });
    }
    const logo = prepareLogo(buffer);
    if (logo.error) return res.status(400).json({ error: logo.error });
    try {
      stored = await storeLogo({ logo, name: name || person?.name || "logo", saveToDb, apiBase: apiBase(req) });
    } catch (err) {
      console.error("LOGO STORE ERROR:", err?.message || err);
      return res.status(502).json({ error: `Couldn't save the logo: ${err.message}` });
    }
  }

  let company = null;
  if (forPerson) {
    if (person.user) await User.updateOne({ _id: person.user._id }, { $set: { companyLogoUrl: stored.url } });
    else await Attendee.updateMany({ _id: { $in: person.attendees.map((a) => a._id) } }, { $set: { companyLogoUrl: stored.url } });
    await audit(req, "person_logo", "person", person.id, `${person.name}: own logo (${source}, ${stored.store})`);
  } else {
    const set = {
      name, logoUrl: stored.url, logoSource: source, logoStore: stored.store, logoRef: stored.ref, sourceUrl,
      updatedBy: clean(req.user.name, 120), updatedById: String(req.user._id),
      ...(d ? { domain: d.domain } : {}),
    };
    company = await Company.findOneAndUpdate({ nameKey: key }, { $set: set, $setOnInsert: { nameKey: key } }, { upsert: true, new: true }).lean();
    await audit(req, "company_logo", "company", key, `${name}: default logo (${source}, ${stored.store})${sourceUrl ? ` from ${sourceUrl.slice(0, 200)}` : ""}`);
  }
  invalidate();
  res.json({ ok: true, logoUrl: stored.url, store: stored.store, company: companyDTO(company), forPerson });
}));

companiesRouter.post("/logo/clear", wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.personId) {
    const person = await findPerson(b.personId, { fresh: true });
    if (!person) return res.status(404).json({ error: "Person not found" });
    if (person.user) await User.updateOne({ _id: person.user._id }, { $set: { companyLogoUrl: "" } });
    if (person.attendees.length) await Attendee.updateMany({ _id: { $in: person.attendees.map((a) => a._id) } }, { $set: { companyLogoUrl: "" } });
    await audit(req, "person_logo_clear", "person", person.id, `${person.name}: back to the company's logo`);
  } else {
    const name = cleanCompanyName(b.name);
    const key = companyKey(name);
    if (!key) return res.status(400).json({ error: "Which company?" });
    const r = await Company.updateOne({ nameKey: key }, { $set: { logoUrl: "", logoSource: "", logoStore: "", logoRef: "", sourceUrl: "", updatedBy: clean(req.user.name, 120), updatedById: String(req.user._id) } });
    if (!r.matchedCount) return res.status(404).json({ error: "That company has no logo yet" });
    await audit(req, "company_logo_clear", "company", key, `${name}: default logo removed`);
  }
  invalidate();
  res.json({ ok: true });
}));

export default router;
