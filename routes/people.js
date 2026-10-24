import express from "express";
import Stripe from "stripe";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import Company from "../models/Company.js";
import Promo from "../models/Promo.js";
import CompanyLogo from "../models/CompanyLogo.js";
import CampaignSend from "../models/CampaignSend.js";
import EmailEngagement from "../models/EmailEngagement.js";
import Subscription from "../models/Subscription.js";
import { SessionRegistration } from "../models/Social.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter, normalizeTicketId } from "../services/ticketAccess.js";
import { makeAgendaCache } from "../services/points.js";
import { stripeSessions } from "../services/stripeSales.js";
import { clearExhibitorCache } from "../services/exhibitorCache.js";
import TicketInventory from "../models/TicketInventory.js";
import { storedTypes, PERSON_TYPES, isSpeakerPass } from "../services/teamRoles.js";
import { typesEdit } from "../services/appRights.js";
import { EXTRAS, EXTRA_FIELDS, cleanExtras, effectiveExtras, extraLabel, extrasMeta, extrasWrite } from "../services/passExtras.js";
import { deletePerson, emailHash, personDeletionScope, planPersonDeletion } from "../services/accountDeletion.js";
import {
  REMINDER_CAMPAIGN, REMINDER_COOLDOWN_MS, campaignSendStore, makeReminderSender, reminderJob, sendRsvpReminder,
} from "../services/rsvpReminder.js";
import { sendSequentially } from "../services/profileRequest.js";
import { cleanStaffEdit, mergeStaffEdit } from "../services/attendeeDetails.js";
import {
  LIVE_RSVPS, SANITY_PROJECT, TIERS, TIER_LABELS, checkOptions, optionLabel, personNameKey, rsvpDetail, rsvpRow, rsvpOptionsPayload,
} from "../services/rsvp.js";
import { planStaffRsvp, splitName } from "../services/rsvpStaff.js";
import {
  buildPeople, personRow, personDetail, filterPeople, sortPeople, peopleCounts, peopleCsv, agendaFor, editInfo, namesMatch,
  rsvpRulesFor, planPeopleReminders, stripeMaps, eligibleCounts, REMINDER_SKIP_LABELS,
} from "../services/people.js";
import { companyKey, cleanCompanyName, cleanDomain, companyDTO, domainOfUrl, LOGO_SOURCES } from "../services/companies.js";
import { findLogoCandidates, safeFetch } from "../services/logoFetch.js";
import { prepareLogo, storeLogo, chooseStore, decodeLogoDataUrl } from "../services/logoStore.js";
import { forgetOrganisations } from "../services/organisations.js";
import { CONTACT_SELECT, contactItemsFor, syncLinkedInItem } from "../services/contactCard.js";
import { usableEmail } from "../services/attendingCampaign.js";
import { sendAttendingEmail } from "../services/attendingEmail.js";
import {
  ATTENDING_CAMPAIGN, ATTENDING_TRACKING, NUDGE_COOLDOWN_DAYS, NUDGE_COOLDOWN_MS, NUDGE_MAX, NUDGE_SKIP_LABELS, attendingJob, planAttendingNudges,
} from "../services/attendingNudge.js";
import { SINGLE_SEND_LIMIT, staffNote } from "../services/staffPowers.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { COOLDOWN_DAYS as APP_INVITE_COOLDOWN_DAYS, appInviteJob, planAppInvites } from "../services/appInvite.js";
import { inviteInputs, loadInviteTemplate, makeInviteSender } from "../services/appInviteSend.js";
import { loadSwag } from "../services/swag.js";
import { deskGuestChanged, deskInclusionsChanged } from "../services/checkinDeskLog.js";
import { guestView } from "../services/checkinDesk.js";
import { accessOf } from "../services/rightsStore.js";
import {
  HIDE_SELECT, WHILE_HIDDEN, cleanReason, removeWhileHidden, setHidden, setHideReason, whileHiddenCounts,
} from "../services/appHide.js";

/* =========================================================
   Admin → People (staff only)
   ---------------------------------------------------------
   /api/console/people
     GET    /               ?q= &type= &pass= &value= &rsvp= &exhibitor= &rsvpEmail= &vip= &status= &attending= &sort= &dir= &page=
                            → { total, page, size, rows, counts, stripe }
                            (Oct 19 2026: rows carry `engagement`, counts the engagement totals and `unattributedPosts`;
                            ?attending=, ?rsvpEmail= and ?rsvp= take the engagement values, services/people.js filterPeople)
     GET    /export         the same view as CSV (management: it holds emails)
     GET    /reminder       ?(the same filters) → { counts, targets: [{ email, name, tickets, people }], skipped, job, cooldownHours }
                            who "Send RSVP reminder" would email (Unconfirmed, a usable email, a pass)
     POST   /reminder       { query: (the filters), confirm: "SEND", expected: n } (management)
                            → 202 { started, toSend, job }; sent in the background, 600 ms apart
     GET    /reminder/job   → { job }
     GET    /nudge          ?(the same filters) → { counts, targets, skipped, skipLabels, cooldownDays, tracking, job }
                            who "Send LinkedIn nudge" (the "I'm attending" email) would email, and who's left out and why
     POST   /nudge          { query, confirm: "SEND", expected: n } (management) → 202 { started, toSend, job }
     GET    /nudge/job      → { job }
     POST   /:id/reminder   the RSVP reminder to this one person (staff and management; the 20-hour cool-down applies)
                            → { sent, email, sentAt } | 409 { code: <skip reason>, error }
     POST   /:id/nudge      the "I'm attending" email to this one person (staff and management; the 3-day cool-down)
                            → { sent, email, sentAt } | 409 { code: <skip reason>, error }
     GET    /:id            the profile: person, passes, RSVP (+ catalog for the editor),
                            agenda (sessions saved in the app + RSVP special events), company,
                            contactCard (their app contact details, read only)
     PATCH  /:id            { firstName?, lastName? (or name), email? (management), phone?, linkedinUrl?, company?, jobTitle?,
                              types?, typesOff? (accounts), exhibitor?, vip?, rsvpEmailSent? (true | false | null) }
                            every record they're made of follows: the account, their passes, their RSVP rows
     PATCH  /:id/passes/:ticketId  { extras?: { cxo?, lunch?, gala?, awards? } (each true | false | null = automatic),
                              cxoBreakfast?: true | false | null (the CxO Breakfasts, as before), tier? (management: the four or speaker),
                              manualValue?: CAD | null, manualValueNote? (management; passes paid outside Stripe) }
     GET    /eligible       who is eligible for each pass extra (Leads › RSVPs headcounts):
                            { byExtra: { cxo, lunch, gala, awards }, byOption: { cxo_d1, …, awards }, passes, extras: [meta] }
     GET    /:id/delete-plan  (management) exactly what Delete person removes, with counts, and what stays
     DELETE /:id            { confirmName } (management) deletes them from the database (services/accountDeletion.js)
     PUT    /:id/rsvp       { days, options, dietary, dietaryOther?, accessibility?, tier?,
                              allowOutsidePass?, basedOn?, rsvpId? } (an RSVP the attendee sent: add only)
   /api/console/companies
     GET    /candidates     ?name= &domain= : logos found on the internet + ours (rate limited)
     POST   /logo           { name, key?, domain?, url? | data?, source?, personId?, forPerson? }
                            key: an attending organisation's key (GET /api/console/organisations), so the logo is that
                            organisation's whatever its display name; a Company record is made when there's none yet
     POST   /logo/clear     { name, key? } (company default) | { personId } (that person's own logo)
   ---------------------------------------------------------
   How people are joined, pass and RSVP status: services/people.js.
   Staff RSVPs and who wins over whom: services/rsvpStaff.js.
   Logo search and safe fetching: services/logoFetch.js; storage:
   services/logoStore.js. Every change is audited; nothing here emails
   anyone except the RSVP reminder and the "I'm attending" LinkedIn nudge:
   to a filtered view (POST /reminder, POST /nudge: management, after a
   confirmation with the count), or to one person from their profile
   (POST /:id/reminder, POST /:id/nudge: staff too, Oct 19 2026, rate-limited,
   with the same cool-downs). Listing never creates an account or any other record.
   Passes (Oct 19 2026): Connect, Influence, Power, Apex and the internal
   Speaker Pass (holding one makes someone a speaker); an exhibitor pass is
   a Connect Pass, named so; "All Access" is the Power Pass.
========================================================= */

const n = (r) => r?.modifiedCount ?? 0;
/** The audit action for each pass extra's switch (the CxO Breakfasts' is the one it always was). */
const EXTRA_AUDIT = { cxo: "pass_cxo_breakfast", lunch: "pass_luncheons", gala: "pass_gala_dinner", awards: "pass_awards_night" };
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
const DETAIL_FIELDS = ["firstName", "lastName", "organisation", "organization", "company", "jobTitle", "title", "linkedin", "phone"];
const VALUE_FIELDS = ["manualValue", "manualValueNote", "manualValueBy", "manualValueAt"];
const USER_SELECT = ["name email role staffRole types typesOff vip banned organization jobTitle linkedinUrl companyLogoUrl lastActiveAt appOnboarded createdAt avatarVersion",
  `+rsvpEmailMark +rsvpEmailMarkBy +rsvpEmailMarkAt ${HIDE_SELECT}`,
  "tickets.ticketId tickets.type tickets.purchaseDate tickets.checkedIn tickets.checkedInAt tickets.hiddenByStaff tickets.promoCode tickets.stripeSessionId",
  ...EXTRA_FIELDS.map((f) => `tickets.${f}`),
  "tickets.upgradedFrom", ...VALUE_FIELDS.map((k) => `tickets.${k}`), ...DETAIL_FIELDS.map((k) => `tickets.details.${k}`)].join(" ");
const ATTENDEE_SELECT = ["name email ticketId ticketType promoCode purchaseDate checkedIn checkedInAt hiddenByStaff syncDuplicate claimedBy speakerId",
  "stripeSessionId passEmailSentAt passEmailRsvp speakerNudgedAt issuedPass.label issuedPass.booth issuedPass.rsvp exhibitor vip media", ...EXTRA_FIELDS,
  "rsvpEmailMark rsvpEmailMarkBy rsvpEmailMarkAt", ...VALUE_FIELDS,
  "companyLogoUrl createdAt", HIDE_SELECT, ...DETAIL_FIELDS.map((k) => `details.${k}`)].join(" ");

const ENGAGEMENT_SELECT = "campaign email ticketId opens firstOpenAt lastOpenAt visits firstVisitAt lastVisitAt posts postedAt lastPostedAt postUrl "
  + "shares sharedAt lastSharedAt manuals manualAt lastManualAt trackedAt";

async function loadDirectory() {
  const [users, attendees, rsvps, companies, speakers, stripe, reminders, attending, engagement, promos] = await Promise.all([
    User.find({}).select(USER_SELECT).lean(),
    Attendee.find({}).select(ATTENDEE_SELECT).lean(),
    Rsvp.find(LIVE_RSVPS).lean(),
    Company.find({}).lean(),
    speakerCache.get(),
    loadStripe(),
    CampaignSend.find({ campaign: REMINDER_CAMPAIGN, sentAt: { $ne: null } }).select("email sentAt").lean(),
    CampaignSend.find({ campaign: ATTENDING_CAMPAIGN }).select("email status sentAt sends").lean(),
    // Opens, page visits, posts and RSVP form opens (services/engagement.js); a read failure only hides them.
    EmailEngagement.find({}).select(ENGAGEMENT_SELECT).lean().catch((err) => { console.error("PEOPLE ENGAGEMENT ERROR:", err?.message || err); return []; }),
    // Each code's discount, for "SPRING20 · 20% off" (services/promoCodes.js); a read failure only drops the discount.
    Promo.find({}).select("code discount").lean().catch(() => []),
  ]);
  const built = buildPeople({
    users, attendees, rsvps, speakers: speakers || [], companies, refunds: stripe.refunds, stripe: stripe.values, reminders, attending, engagement, promos,
  });
  return { ...built, rsvps, stripe: stripe.stripe, speakersLoaded: !!speakers, builtAt: new Date() };
}

const DIR_TTL_MS = 20 * 1000;
let dir = { at: 0, startedAt: 0, data: null, pending: null, gen: 0 };
/** The directory (also read by the admin search, routes/console.js /search). `fresh`: a new read now (the check-in
    desk asks for one only when another instance changed a guest, one at a time). A read keeps its copy only when no
    read that started later has finished first. */
export async function directory({ fresh = false, maxAgeMs = DIR_TTL_MS } = {}) {
  if (!fresh && dir.data && Date.now() - dir.at < maxAgeMs) return dir.data;
  if (dir.pending && !fresh) return dir.pending;
  const gen = dir.gen;
  const startedAt = Date.now();
  const pending = loadDirectory().then((data) => {
    // A change made while this was loading (invalidate) wins: don't keep the older copy; nor over a newer read's.
    if (dir.gen === gen && startedAt >= dir.startedAt) dir = { at: Date.now(), startedAt, data, pending: dir.pending === pending ? null : dir.pending, gen };
    else if (dir.pending === pending) dir.pending = null;
    return data;
  }).catch((err) => { if (dir.pending === pending) dir.pending = null; throw err; });
  dir.pending = pending;
  return pending;
}
const invalidate = () => { dir = { at: 0, startedAt: 0, data: null, pending: null, gen: dir.gen + 1 }; };
/** After a change made elsewhere (Give a pass, Exhibitor passes): the next read builds the directory again. */
export const forgetPeople = () => invalidate();
/** How many times this instance's directory was invalidated (a People change made here): the check-in desk rebuilds
    its guest index when this moves (routes/checkinDesk.js). */
export const peopleGeneration = () => dir.gen;

/**
 * Media = Yes for the people holding these passes (Attendee ids, the directory's `a-<id>` aliases), for the pass
 * lists (Give a pass, Exhibitor passes, Speaker passes, Oct 23 2026): Map(attendeeId → true | false | null = not in
 * the directory), or null when the directory isn't ready within `waitMs` or can't be read. Callers then fall
 * back to the pass's own mark (Attendee.media). Never throws.
 */
export async function mediaOfPasses(ids = [], { waitMs = 2500 } = {}) {
  let timer;
  const slow = new Promise((ok) => { timer = setTimeout(() => ok(null), waitMs); });
  try {
    const d = await Promise.race([directory(), slow]);
    if (!d) return null;
    return new Map(ids.map((id) => {
      const p = d.byId.get(`a-${id}`);
      return [String(id), p ? p.types.includes("media") : null];
    }));
  } catch (err) {
    console.error("PEOPLE MEDIA LOOKUP ERROR:", err?.message || err);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One person as the database has them now (the check-in desk's meal doors, Oct 23 2026): their account and pass
 * records read again and joined with the directory's own rules (buildPeople, services/passExtras.js), so a switch
 * staff just made on any server instance counts at once. `p`: their directory record (which records are theirs):
 * the passes it lists, and any pass since on their account, claimed by it, sent to one of their email addresses or
 * made for their speaker profile (a pass given a moment ago with Give a pass; buildPeople's name rule still decides
 * whether it's theirs). Refunds aren't read (the caller leaves out what the directory knew as refunded). → the
 * person record, or null.
 */
export async function personNow(p) {
  if (!p) return null;
  const passIds = (p.passList || []).map((t) => t.ticketId).filter(Boolean);
  const variants = (ids) => [...new Set(ids.flatMap((id) => [String(id), normalizeTicketId(id), normalizeTicketId(id).toUpperCase()]))];
  const emails = [...new Set([...(p.emails || []), p.email, p.user?.email].map((e) => String(e || "").trim().toLowerCase()).filter((e) => e && !/@ticket\.thetechfestival\.com$/.test(e)))];
  const or = [{ _id: { $in: (p.attendees || []).map((a) => a._id) } }, { ticketId: { $in: variants(passIds) } }];
  if (emails.length) or.push({ email: { $in: emails } });
  if (p.user?._id) or.push({ claimedBy: p.user._id });
  if (p.speaker?._id) or.push({ speakerId: String(p.speaker._id) });
  const first = await Attendee.find({ $or: or }).select(ATTENDEE_SELECT).lean();
  const userIds = [...new Set([p.user?._id, ...first.map((a) => a.claimedBy)].filter(Boolean).map(String))];
  const users = userIds.length ? await User.find({ _id: { $in: userIds } }).select(USER_SELECT).lean() : [];
  const have = new Set(first.map((a) => String(a._id)));
  const more = variants(users.flatMap((u) => (u.tickets || []).map((t) => t.ticketId)).filter(Boolean)).filter((id) => !first.some((a) => a.ticketId === id));
  const extra = more.length ? (await Attendee.find({ ticketId: { $in: more } }).select(ATTENDEE_SELECT).lean()).filter((a) => !have.has(String(a._id))) : [];
  const built = buildPeople({ users, attendees: [...first, ...extra], speakers: p.speaker ? [p.speaker] : [] });
  const main = normalizeTicketId(p.primary?.ticketId || passIds[0] || "");
  return (main && built.byId.get(`t-${main}`)) || (p.user && built.byId.get(`u-${p.user._id}`)) || built.people[0] || null;
}

/** The directory's person for an id (t-<ticket ID>, u-…, a-…, s-…) as they are after a change made here: one fresh
    directory read (the desk's next rebuild reuses it), at most `waitMs`. → the person, or null (slower, or gone). */
export async function personAfterChange(id, { waitMs = 4000 } = {}) {
  const raw = String(id || "");
  const key = raw.startsWith("t-") ? `t-${normalizeTicketId(raw.slice(2))}` : raw;
  let timer;
  const slow = new Promise((ok) => { timer = setTimeout(() => ok(null), waitMs); timer.unref?.(); });
  try {
    const d = await Promise.race([directory(), slow]);
    return d?.byId?.get(key) || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findPerson(id, { fresh = false, maxAgeMs = DIR_TTL_MS } = {}) {
  const raw = String(id || "").slice(0, 80);
  const key = raw.startsWith("t-") ? `t-${normalizeTicketId(raw.slice(2))}` : raw; // t-<ticket ID>: from Ticket records

  let d = await directory({ fresh, maxAgeMs });
  let p = d.byId.get(key);
  if (!p && !fresh) { d = await directory({ fresh: true }); p = d.byId.get(key); }
  return p || null;
}

/** What a change sent the check-in desk app (its guest / inclusions event): `deskGuest`, the guest's whole desk row as
    it is now (staff's view: inclusions across all their passes), and `deskSeq`, so the desk app uses it as it is and
    never merges one pass's answer into it. Nothing when no row was sent (the desks reload). */
const deskReply = (ev) => (ev?.guest ? { deskGuest: guestView(ev.guest, { staff: true }), deskSeq: ev.seq } : {});

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
    counts: { ...peopleCounts(d.people), unattributedPosts: d.unattributedPosts || 0 },
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
const sendReminder = makeReminderSender({ store: campaignSendStore(CampaignSend, { Subscription }), send: sendRsvpReminder });
const FILTER_KEYS = ["q", "type", "pass", "value", "rsvp", "exhibitor", "rsvpEmail", "vip", "status", "attending"];
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
          if (out === "skipped" || out === "unsubscribed") reminderJob.state.skipped++; else reminderJob.state.sent++;
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

/* ---------- "Send LinkedIn nudge": the "I'm attending" email, to the current view (management) ----------
   The Marketing › I'm attending campaign email, unchanged: their personal /attending link to make the image
   and post it on LinkedIn. Same confirm, count and skip list as the RSVP reminder above (services/attendingNudge.js
   planAttendingNudges): no pass, no email, suspended, unsubscribed, unconfirmed send, emailed in the last 3 days.
   Since Oct 19 2026 anyone with a confirmed LinkedIn post is left out too (services/engagement.js). Sends are
   recorded in the campaign's CampaignSend rows, so its "send to everyone" skips anyone nudged. */
const nudgeRuns = makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 });
const singleSends = makeLimiter(SINGLE_SEND_LIMIT); // one-person reminders and nudges from a profile, per staff member
const sendNudge = makeReminderSender({
  store: campaignSendStore(CampaignSend, { campaign: ATTENDING_CAMPAIGN, cooldownMs: NUDGE_COOLDOWN_MS, Subscription }),
  send: ({ to, row, track }) => sendAttendingEmail({ to, recipient: row, track }),
});

async function nudgePlan(query, { fresh = false } = {}) {
  const d = await directory({ fresh });
  const list = filterPeople(d.people, query);
  const [optedOut, sends] = await Promise.all([
    Subscription.find({ subscribed: false }).select("email").lean(),
    CampaignSend.find({ campaign: ATTENDING_CAMPAIGN }).select("email status sentAt").lean(),
  ]);
  return planAttendingNudges(list, { optedOut: optedOut.map((x) => x.email), sends, cooldownMs: NUDGE_COOLDOWN_MS });
}
const nudgeOut = (plan) => ({
  counts: { ...plan.counts, toSend: Math.min(plan.targets.length, NUDGE_MAX), max: NUDGE_MAX },
  targets: plan.targets.slice(0, NUDGE_MAX).map((t) => ({ email: t.email, name: t.name, people: t.people })),
  skipped: plan.skipped.slice(0, 1000),
  skipLabels: NUDGE_SKIP_LABELS,
  cooldownDays: NUDGE_COOLDOWN_DAYS,
  tracking: ATTENDING_TRACKING,
  job: attendingJob.view(),
});

router.get("/nudge/job", (req, res) => res.json({ job: attendingJob.view() }));

router.get("/nudge", wrap(async (req, res) => {
  res.json(nudgeOut(await nudgePlan(pickFilters(req.query), { fresh: req.query.refresh === "1" })));
}));

router.post("/nudge", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "SEND") return res.status(400).json({ error: "Confirm the send first." });
  if (attendingJob.state.running) return res.status(409).json({ error: "An \"I'm attending\" send is already running. Try again when it finishes.", job: attendingJob.view() });
  const filters = pickFilters(b.query);
  const plan = await nudgePlan(filters, { fresh: true });
  const todo = plan.targets.slice(0, NUDGE_MAX);
  if (Number(b.expected) !== todo.length) {
    return res.status(409).json({ code: "changed", error: "The list changed since you checked it. Look at the new count, then send again.", ...nudgeOut(plan) });
  }
  if (!todo.length) return res.status(400).json({ error: "Nobody here can be nudged right now." });
  if (!nudgeRuns.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of nudge sends. Try again in an hour." });
  const by = String(req.user.email || req.user._id);
  attendingJob.start(req.user.name || req.user.email || "", "people", todo.length);
  const view = Object.entries(filters).map(([k, v]) => `${k}=${v}`).join(" ") || "everyone";
  await audit(req, "people_attending_nudge_start", "campaign", ATTENDING_CAMPAIGN,
    `${todo.length} emails (${plan.counts.people} people) for ${view}; left out ${plan.counts.skipped}`);
  res.status(202).json({ started: true, toSend: todo.length, job: attendingJob.view() });

  (async () => {
    const failures = [];
    try {
      await sendSequentially(todo, async (t) => {
        try {
          const out = await sendNudge(t, by);
          if (out === "skipped" || out === "unsubscribed") attendingJob.state.skipped++; else attendingJob.state.sent++;
        } catch (err) {
          attendingJob.state.failed++;
          failures.push(`${t.email}: ${String(err?.message || err).slice(0, 80)}`);
          throw err;
        }
      }, { delayMs: REMINDER_GAP_MS });
    } catch (err) {
      console.error("PEOPLE ATTENDING NUDGE ERROR:", err?.message || err);
    } finally {
      attendingJob.finish();
      invalidate();
      const st = attendingJob.state;
      await audit(req, "people_attending_nudge_done", "campaign", ATTENDING_CAMPAIGN,
        `sent ${st.sent}, failed ${st.failed}, skipped ${st.skipped}${failures.length ? ` · ${failures.slice(0, 5).join("; ")}` : ""}`);
    }
  })();
}));

/* Who is eligible for each pass extra: every pass (not hidden, not a booth) whose extra is Yes, by staff's
   switch or automatically (services/people.js eligibleCounts). Leads › RSVPs shows it on the headcounts. */
router.get("/eligible", wrap(async (req, res) => {
  const d = await directory({ fresh: req.query.refresh === "1" });
  res.json({ ...eligibleCounts(d.people), extras: extrasMeta(), builtAt: d.builtAt });
}));

/* ---------- Hide from app (shadow mode, services/appHide.js) ----------
   Staff hide someone who's trying to cause trouble: they see the app as usual, nobody else sees
   them or anything they do, and they aren't told. Management and moderators (every staff account
   has the moderate right). Accounts and pass-only people (their passes carry it, so they stay
   hidden when they sign in); never a staff account or yourself. Unhiding shows everything again;
   `removeWhileHidden` first soft-deletes what they posted while hidden. Audited app_hide /
   app_hide_reason / app_unhide. */

const PLAIN_WHILE = Object.fromEntries(WHILE_HIDDEN.map((k) => [k.key, k.label]));

/** May this staff member hide people from the app? */
async function canHideFromApp(req) {
  if (isManagement(req.user)) return true;
  return !!(await accessOf(req.user)).rights.moderate;
}

/** Why this person can't be hidden (or shown again) by this staff member, or "". */
function hideBlock(p, req) {
  if (p.user?.role === "admin") return "Staff accounts can't be hidden from the app. Take away their staff access first.";
  if (p.user && String(p.user._id) === String(req.user._id)) return "You can't hide yourself.";
  if (!p.user && !p.attendees.length) return "They have no app account and no pass, so there's nothing to hide.";
  return "";
}

/** The profile's "Hide from app" block. Showing someone again is never blocked. */
async function appHideFor(p, req) {
  const h = p.appHidden;
  const block = h ? "" : hideBlock(p, req);
  return {
    hidden: !!h, at: h?.at || null, byName: h?.byName || "", reason: h?.reason || "",
    onApp: !!p.user, canChange: !block && await canHideFromApp(req), why: block,
    // What they did while hidden (what "also remove" would take away): only for an account.
    whileHidden: h && p.user ? await whileHiddenCounts([p.user._id], h.at) : null,
    labels: PLAIN_WHILE,
  };
}

/** The pass rows of these accounts that aren't attached to the person (claimed or held later), to clear on unhide. */
async function linkedPasses(userIds) {
  if (!userIds.length) return [];
  const users = await User.find({ _id: { $in: userIds } }).select("tickets.ticketId").lean();
  const ticketIds = users.flatMap((u) => (u.tickets || []).map((t) => t.ticketId)).filter(Boolean);
  const rows = await Attendee.find({ $or: [{ claimedBy: { $in: userIds } }, { ticketId: { $in: ticketIds } }], "appHidden.at": { $exists: true } })
    .select("_id").lean();
  return rows.map((r) => r._id);
}

const countsLine = (c) => WHILE_HIDDEN.filter((k) => c[k.key]).map((k) => `${k.label.toLowerCase()} ${c[k.key]}`).join(", ") || "nothing";

/** Everyone hidden from the app (App moderation › Hidden people), newest first. */
router.get("/app-hidden", wrap(async (req, res) => {
  const d = await directory({ fresh: req.query.refresh === "1" });
  const hidden = d.people.filter((p) => p.appHidden).sort((a, b) => new Date(b.appHidden.at) - new Date(a.appHidden.at));
  const canChange = await canHideFromApp(req);
  const rows = await Promise.all(hidden.map(async (p) => ({
    ...personRow(p),
    appHidden: { at: p.appHidden.at, byName: p.appHidden.byName, reason: p.appHidden.reason },
    onApp: !!p.user,
    whileHidden: p.user ? await whileHiddenCounts([p.user._id], p.appHidden.at) : null,
    canChange,
  })));
  res.json({ rows, total: rows.length, labels: PLAIN_WHILE, canChange, builtAt: d.builtAt });
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
  const person = personDetail(p, { management: isManagement(req.user), cmsLogos: cmsLogos || [], staffId: req.user._id });
  const outreach = await outreachFor(p);
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
    outreach,
    appHide: await appHideFor(p, req),
  });
}));

/* ---------- One person: the RSVP reminder and the LinkedIn nudge from their profile ----------
   Staff and management (the organiser, Oct 19 2026: staff may send a single reminder or nudge),
   the same emails, cool-downs and skip rules as the sends to a view above, one person per request,
   SINGLE_SEND_LIMIT an hour each, every send audited with who sent it. */

/** May each email go to this person now? → { reminder: plan, nudge: plan } for just them. */
async function singlePlans(p) {
  const d = await directory();
  const email = usableEmail(p.email);
  const [optedOut, reminded, attending] = email ? await Promise.all([
    Subscription.find({ email, subscribed: false }).select("email").lean(),
    CampaignSend.find({ campaign: REMINDER_CAMPAIGN, email }).select("email status sentAt").lean(),
    CampaignSend.find({ campaign: ATTENDING_CAMPAIGN, email }).select("email status sentAt").lean(),
  ]) : [[], [], []];
  const out = optedOut.map((x) => x.email);
  return {
    reminder: planPeopleReminders([p], { rsvps: d.rsvps, optedOut: out, sends: reminded, cooldownMs: REMINDER_COOLDOWN_MS }),
    nudge: planAttendingNudges([p], { optedOut: out, sends: attending, cooldownMs: NUDGE_COOLDOWN_MS }),
    lastReminder: reminded.find((r) => r.sentAt)?.sentAt || null,
  };
}
/** { canSend, reason, label } from a one-person plan. */
const verdict = (plan, labels) => {
  if (plan.targets.length) return { canSend: true, reason: "", label: "" };
  if (plan.counts.confirmed) return { canSend: false, reason: "confirmed", label: labels.confirmed };
  const s = plan.skipped[0];
  return { canSend: false, reason: s?.reason || "unknown", label: s?.label || "Can't be sent right now" };
};

/** The app invite email to this person (services/appInvite.js): their row, sendable now or why not (for the version
    that goes now: the swag kit one, with its own sends, while that contest is on). */
async function appInviteFor(p) {
  const email = usableEmail(p.email);
  const swag = (await loadSwag()).enabled;
  const inputs = await inviteInputs({ Subscription, CampaignSend, EmailEngagement }, email ? [email] : [], { swag });
  return planAppInvites([p], { ...inputs, mode: "one", swag }).rows[0] || null;
}

/** The profile's Emails card. */
async function outreachFor(p) {
  const [{ reminder, nudge, lastReminder }, invite] = await Promise.all([singlePlans(p), appInviteFor(p)]);
  return {
    // The app invite email (Website & app › App invite email): null = not part of TTFC 2026 (no pass or role).
    appInvite: invite ? {
      status: invite.status, sentAt: invite.sentAt, sends: invite.sends, opened: invite.opened, clicked: invite.clicked,
      usingApp: invite.usingApp, usingAfter: invite.usingAfter, canSend: invite.willGet, reason: invite.reason, label: invite.label,
      cooldownDays: APP_INVITE_COOLDOWN_DAYS, running: !!appInviteJob.state.running,
    } : null,
    rsvpReminder: { ...verdict(reminder, REMINDER_SKIP_LABELS), lastSentAt: lastReminder, cooldownHours: REMINDER_COOLDOWN_MS / 3600000, running: !!reminderJob.state.running },
    attending: {
      ...(p.attending || { status: "none", sentAt: null, nudges: 0 }), ...verdict(nudge, NUDGE_SKIP_LABELS),
      cooldownDays: NUDGE_COOLDOWN_DAYS, tracking: ATTENDING_TRACKING, running: !!attendingJob.state.running,
    },
  };
}

/** One person, one email: `kind` "reminder" (RSVP reminder) or "nudge" ("I'm attending"). */
const sendOne = (kind) => wrap(async (req, res) => {
  const reminder = kind === "reminder";
  const p = await findPerson(req.params.id, { maxAgeMs: 3000 });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const job = reminder ? reminderJob : attendingJob;
  if (job.state.running) return res.status(409).json({ code: "running", error: "A send to many people is running. Try again when it finishes." });
  const plans = await singlePlans(p);
  const plan = reminder ? plans.reminder : plans.nudge;
  const v = verdict(plan, reminder ? REMINDER_SKIP_LABELS : NUDGE_SKIP_LABELS);
  if (!v.canSend) return res.status(409).json({ code: v.reason, error: v.label });
  if (!singleSends.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of single sends in an hour. Try again later." });
  const t = plan.targets[0];
  const by = String(req.user.email || req.user._id);
  const note = staffNote(isManagement(req.user));
  const action = reminder ? "people_rsvp_reminder_one" : "people_attending_nudge_one";
  try {
    const sentAt = await (reminder ? sendReminder : sendNudge)(t, by);
    if (sentAt === "unsubscribed") return res.status(409).json({ code: "unsubscribed", error: "They unsubscribed from our emails." });
    if (sentAt === "skipped") {
      return res.status(409).json({ code: "skipped", error: reminder ? "They were reminded very recently, or someone is sending to them right now." : "They were emailed very recently, or someone is sending to them right now." });
    }
    await audit(req, action, "person", p.id, `${p.name} <${t.email}>${note}`);
    invalidate();
    return res.json({ sent: true, email: t.email, sentAt });
  } catch (err) {
    await audit(req, `${action}_failed`, "person", p.id, `${p.name} <${t.email}>${note}: ${String(err?.message || err).slice(0, 200)}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
});
router.post("/:id/reminder", sendOne("reminder"));
router.post("/:id/nudge", sendOne("nudge"));

/** The app invite email to this one person (staff; the same rules and records as Website & app › App invite email). */
router.post("/:id/app-invite", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { maxAgeMs: 3000 });
  if (!p) return res.status(404).json({ error: "Person not found" });
  if (appInviteJob.state.running) return res.status(409).json({ code: "running", error: "A send to many people is running. Try again when it finishes." });
  const row = await appInviteFor(p);
  if (!row) return res.status(409).json({ code: "notPart", error: "They have no pass or role at TTFC 2026." });
  if (!row.willGet) return res.status(409).json({ code: row.reason, error: row.label });
  if (!singleSends.hit(String(req.user._id))) return res.status(429).json({ error: "That's a lot of single sends in an hour. Try again later." });
  const note = staffNote(isManagement(req.user));
  try {
    const [template, swag] = await Promise.all([loadInviteTemplate(EmailTemplate), loadSwag()]);
    const sentAt = await makeInviteSender({ CampaignSend, template, swag })(row, String(req.user.email || req.user._id));
    if (sentAt === "unsubscribed") return res.status(409).json({ code: "unsubscribed", error: "They unsubscribed from our emails." });
    if (sentAt === "skipped") return res.status(409).json({ code: "skipped", error: "They were emailed very recently, or someone is sending to them right now." });
    await audit(req, "people_app_invite_one", "person", p.id, `${p.name} <${row.email}>${note}`);
    return res.json({ sent: true, email: row.email, sentAt });
  } catch (err) {
    await audit(req, "people_app_invite_one_failed", "person", p.id, `${p.name} <${row.email}>${note}: ${String(err?.message || err).slice(0, 200)}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || "the email service refused it"}` });
  }
}));

/** Hide from app: POST { reason? }. Already hidden → only the private reason changes. */
router.post("/:id/app-hide", wrap(async (req, res) => {
  if (!(await canHideFromApp(req))) return res.status(403).json({ error: "Only management and moderators can hide people from the app." });
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const block = hideBlock(p, req);
  if (block) return res.status(409).json({ code: "not_allowed", error: block });
  const reason = cleanReason(req.body?.reason);
  const userIds = p.user ? [p.user._id] : [];
  const attendeeIds = p.attendees.map((a) => a._id);
  if (p.appHidden) {
    if (reason !== (p.appHidden.reason || "")) {
      await setHideReason({ userIds, attendeeIds, reason });
      await audit(req, "app_hide_reason", "person", p.id, `${p.name}: ${reason || "(no reason)"}`);
    }
  } else {
    await setHidden({ userIds, attendeeIds, hide: { at: new Date(), by: req.user._id, byName: req.user.name || "", reason } });
    await audit(req, "app_hide", "person", p.id, `${p.name}${p.user ? "" : " (pass only, not on the app yet)"}: ${reason || "(no reason)"}`);
  }
  invalidate();
  const fresh = await findPerson(p.id, { fresh: true });
  res.json({ ok: true, appHide: await appHideFor(fresh || p, req) });
}));

/** Show again: POST { removeWhileHidden: true | false }. true soft-deletes what they posted while hidden first. */
router.post("/:id/app-unhide", wrap(async (req, res) => {
  if (!(await canHideFromApp(req))) return res.status(403).json({ error: "Only management and moderators can hide people from the app." });
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  if (!p.appHidden) return res.status(409).json({ code: "not_hidden", error: "They aren't hidden from the app." });
  const userIds = p.user ? [p.user._id] : [];
  const remove = req.body?.removeWhileHidden === true;
  const removed = remove && userIds.length ? await removeWhileHidden(userIds, p.appHidden.at, { by: req.user._id }) : null;
  const attendeeIds = [...p.attendees.map((a) => a._id), ...(await linkedPasses(userIds))];
  await setHidden({ userIds, attendeeIds, hide: null });
  await audit(req, "app_unhide", "person", p.id,
    `${p.name}: hidden since ${new Date(p.appHidden.at).toISOString().slice(0, 16)}; ${removed ? `removed what they posted while hidden (${countsLine(removed)})` : "kept what they posted while hidden"}`);
  invalidate();
  const fresh = await findPerson(p.id, { fresh: true });
  res.json({ ok: true, removed, appHide: await appHideFor(fresh || p, req) });
}));

const LINK = /^https?:\/\/[^\s<>"]+$/i;
const PHONE = /^[+()\d][\d\s().+-]{5,24}$/;
const foldName = (s) => String(s || "").normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/\s+/g, " ").trim();

/** Is this pass (its checkout details) theirs? A ticket on an account bought for a colleague names the colleague. */
const passIsTheirs = (details, name) => {
  const d = details || {};
  return !(d.firstName || d.lastName) || namesMatch({ firstName: String(d.firstName || ""), lastName: String(d.lastName || "") }, name);
};

/**
 * Edit any detail of a person (Admin → People → profile). Every record they're made of is kept in step:
 * the account (User), their passes (User.tickets and Attendee rows) and their RSVP rows. Body, any of:
 *   firstName, lastName (or name)        account name, the names on their own passes and RSVPs
 *   email (management)                   the account's sign-in email (unique), and the same address on their passes / RSVPs
 *   phone, company, jobTitle, linkedinUrl  the account and their own passes' checkout details (the Tickets page edit)
 *   types, typesOff                      an account's person types (the App › People rules: staff / volunteer = management)
 *   (Speaker comes with a Speaker Pass: change their pass to it, PATCH /:id/passes/:ticketId { tier: "speaker" })
 *   exhibitor, vip                       the switches (as before)
 *   media                                true / false: the Media type (Oct 20 2026). An account: its types (like the
 *                                        Exhibitor switch); a pass-only person: saved on their passes (Attendee.media)
 *   rsvpEmailSent                        true / false (staff's mark for an email sent outside the panel) | null (from our records)
 * Staff accounts: management only. Audited `person_edit` (and `person_email` for a sign-in change).
 */
router.patch("/:id", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const management = isManagement(req.user);
  const info = editInfo(p, { management, staffId: req.user._id });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const want = {};
  if (b.firstName !== undefined || b.lastName !== undefined) {
    const first = clean(b.firstName ?? p.firstName, 80);
    const last = clean(b.lastName ?? p.lastName, 80);
    if (!first) return res.status(400).json({ error: "Enter their first name", field: "firstName" });
    want.parts = { firstName: first, lastName: last };
    want.name = [first, last].filter(Boolean).join(" ");
  } else if (b.name !== undefined) {
    want.name = clean(b.name, 120);
    if (!want.name) return res.status(400).json({ error: "Enter their name", field: "name" });
    want.parts = splitName(want.name);
  }
  if (b.email !== undefined) {
    if (!management) return res.status(403).json({ error: "Only management can change email addresses" });
    want.email = clean(b.email, 200).toLowerCase();
    if (want.email && !EMAIL.test(want.email)) return res.status(400).json({ error: "Enter a valid email address", field: "email" });
  }
  if (b.phone !== undefined) {
    want.phone = clean(b.phone, 30);
    if (want.phone && !PHONE.test(want.phone)) return res.status(400).json({ error: "Enter a phone number (digits, spaces, + ( ) -)", field: "phone" });
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
  if (b.media !== undefined) {
    if (typeof b.media !== "boolean") return res.status(400).json({ error: "Media must be Yes or No", field: "media" });
    want.media = b.media;
  }
  if (b.rsvpEmailSent !== undefined) {
    if (![true, false, null].includes(b.rsvpEmailSent)) return res.status(400).json({ error: "RSVP email sent must be Yes, No or automatic", field: "rsvpEmailSent" });
    want.rsvpEmailSent = b.rsvpEmailSent;
  }
  const typesAsked = b.types !== undefined || b.typesOff !== undefined;
  if (!Object.keys(want).length && !typesAsked) return res.status(400).json({ error: "Nothing to change" });
  if (info.where === "none") return res.status(409).json({ error: info.reason });
  if (!info.canEdit) return res.status(403).json({ error: info.reason || "You can't change this person" });
  if (typesAsked && !p.user) {
    return res.status(409).json({ error: "Their types live on an app account. Without one, Exhibitor and Media are switched on their passes and Speaker comes with a Speaker Pass; the other types need an account first.", field: "types" });
  }

  const changed = [];
  const notes = [];
  const yn = (v) => (v ? "Yes" : "No");
  const note = (k, from, to) => changed.push(["exhibitor", "vip", "media"].includes(k) ? `${k === "vip" ? "VIP" : k} ${yn(from)} → ${yn(to)}` : k);
  const mediaNow = p.types.includes("media");
  const attIds = p.attendees.map((a) => a._id);
  const oldName = p.name === "No name" ? "" : p.name;
  const oldEmail = String(p.email || "").toLowerCase();
  const staffName = clean(req.user.name || req.user.email, 120);
  let emailChange = null;

  // Validate everything that can refuse before anything is written.
  let typed = { set: {} };
  if (p.user) {
    const u0 = await User.findById(p.user._id).select("types typesOff").lean();
    if (typesAsked) {
      typed = typesEdit(u0, b, { management });
      if (typed.error) return res.status(typed.status).json({ error: typed.error, field: "types" });
    }
    if (want.email !== undefined && want.email !== String(p.user.email || "").toLowerCase()) {
      if (!want.email) return res.status(400).json({ error: "An account needs an email address: it's how they sign in", field: "email" });
      if (await User.exists({ email: want.email, _id: { $ne: p.user._id } })) return res.status(409).json({ error: "Another account already uses that email", field: "email" });
    }
  } else if (want.email === "" && p.attendees.some((a) => !isSpeakerPass(a))) {
    // Only a Speaker Pass can wait for an email (staff add it in Admin › Speaker passes).
    return res.status(400).json({ error: "This pass needs an email address", field: "email" });
  }

  // 1. The account.
  if (p.user) {
    const u = await User.findById(p.user._id);
    if (!u) return res.status(404).json({ error: "Person not found" });
    if (want.name && want.name !== u.name) { note("name"); u.name = want.name; }
    if (want.email !== undefined && want.email !== String(u.email || "").toLowerCase()) {
      emailChange = { from: u.email, to: want.email };
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
    for (const [k, v] of Object.entries(typed.set)) { u[k] = v; if (!changed.includes("types")) changed.push("types"); }
    if (typed.note) notes.push(typed.note);
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
    if (want.media !== undefined && want.media !== mediaNow) {
      // The Media type on the account. Off: staff's type goes, and Media from a pass of theirs is switched off (typesOff).
      const types = storedTypes(u.types);
      const off = storedTypes(u.typesOff);
      if (want.media) {
        u.types = PERSON_TYPES.filter((t) => t === "media" || types.includes(t));
        u.typesOff = off.filter((t) => t !== "media");
      } else {
        u.types = types.filter((t) => t !== "media");
        if (p.mediaPass || off.includes("media")) u.typesOff = PERSON_TYPES.filter((t) => t === "media" || off.includes(t));
      }
      note("media", mediaNow, want.media);
    }
    if (want.vip !== undefined && (want.vip !== p.vip || typeof u.vip !== "boolean")) {
      // The VIP switch is the account's (User.vip). Their passes' own VIP marks go back to unset, so nothing contradicts it.
      u.vip = want.vip;
      if (attIds.length) await Attendee.updateMany({ _id: { $in: attIds }, vip: { $exists: true } }, { $unset: { vip: 1 } });
      if (want.vip !== p.vip) note("vip", p.vip, want.vip);
    }
    if (u.isModified()) await u.save();
    if (want.rsvpEmailSent !== undefined) {
      await User.updateOne({ _id: u._id }, want.rsvpEmailSent === null
        ? { $unset: { rsvpEmailMark: 1, rsvpEmailMarkBy: 1, rsvpEmailMarkAt: 1 } }
        : { $set: { rsvpEmailMark: want.rsvpEmailSent, rsvpEmailMarkBy: staffName, rsvpEmailMarkAt: new Date() } });
      changed.push(`RSVP email sent ${want.rsvpEmailSent === null ? "automatic" : yn(want.rsvpEmailSent)}`);
    }
  }

  // 2. Their passes: the account's own tickets and every pass row of theirs.
  const detailEdit = cleanStaffEdit({
    ...(want.phone !== undefined ? { phone: want.phone } : {}),
    ...(want.company !== undefined ? { organisation: want.company } : {}),
    ...(want.jobTitle !== undefined ? { jobTitle: want.jobTitle } : {}),
    ...(want.linkedinUrl !== undefined ? { linkedin: want.linkedinUrl } : {}),
  });
  const passName = want.name ? want.parts : null;
  let passesTouched = 0;
  const editDetails = (details) => {
    let next = details || {};
    if (Object.keys(detailEdit).length) next = mergeStaffEdit(next, detailEdit);
    if (passName && (details?.firstName || details?.lastName)) next = { ...next, firstName: passName.firstName, lastName: passName.lastName };
    return next;
  };
  if (p.user) {
    const u = await User.findById(p.user._id).select("tickets");
    let dirty = false;
    for (const t of u?.tickets || []) {
      if (!t?.ticketId || /^BOOTH-/i.test(t.ticketId) || !passIsTheirs(t.details, oldName)) continue;
      if (!Object.keys(detailEdit).length && !(passName && (t.details?.firstName || t.details?.lastName))) continue;
      t.details = editDetails(t.details);
      u.markModified("tickets");
      dirty = true;
      passesTouched++;
    }
    if (dirty) await u.save();
  }
  for (const a0 of p.attendees) {
    const a = await Attendee.findById(a0._id);
    if (!a) continue;
    // A pass on someone's account but bought for a colleague keeps the colleague's details.
    const theirs = !p.user || passIsTheirs(a.details, oldName) || namesMatch(a.name, oldName);
    if (!theirs) continue;
    let dirty = false;
    if (Object.keys(detailEdit).length || (passName && (a.details?.firstName || a.details?.lastName))) { a.details = editDetails(a.details); a.markModified("details"); dirty = true; }
    if (want.name && a.name !== want.name && (!p.user || namesMatch(a.name, oldName) || !String(a.name || "").trim())) { a.name = want.name; dirty = true; }
    if (want.email !== undefined && (emailChange || !p.user)) {
      const from = String(a.email || "").toLowerCase();
      if (from !== want.email && (from === String(emailChange?.from || oldEmail).toLowerCase() || (!p.user && !from))) { a.email = want.email; dirty = true; }
    }
    if (!p.user && want.rsvpEmailSent !== undefined) {
      if (want.rsvpEmailSent === null) { a.rsvpEmailMark = undefined; a.rsvpEmailMarkBy = undefined; a.rsvpEmailMarkAt = undefined; }
      else { a.rsvpEmailMark = want.rsvpEmailSent; a.rsvpEmailMarkBy = staffName; a.rsvpEmailMarkAt = new Date(); }
      dirty = true;
    }
    if (dirty) { await a.save(); passesTouched++; }
  }
  if (!p.user) {
    if (want.name && want.name !== oldName) note("name");
    if (want.email !== undefined && want.email !== oldEmail) { note("email"); emailChange = { from: oldEmail, to: want.email }; }
    for (const k of ["phone", "company", "jobTitle", "linkedinUrl"]) if (want[k] !== undefined && want[k] !== (p[k] || "")) note(k);
    if (want.exhibitor !== undefined && want.exhibitor !== p.exhibitor) {
      // On: their passes say so (and none of them says No any more). Off: every pass says No, an exhibitor pass included.
      if (want.exhibitor) await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { exhibitor: true } });
      else await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { exhibitor: false } });
      note("exhibitor", p.exhibitor, want.exhibitor);
    }
    if (want.media !== undefined && want.media !== mediaNow) {
      // Every pass of theirs, so the account that later claims any of them is Media too (services/teamRoles.js isMediaPass).
      if (want.media) await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { media: true } });
      else await Attendee.updateMany({ _id: { $in: attIds } }, { $unset: { media: 1 } });
      note("media", mediaNow, want.media);
    }
    if (want.vip !== undefined && want.vip !== p.vip) {
      // Every pass of theirs, so the account that later claims any of them is a VIP too.
      if (want.vip) await Attendee.updateMany({ _id: { $in: attIds } }, { $set: { vip: true } });
      else await Attendee.updateMany({ _id: { $in: attIds } }, { $unset: { vip: 1 } });
      note("vip", p.vip, want.vip);
    }
    if (want.rsvpEmailSent !== undefined) changed.push(`RSVP email sent ${want.rsvpEmailSent === null ? "automatic" : yn(want.rsvpEmailSent)}`);
  } else if (want.phone !== undefined && want.phone !== (p.phone || "")) note("phone");

  // 3. Their RSVPs: the name (and its key) and the email they're known by. What they chose is never changed.
  let rsvpsTouched = 0;
  for (const r0 of [...p.rsvps, ...p.dupRsvps]) {
    const set = {};
    if (want.name && namesMatch({ firstName: r0.firstName, lastName: r0.lastName }, oldName || want.name)) {
      const nameKey = personNameKey(want.parts.firstName, want.parts.lastName);
      Object.assign(set, { firstName: want.parts.firstName, lastName: want.parts.lastName, name: want.name, nameKey });
      if (String(r0.key || "").startsWith("n:") && r0.key !== `n:${nameKey}` && !(await Rsvp.exists({ key: `n:${nameKey}`, spam: false }))) set.key = `n:${nameKey}`;
    }
    if (emailChange && String(r0.email || "").toLowerCase() === String(emailChange.from || "").toLowerCase() && emailChange.from) set.email = emailChange.to;
    if (Object.keys(set).length) { await Rsvp.updateOne({ _id: r0._id }, { $set: set }); rsvpsTouched++; }
  }

  if (want.exhibitor !== undefined || want.vip !== undefined || want.media !== undefined || typesAsked) clearExhibitorCache();
  if (changed.length) {
    const where = [passesTouched ? `${passesTouched} pass record(s)` : "", rsvpsTouched ? `${rsvpsTouched} RSVP(s)` : ""].filter(Boolean).join(", ");
    await audit(req, "person_edit", "person", p.id, `${want.name || p.name}: ${changed.join(", ")}${notes.length ? ` | ${notes.join("; ")}` : ""}${where ? ` (also ${where})` : ""}`);
  }
  if (emailChange) {
    await audit(req, "person_email", "person", p.id,
      `${want.name || p.name}: ${p.user ? "sign-in email changed (their app and website sign-in)" : "email changed"} · ${emailHash(emailChange.from) || "none"} → ${emailHash(emailChange.to) || "none"} (sha256)`);
  }
  invalidate();
  const after = await findPerson(p.id);
  // The check-in desk app updates this guest (name, company, Media / VIP / Exhibitor marks, inclusions): the event
  // carries their row from the directory just rebuilt, so every server instance and device has it at once.
  const deskEv = changed.length ? await deskGuestChanged({ ticketIds: p.passList.map((x) => x.ticketId), user: req.user, person: after }) : null;
  res.json({ ok: true, changed, person: after ? personRow(after) : null, ...deskReply(deskEv) });
}));

/* One pass of theirs: PATCH /:id/passes/:ticketId, any of
     extras: { cxo?, lunch?, gala?, awards? }            the pass extras (services/passExtras.js), each true | false |
                                                         null (automatic); staff. Each change is audited: pass_cxo_breakfast,
                                                         pass_luncheons, pass_gala_dinner, pass_awards_night
     cxoBreakfast: true | false | null (automatic)       "CxO Breakfast included" (the same as extras.cxo)
     tier: connect | influence | power | apex | speaker  change the pass (management): one of the four or the internal
                                                         Speaker Pass (which makes them a speaker); no charge; the account
                                                         ticket, its pass row and its RSVP rows follow, and the inventory
                                                         counts move like a paid upgrade (old −1, new +1; the Speaker Pass
                                                         has no inventory, a hidden pass never counted). Audited pass_tier.
     manualValue: number (CAD before HST) | null, manualValueNote?
                                                         ticket value after payment for a pass paid outside Stripe
                                                         (management; a Stripe-paid pass keeps Stripe's). Audited pass_value.
   Saved on the ticket record: the account's ticket (User.tickets) and the Attendee row of the same ticket,
   whichever exist. Never changes what they chose in their RSVP: an extra switched to No is no longer offered,
   but one already on their RSVP stays (services/rsvp.js extraOptionsFor). */
router.patch("/:id/passes/:ticketId", wrap(async (req, res) => {
  const p = await findPerson(req.params.id, { fresh: true });
  if (!p) return res.status(404).json({ error: "Person not found" });
  const management = isManagement(req.user);
  const info = editInfo(p, { management, staffId: req.user._id });
  if (!info.canEdit) return res.status(403).json({ error: info.reason || "You can't change this person" });
  const b = req.body && typeof req.body === "object" ? req.body : {};
  const norm = normalizeTicketId(req.params.ticketId);
  const t = p.passList.find((x) => x.norm === norm);
  if (!t) return res.status(404).json({ error: "Pass not found" });
  const variants = [...new Set([t.ticketId, norm, norm.toUpperCase()])];
  const onTicket = (set, unset) => ({ ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) });
  const writeTicket = async (set, unset = {}) => {
    if (t.onAccount && p.user) {
      const sub = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`tickets.$.${k}`, v]));
      await User.updateOne({ _id: p.user._id, "tickets.ticketId": t.ticketId }, onTicket(sub(set), sub(unset)));
    }
    await Attendee.updateMany({ ticketId: { $in: variants } }, onTicket(set, unset));
  };
  let did = false;
  let deskInclusions = null;
  let deskGuest = false;
  const warnings = [];

  // Validate first.
  const extrasIn = cleanExtras(b);
  if (!extrasIn.ok) return res.status(400).json({ error: extrasIn.error, field: extrasIn.field });
  const extrasAsked = extrasIn.value; // { <key>: true | false | null } for the extras sent
  let tier;
  if (b.tier !== undefined) {
    if (!management) return res.status(403).json({ error: "Only management can change a pass", field: "tier" });
    tier = clean(b.tier, 20).toLowerCase();
    if (!TIERS.includes(tier)) return res.status(400).json({ error: "The pass must be Connect, Influence, Power, Apex or the Speaker Pass", field: "tier" });
  }
  let value;
  if (b.manualValue !== undefined) {
    if (!management) return res.status(403).json({ error: "Only management can set a ticket value", field: "manualValue" });
    if (t.stripeSessionId) return res.status(409).json({ error: "This pass was paid through Stripe, so its value comes from Stripe.", field: "manualValue" });
    if (b.manualValue === null || b.manualValue === "") value = null;
    else {
      value = Math.round(Number(b.manualValue) * 100) / 100;
      if (!Number.isFinite(value) || value < 0 || value > 100000) return res.status(400).json({ error: "Enter the amount paid in CAD, before HST (0 to 100,000)", field: "manualValue" });
    }
  }
  if (!Object.keys(extrasAsked).length && tier === undefined && value === undefined) return res.status(400).json({ error: "Nothing to change" });

  // The pass extras: only the ones that change are written, each audited like "CxO Breakfast included" always was.
  const overrideNow = t.extrasOverride || {};
  const changedExtras = Object.fromEntries(Object.entries(extrasAsked).filter(([k, v]) => (v ?? null) !== (typeof overrideNow[k] === "boolean" ? overrideNow[k] : null)));
  if (Object.keys(changedExtras).length) {
    const { set, unset } = extrasWrite(changedExtras);
    await writeTicket(set, unset);
    const overrideAfter = { ...overrideNow };
    for (const [k, v] of Object.entries(changedExtras)) { if (v === null) delete overrideAfter[k]; else overrideAfter[k] = v; }
    const effectiveAfter = effectiveExtras({ ticketType: tier || t.type, types: p.types, vip: p.vip, override: overrideAfter });
    for (const x of EXTRAS.filter((e) => e.key in changedExtras)) {
      const before = extraLabel(overrideNow[x.key], t.extras?.[x.key]);
      const after = extraLabel(overrideAfter[x.key], effectiveAfter[x.key]);
      const what = x.key === "cxo" ? "CxO Breakfast" : x.label; // the CxO line reads as it always has
      await audit(req, EXTRA_AUDIT[x.key], "ticket", t.ticketId, `${p.name} · ${t.label} ${t.ticketId.toUpperCase()}: ${what} ${before} → ${after}`);
    }
    // The check-in desk app shows the new inclusions straight away (services/checkinDeskLog.js): sent below, once the
    // directory is rebuilt, with the guest's row and their inclusions across all their passes.
    deskInclusions = { ticketId: t.ticketId, user: req.user };
    did = true;
  }
  if (Object.keys(extrasAsked).length) did = true;
  if (tier !== undefined && tier !== t.tier) {
    if (t.onAccount && p.user) await User.updateOne({ _id: p.user._id, "tickets.ticketId": t.ticketId }, { $set: { "tickets.$.type": tier } });
    await Attendee.updateMany({ ticketId: { $in: variants } }, { $set: { ticketType: tier } });
    // Their RSVP under this ticket follows the pass; what they chose stays as it is.
    const rsvpFilter = { $or: [{ key: `t:${norm}` }, { ticketId: { $in: variants }, ticketVerified: true }] };
    await Rsvp.updateMany(rsvpFilter, { $set: { tier } });
    const rsvp = await Rsvp.findOne({ ...rsvpFilter, ...LIVE_RSVPS }).lean();
    if (rsvp) {
      const rules = rsvpRulesFor(p);
      // The new pass's extras: staff's switches on this pass, else the new pass's rules.
      const extras = effectiveExtras({ ticketType: tier, types: p.types, vip: p.vip, override: t.extrasOverride || {} });
      const check = checkOptions(tier, rsvp.days || [], rsvp.options || [], { extras, extra: [...rules.extra, ...(rsvp.staffAdded || [])] });
      if (!check.ok) warnings.push(`Their RSVP has ${check.invalid.map(optionLabel).join(", ")}, which the ${TIER_LABELS[tier]} doesn't include. It stays: staff never take away what they chose.`);
    }
    // Inventory, the way a paid upgrade moves it (routes/webhook.js). The Speaker Pass has no inventory row
    // (never sold), and a hidden pass never counted.
    const moves = [];
    if (!t.hidden) {
      const from = String(t.type || "").toLowerCase();
      if (from !== "speaker" && n(await TicketInventory.updateOne({ tier: from, sold: { $gt: 0 } }, { $inc: { sold: -1 } }))) moves.push(`${from} −1`);
      const to = tier === "speaker" ? null : await TicketInventory.findOneAndUpdate({ tier }, { $inc: { sold: 1 } }, { new: true }).lean();
      if (to) {
        moves.push(`${tier} +1`);
        if (to.total > 0 && to.sold > to.total) warnings.push(`${TIER_LABELS[tier]} is now over its allocation (${to.sold} of ${to.total}). Change the allocation in Tickets › Inventory if that's right.`);
      }
    }
    const moved = moves.length ? `inventory ${moves.join(", ")}` : "inventory unchanged";
    await audit(req, "pass_tier", "ticket", t.ticketId, `${p.name} · ${t.ticketId.toUpperCase()}: ${t.label} → ${TIER_LABELS[tier]} (no charge; ${moved})`);
    deskGuest = true;
    did = true;
  }
  if (value !== undefined) {
    const before = t.manualValue !== undefined ? `${t.manualValue.toFixed(2)} CAD (manual)` : t.value === null || t.value === undefined ? "not known" : `${Number(t.value).toFixed(2)} CAD`;
    if (value === null) await writeTicket({}, { manualValue: 1, manualValueNote: 1, manualValueBy: 1, manualValueAt: 1 });
    else {
      await writeTicket({
        manualValue: value, manualValueNote: clean(b.manualValueNote, 120), manualValueBy: clean(req.user.name || req.user.email, 120), manualValueAt: new Date(),
      });
    }
    await audit(req, "pass_value", "ticket", t.ticketId, `${p.name} · ${t.ticketId.toUpperCase()}: ticket value ${before} → ${value === null ? "worked out again" : `${value.toFixed(2)} CAD (manual, paid outside Stripe)`}`);
    did = true;
  }
  if (did) invalidate();
  const fresh = await findPerson(p.id);
  // The check-in desk app: the guest's row as it is now (a pass change reloads them; extras update their inclusions).
  let deskEv = null;
  if (deskGuest) deskEv = await deskGuestChanged({ ticketIds: [t.ticketId], user: req.user, person: fresh });
  else if (deskInclusions) deskEv = await deskInclusionsChanged({ ...deskInclusions, person: fresh });
  res.json({ ok: true, warnings, person: fresh ? personDetail(fresh, { management, staffId: req.user._id }) : null, ...deskReply(deskEv) });
}));

/* ---------- Delete person (management) ----------
   GET  /:id/delete-plan  → { name, items: [{ key, label, count, change }], kept: [...], total, blockers: [..] }
   DELETE /:id { confirmName } (their full name, as shown) → { deleted: true, items, total }
   Everything in services/accountDeletion.js (deletePerson): the account, every pass and ticket row, RSVPs,
   their app content and activity, and everything under an email only they use. Never: their own account,
   the last management account. Audited `person_delete` with counts and an email hash only (no name). */
async function deletionContext(req) {
  const d = await directory({ fresh: true });
  const p = d.byId.get(String(req.params.id || "").slice(0, 80)) || null;
  if (!p) return { error: { status: 404, error: "Person not found" } };
  const blockers = [];
  if (p.user && String(p.user._id) === String(req.user._id)) blockers.push("You can't delete your own account.");
  if (p.user && isManagement(p.user)) {
    const admins = await User.find({ role: "admin" }).select("role staffRole email").lean();
    if (admins.filter(isManagement).length <= 1) blockers.push("This is the last management account. Make someone else management first.");
  }
  return { p, d, scope: personDeletionScope(p, d.people), blockers };
}

router.get("/:id/delete-plan", requireManagement, wrap(async (req, res) => {
  const ctx = await deletionContext(req);
  if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error });
  const plan = await planPersonDeletion(ctx.scope);
  if (!plan.total) ctx.blockers.push("There's nothing about them in our database to delete.");
  res.json({ id: ctx.p.id, name: ctx.p.name, ...plan, blockers: ctx.blockers, speaker: ctx.scope.speaker, sharedEmails: ctx.scope.sharedEmails.length });
}));

router.delete("/:id", requireManagement, wrap(async (req, res) => {
  const ctx = await deletionContext(req);
  if (ctx.error) return res.status(ctx.error.status).json({ error: ctx.error.error });
  if (ctx.blockers.length) return res.status(409).json({ error: ctx.blockers[0], code: "blocked" });
  const typed = foldName(req.body?.confirmName);
  if (!typed || typed !== foldName(ctx.p.name)) {
    return res.status(400).json({ error: `Type their full name (${ctx.p.name}) to confirm.`, code: "confirm", field: "confirmName" });
  }
  const result = await deletePerson(ctx.scope);
  if (!result.total) return res.status(409).json({ error: "There's nothing about them in our database to delete.", code: "nothing" });
  invalidate();
  clearExhibitorCache();
  // The check-in desk app drops them on every server instance (the event has no row: the desks read the list again).
  const passIds = (ctx.p.passList || []).map((t) => t.ticketId).filter(Boolean);
  if (passIds.length) await deskGuestChanged({ ticketIds: passIds, user: req.user });
  // Counts only, the main records first (the detail is capped at 500 characters), and an email hash: never the name or address.
  const first = ["account", "accountTickets", "passes", "rsvps"];
  const counts = [...first.map((k) => result.items.find((x) => x.key === k)).filter(Boolean), ...result.items.filter((x) => !first.includes(x.key))]
    .filter((x) => x.count).map((x) => `${x.key} ${x.count}`).join(", ");
  await audit(req, "person_delete", "person", "",
    `Deleted a person (${ctx.p.user ? "account" : ctx.p.attendees.length ? "pass only" : "RSVP only"})`
    + `${ctx.scope.mainEmail ? `, email sha256 ${emailHash(ctx.scope.mainEmail)}` : ""}${ctx.scope.speaker ? ", still on the website speaker list" : ""}: ${counts}`);
  res.json({ deleted: true, items: result.items, total: result.total, speaker: ctx.scope.speaker });
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

/** An organisation key sent by Admin › Attending organisations ("" when it isn't one: then the name decides). */
const orgKeyFrom = (v) => {
  const k = typeof v === "string" ? v.trim() : "";
  return k && k.length <= 120 && companyKey(k) === k ? k : "";
};

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
  const key = orgKeyFrom(b.key) || companyKey(name);
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
  forgetOrganisations();   // the apps' organisations list shows the new logo at once (services/organisations.js)
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
    const key = orgKeyFrom(b.key) || companyKey(name);
    if (!key) return res.status(400).json({ error: "Which company?" });
    const r = await Company.updateOne({ nameKey: key }, { $set: { logoUrl: "", logoSource: "", logoStore: "", logoRef: "", sourceUrl: "", updatedBy: clean(req.user.name, 120), updatedById: String(req.user._id) } });
    if (!r.matchedCount) return res.status(404).json({ error: "That company has no logo yet" });
    await audit(req, "company_logo_clear", "company", key, `${name}: default logo removed`);
  }
  invalidate();
  forgetOrganisations();
  res.json({ ok: true });
}));

export default router;
