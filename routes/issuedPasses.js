import express from "express";
import { Resend } from "resend";
import Attendee from "../models/Attendee.js";
import User from "../models/User.js";
import Rsvp from "../models/Rsvp.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { makeLimiter } from "../services/ticketAccess.js";
import { STAFF_PASS_LIMIT, staffNote } from "../services/staffPowers.js";
import { CONTACT_EMAIL, FROM } from "../services/speakerPassEmail.js";
import { passRecipients, validateSpeakerEmails } from "../services/speakerPasses.js";
import { LIVE_RSVPS } from "../services/rsvp.js";
import { EXTRAS, EXTRA_SELECT, autoExtras, cleanExtras, extraLabel, extrasMeta } from "../services/passExtras.js";
import { normalizeTicketId } from "../services/ticketAccess.js";
import {
  ISSUED_PROMO, ISSUE_TIERS, ISSUE_TIER_KEYS, MARK_TIERS, PASS_MARKS, defaultIssuedCopy, issuedPassDoc, issuedPassForEmail, issuedPassRow,
  issuedPassUpdate, issuedVariant, validateIssuedPass,
} from "../services/issuedPasses.js";
import { clearExhibitorCache } from "../services/exhibitorCache.js";
import {
  EXHIBITOR_PROMO, EXHIBITOR_TEMPLATE_KEY, EXHIBITOR_TIER, MANUAL_TEMPLATE_KEY, defaultExhibitorCopy,
  exhibitorBooth, exhibitorCopyFor,
} from "../services/exhibitorPasses.js";
import { DEFAULT_MANUAL, buildExhibitorManual, cleanBooth, cleanManual, manualFileName } from "../services/exhibitorManual.js";
import { passEmailDefaults, passEmailFor, passVariant } from "../services/passEmail.js";
import { PLACEHOLDERS, SECTIONS, changedFields, cleanFields, compact, fieldsFor, mergeCopy, sameAsDefault, tierFor } from "../services/passEmailCopy.js";
import { loadTemplate, saveTemplate } from "../services/emailTemplates.js";
import { noteTrackedSend, passEmailPixel } from "../services/engagementStore.js";

/* =========================================================
   Staff-issued passes, two kinds on the same routes:
     /api/console/issued-passes     Admin → Marketing → Issue passes
     /api/console/exhibitor-passes  Admin → Marketing → Exhibitor passes
       (the same pass email, with the Exhibitor Manual PDF attached,
        filled in with their booth; promo code EXHIBITOR)
   Staff only; creating, editing, sending and deleting are management only
   and audited. Nothing is emailed without a send click.
   Event week (the organiser, Oct 19 2026): staff who aren't management may
   give a single issued pass (Admin › Give a pass): create one (POST /), then
   send it (POST /:id/send), one pass per request, STAFF_PASS_LIMIT an hour
   each, audited with their name and "(by staff)". Editing, deleting, the
   email template and exhibitor passes stay management only.

   GET    /tiers                 → { tiers: [{ key, label, access, includes, rsvpReason, copy, autoExtras }], cc, defaultTier, defaultLabel,
                                     fields, sections, placeholders, extras, marks, markTiers }   (fields: one pass's editable email wording;
                                     extras: the pass extras [{ key, label, short, auto }], autoExtras: what each pass gets on Automatic;
                                     marks: ["vip", "media"], markTiers: the pass the form picks for a mark, { vip, media, volunteer })
   GET    /                      → { rows, counts }
   POST   /preview               → { subject, html, text, includes } for an unsaved pass (same body as POST /)
   POST   /                      { name, email, tier, title?, company?, label?, rsvp?, booth?, zone?, passes?,
                                   extras?: { cxo?, lunch?, gala?, awards? } (each true | false | null = automatic),
                                   cxoBreakfast? (the same as extras.cxo),
                                   vip?, media? (true / false: mark the pass's holder VIP / Media, Attendee.vip / .media;
                                     both get the CxO Breakfasts on Automatic; Oct 20 2026),
                                   + any field of the email (services/passEmailCopy.js, one pass's level) }
                                   → 201 { row }   (a new ticket ID; not emailed)
   PATCH  /:id                   any of the fields above → { row }
   GET|POST /:id/preview         → { to, cc, subject, html, text, attachments, defaults, includes } (POST: this-send-only to / cc / wording)
                                   `includes`: the headings of the email's "Your pass includes" list
   The email template (every pass of this kind; one pass's own wording beats it), both kinds:
   GET    /email                 → { copy (saved, per pass type in copy.tiers), defaults: { <tier>: built-in }, fields, sections, … }
   PUT    /email                 every field, tiers: { <tier>: { passName, access, includes, rsvpText } } → same (management, audited)
   POST   /email/preview         { tier, ...unsaved template } → { subject, html, text, defaults, attachments } (a made-up pass)
   POST   /:id/send              { to?, cc?, subject?, headline?, message? } → { row }
   DELETE /:id                   → { deleted: true } (not once it's checked in or used in the app)
   Exhibitor passes only:
   GET    /manual                → { manual (saved or built-in), defaults, updatedBy, updatedAt }
   PUT    /manual                { manual } → same (management)
   POST   /manual/preview        { manual?, company?, booth?, zone?, passes?, name?, title?, email? } → the PDF
   GET    /:id/manual.pdf        → the PDF as it's attached to that pass's email
========================================================= */

const KINDS = {
  issued: {
    promo: ISSUED_PROMO, campaign: "issued-pass-2026", audit: "issued_pass", ccEnv: "ISSUED_PASS_CC",
    defaultTier: "influence", defaultLabel: "", manual: false, staffSingle: true,
  },
  exhibitor: {
    promo: EXHIBITOR_PROMO, campaign: "exhibitor-pass-2026", audit: "exhibitor_pass", ccEnv: "EXHIBITOR_PASS_CC",
    // No stored label: the pass is named after its tier ("Connect Pass"), never "Exhibitor Pass".
    defaultTier: EXHIBITOR_TIER, defaultLabel: "", manual: true,
  },
};

const PASS_FIELDS = "name email alsoTo ticketId ticketType promoCode details issuedPass passEmailSentAt passEmailSentTo " +
  `passEmailSentCount passEmailRsvp ${EXTRA_SELECT} vip media claimedBy checkedIn purchaseDate createdAt`;
const isId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

async function rsvpsFor(ticketIds) {
  const ids = ticketIds.filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await Rsvp.find({ ...LIVE_RSVPS, ticketId: { $in: ids.map((t) => String(t).toLowerCase()) } }).select("ticketId days options updatedAt").lean();
  return new Map(docs.map((r) => [String(r.ticketId).toLowerCase(), { at: r.updatedAt || null, days: r.days || [], options: r.options || [] }]));
}

/** The saved Exhibitor Manual wording (complete: defaults fill anything missing). */
async function savedManual() {
  const t = await EmailTemplate.findOne({ key: MANUAL_TEMPLATE_KEY }).lean();
  return { manual: cleanManual(t?.content), updatedBy: t?.updatedBy || "", updatedAt: t?.updatedAt || null, saved: !!t?.content };
}

function sendPdf(res, buf, name) {
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${name}"`);
  res.setHeader("Cache-Control", "no-store");
  res.send(buf);
}

export function issuedPassRouter(kindName = "issued") {
  const kind = KINDS[kindName];
  const router = express.Router();
  router.use(requireAdmin);

  const SCOPE = { promoCode: kind.promo };
  const staffCreates = makeLimiter(STAFF_PASS_LIMIT);
  const staffSends = makeLimiter(STAFF_PASS_LIMIT);
  /** Management, or (Give a pass only) a staff member within their hourly budget: one pass, one send at a time. */
  const managementOrSingle = (limiter) => (req, res, next) => {
    if (isManagement(req.user)) return next();
    if (!kind.staffSingle) return res.status(403).json({ error: "Management only" });
    if (!limiter.hit(String(req.user._id))) {
      return res.status(429).json({ code: "rate_limited", error: "That's a lot of passes in an hour. Ask someone in management, or try again later." });
    }
    next();
  };
  const DEFAULT_CC = () => String(process.env[kind.ccEnv] ?? process.env.ISSUED_PASS_CC ?? process.env.SPEAKER_CC ?? "lubna@thetechfestival.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const find = (id) => (isId(id) ? Attendee.findOne({ _id: id, ...SCOPE }).select(PASS_FIELDS).lean() : null);

  async function audit(req, action, ticketId = "", detail = "") {
    await AdminAudit.create({
      adminId: req.user._id, adminName: req.user.name, action: `${kind.audit}_${action}`, targetType: "ticket",
      targetId: ticketId, detail: String(detail).slice(0, 500),
    }).catch(() => {});
  }

  /** This kind's email template (EmailTemplate "issued-pass" / "exhibitor-pass"): every field staff set. */
  async function template() {
    const t = await loadTemplate(kindName);
    if (t.error) throw new Error(`Couldn't read the email wording: ${t.error}`);
    return t;
  }
  /** The built-in subject / headline / message for a pass name. */
  const builtInCopy = kind.manual ? defaultExhibitorCopy : defaultIssuedCopy;

  /** The default subject / headline / message for this kind of pass: staff's saved template over the built-in. */
  async function copyFor() {
    if (!kind.manual) {
      const { subject, headline, message } = (await template()).copy;
      return (label) => ({ ...defaultIssuedCopy(label), ...compact({ subject, headline, message }) });
    }
    const t = await EmailTemplate.findOne({ key: EXHIBITOR_TEMPLATE_KEY }).lean();
    return exhibitorCopyFor(t);
  }

  /** This send's to / cc / wording, from the body over the pass's saved settings. */
  function sendOptions(body = {}, a) {
    const copy = mergeCopy(cleanFields(body, kindName, { level: "pass" }), a?.issuedPass?.copy);
    let to;
    if (body.to !== undefined) {
      const check = validateSpeakerEmails(body.to);
      if (!check.ok || !check.list.length) return { ok: false, error: check.ok ? "Add at least one address to send to." : check.error };
      to = check.list;
    }
    let cc = DEFAULT_CC();
    if (body.cc !== undefined) {
      const check = validateSpeakerEmails(body.cc, { max: 10 });
      if (!check.ok) return { ok: false, error: `Cc: ${check.error}` };
      cc = check.list;
    }
    return { ok: true, copy, to, cc };
  }

  /**
   * The email for a pass: `copy` (this send + this pass's own wording) over the template (`tpl`: an
   * unsaved one for Edit email's preview, else the saved one) over the built-in text.
   * `defaults`: what each of this pass's fields shows when its own is empty.
   * `openPixel`: a real send's open pixel ("" = none).
   */
  async function emailFor(a, copy, inline, tpl = null, openPixel = "") {
    const t = tpl || (await template()).copy;
    const variant = passVariant(a, { copyFor: builtInCopy, template: t });
    const merged = mergeCopy(copy, t);
    const e = await passEmailFor({ ...issuedPassForEmail(a), openPixel }, { inline, copy: merged, variant });
    // The headings of the email's list (the wording staff set, else the pass's own list with its extras).
    const includes = (merged.includes?.length ? merged.includes : variant.includes).map((row) => (Array.isArray(row) ? row[0] : row));
    return { ...e, defaults: mergeCopy(t, e.defaults), includes };
  }

  /** One pass's own wording from a create / edit body (any field of the email; the pass name is `label`). */
  const withPassCopy = (value, body = {}) => {
    const extra = cleanFields(body, kindName, { level: "pass" });
    if (Object.keys(extra).length) value.copy = { ...(value.copy || {}), ...extra };
    return value;
  };
  /** After a save: wording equal to what the pass shows anyway is no edit (lists keep following the CxO rule). */
  async function tidyPassCopy(a) {
    const own = a?.issuedPass?.copy || {};
    if (!Object.keys(own).length) return a;
    const { defaults } = await emailFor(a, {}, true);
    const copy = compact(sameAsDefault(own, [defaults]));
    if (JSON.stringify(copy) === JSON.stringify(compact(own))) return a;
    return Attendee.findOneAndUpdate({ _id: a._id, ...SCOPE }, { $set: { "issuedPass.copy": copy } }, { new: true }).select(PASS_FIELDS).lean();
  }

  /** The pass extras' stored fields from a body (`extras`, `cxoBreakfast`): only the Yes / No ones. */
  const extraFieldsOf = (body = {}) => {
    const x = cleanExtras({ cxoBreakfast: body.cxoBreakfast, extras: body.extras });
    return x.ok ? Object.fromEntries(EXTRAS.filter((e) => typeof x.value[e.key] === "boolean").map((e) => [e.field, x.value[e.key]])) : {};
  };
  /** A made-up pass of one type, for Edit email's preview. */
  const samplePass = (tier, body = {}) => issuedPassDoc({
    name: "Jane Doe", emails: [], tier: ISSUE_TIERS[tier] ? tier : kind.defaultTier, title: "Chief Technology Officer", company: "Example Corp",
    rsvp: body.rsvp !== false, ...extraFieldsOf(body),
    ...(kind.manual ? { booth: { booth: "07", zone: "Zone A - Harbour Ballroom Foyer", passes: "4" } } : {}),
  }, { ticketId: "A1B2C3D4E5F6", promo: kind.promo });

  /** Edit email: the saved template, every pass type's built-in text, and the fields by section. */
  async function templatePayload() {
    const t = await template();
    // The subject, headline and message go on every pass type, so they're shown with {passName}.
    const defaults = Object.fromEntries(ISSUE_TIER_KEYS.map((key) => [key, {
      ...passEmailDefaults({ variant: passVariant(samplePass(key), { copyFor: builtInCopy }) }), ...builtInCopy("{passName}"),
    }]));
    return {
      copy: t.copy, defaults, fields: fieldsFor(kindName), sections: SECTIONS, placeholders: PLACEHOLDERS.pass,
      tiers: ISSUE_TIER_KEYS.map((key) => ({ key, label: ISSUE_TIERS[key].label })), defaultTier: kind.defaultTier,
      updatedBy: t.updatedBy, updatedAt: t.updatedAt,
    };
  }

  /** The manual PDF for a pass (exhibitors only). */
  async function manualFor(a) {
    const { manual } = await savedManual();
    const booth = exhibitorBooth(a);
    return { buf: await buildExhibitorManual(manual, booth), name: manualFileName(booth.company) };
  }

  /** New passes of this kind: the default pass and name on it when staff leave them out. */
  const withDefaults = (body = {}) => ({
    ...body,
    tier: body.tier || kind.defaultTier,
    ...(kind.defaultLabel && !String(body.label || "").trim() ? { label: kind.defaultLabel } : {}),
  });

  router.get("/tiers", async (req, res) => {
    const cf = await copyFor();
    res.json({
      tiers: ISSUE_TIER_KEYS.map((key) => ({ key, ...ISSUE_TIERS[key], copy: cf(kind.defaultLabel || ISSUE_TIERS[key].label), autoExtras: autoExtras(key) })),
      extras: extrasMeta(),
      // Mark as VIP / Media (saved on the pass) and the pass the form picks for each mark (Volunteer: Connect).
      marks: PASS_MARKS, markTiers: MARK_TIERS,
      cc: DEFAULT_CC(),
      defaultTier: kind.defaultTier,
      defaultLabel: kind.defaultLabel,
      fields: fieldsFor(kindName, { level: "pass" }), sections: SECTIONS, placeholders: PLACEHOLDERS.pass,
    });
  });

  router.get("/email", async (req, res) => {
    res.json(await templatePayload());
  });
  // Body: every field of the email (left out or "" = built-in), tiers: { <tier>: { passName, access, includes, rsvpText } }.
  // Saves the whole template. Management; audited with the fields that changed.
  router.put("/email", requireManagement, async (req, res) => {
    const { defaults } = await templatePayload();
    const named = ISSUE_TIER_KEYS.map((key) => builtInCopy(ISSUE_TIERS[key].label)); // the same wording with the name written in
    const clean = sameAsDefault(cleanFields(req.body || {}, kindName, { tiers: true }), [...Object.values(defaults), ...named], { tierDefaults: defaults });
    const { changed } = await saveTemplate(kindName, clean, { by: String(req.user?.name || req.user?.email || "") });
    await audit(req, "email_template", "", changed.length ? `wording: ${changed.join(", ")}` : "wording unchanged");
    res.json(await templatePayload());
  });
  // Edit email's preview: a made-up pass of `tier` with the unsaved template. Body: { tier, extras?, cxoBreakfast?, rsvp?, ...fields, tiers }.
  router.post("/email/preview", async (req, res) => {
    const body = req.body || {};
    const tier = tierFor(body.tier) || kind.defaultTier;
    const fake = samplePass(tier, body);
    const { subject, html, text, defaults } = await emailFor(fake, {}, true, compact(cleanFields(body, kindName, { tiers: true })));
    res.json({ subject, html, text, defaults, attachments: kind.manual ? [{ filename: manualFileName(fake.details?.organisation) }] : [] });
  });

  router.get("/", async (req, res) => {
    const docs = await Attendee.find(SCOPE).select(PASS_FIELDS).sort({ createdAt: -1 }).lean();
    const rsvps = await rsvpsFor(docs.map((d) => d.ticketId));
    const rows = docs.map((d) => ({ ...issuedPassRow(d), rsvpd: rsvps.get(String(d.ticketId).toLowerCase()) || null }));
    res.json({
      rows,
      counts: { passes: rows.length, sent: rows.filter((r) => r.status === "sent").length, ready: rows.filter((r) => r.status === "ready").length, rsvpd: rows.filter((r) => r.rsvpd).length },
      // May this person create and send a pass here (management; staff on Give a pass, one at a time)?
      canIssue: isManagement(req.user) || !!kind.staffSingle,
    });
  });

  if (kind.manual) {
    router.get("/manual", async (req, res) => {
      res.json({ ...(await savedManual()), defaults: DEFAULT_MANUAL });
    });
    router.put("/manual", requireManagement, async (req, res) => {
      const manual = cleanManual(req.body?.manual);
      const by = String(req.user?.name || req.user?.email || "");
      await EmailTemplate.findOneAndUpdate({ key: MANUAL_TEMPLATE_KEY }, { $set: { content: manual, updatedBy: by } }, { upsert: true, new: true });
      await audit(req, "manual_edit", "", "Exhibitor Manual wording saved");
      res.json({ ...(await savedManual()), defaults: DEFAULT_MANUAL });
    });
    router.post("/manual/preview", async (req, res) => {
      const b = req.body || {};
      const manual = b.manual ? cleanManual(b.manual) : (await savedManual()).manual;
      const booth = cleanBooth({ company: b.company, booth: b.booth, zone: b.zone, passes: b.passes, holder: { name: b.name, title: b.title, email: b.email } });
      sendPdf(res, await buildExhibitorManual(manual, booth), manualFileName(booth.company));
    });
  }

  // Preview of a pass that isn't saved yet (the "Issue a pass" form).
  router.post("/preview", async (req, res) => {
    const check = validateIssuedPass(withDefaults({ name: "Jane Doe", email: "", ...req.body }), { partial: false });
    if (!check.ok) return res.status(400).json({ error: check.error });
    const fake = issuedPassDoc({ ...withPassCopy(check.value, req.body), emails: [] }, { ticketId: "A1B2C3D4E5F6", promo: kind.promo });
    const { subject, html, text, defaults, includes } = await emailFor(fake, fake.issuedPass.copy, true);
    res.json({
      to: check.value.emails.join(", "), cc: DEFAULT_CC(), subject, html, text, defaults, includes,
      attachments: kind.manual ? [{ filename: manualFileName(fake.details?.organisation) }] : [],
    });
  });

  router.post("/", managementOrSingle(staffCreates), async (req, res) => {
    const check = validateIssuedPass(withDefaults(req.body || {}));
    if (!check.ok) return res.status(400).json({ error: check.error });
    if (!check.value.emails.length) return res.status(400).json({ error: "Enter the email address the pass is for." });
    const by = String(req.user?.name || req.user?.email || "");
    let doc;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        doc = await Attendee.create(issuedPassDoc(withPassCopy(check.value, req.body), { by, promo: kind.promo }));
        break;
      } catch (err) {
        if (err?.code !== 11000 || attempt === 2) throw err; // a ticket ID clash (1 in 2^48): try another
      }
    }
    // The pass extras set to Yes or No on the new pass, e.g. ", CxO Breakfast Yes, Gala Dinner & Networking Reception Yes".
    const extrasNote = EXTRAS.filter((e) => typeof check.value[e.field] === "boolean")
      .map((e) => `, ${e.key === "cxo" ? "CxO Breakfast" : e.label} ${check.value[e.field] ? "Yes" : "No"}`).join("")
      + PASS_MARKS.filter((k) => check.value[k] === true).map((k) => `, ${k === "vip" ? "VIP" : "Media"} Yes`).join("");
    if (PASS_MARKS.some((k) => check.value[k] === true)) clearExhibitorCache(); // the apps see the mark within the minute
    const wording = Object.keys(compact(check.value.copy || {}));
    await audit(req, "create", doc.ticketId, `${check.value.tier} pass for ${check.value.name} <${check.value.emails.join(", ")}>${extrasNote}${wording.length ? `; wording: ${wording.join(", ")}` : ""}${staffNote(isManagement(req.user))}`);
    res.status(201).json({ row: issuedPassRow(await tidyPassCopy(doc.toObject())) });
  });

  router.patch("/:id", requireManagement, async (req, res) => {
    const before = await find(req.params.id);
    if (!before) return res.status(404).json({ error: "Pass not found" });
    const check = validateIssuedPass(req.body || {}, { partial: true });
    if (!check.ok) return res.status(400).json({ error: check.error });
    const set = issuedPassUpdate(withPassCopy(check.value, req.body), before);
    // The pass extras: a switch set to what it already is is no change; null (automatic) takes staff's value off the pass.
    const extraChanges = [];
    const unset = {};
    for (const e of EXTRAS) {
      if (!(e.field in set)) continue;
      const was = typeof before[e.field] === "boolean" ? before[e.field] : null;
      if ((set[e.field] ?? null) === was) { delete set[e.field]; continue; }
      extraChanges.push(e);
      if (set[e.field] === null) { delete set[e.field]; unset[e.field] = ""; }
    }
    // VIP / Media on the pass: true sets it, null takes it off; the same as before is no change.
    const markChanges = [];
    for (const k of PASS_MARKS) {
      if (!(k in set)) continue;
      if ((set[k] === true) === (before[k] === true)) { delete set[k]; continue; }
      markChanges.push(`${k === "vip" ? "VIP" : "Media"} ${before[k] === true ? "Yes" : "No"} → ${set[k] === true ? "Yes" : "No"}`);
      if (set[k] === null) { delete set[k]; unset[k] = ""; }
    }
    if (!Object.keys(set).length && !Object.keys(unset).length) return res.json({ row: issuedPassRow(before) });
    const a = await Attendee.findOneAndUpdate({ _id: before._id, ...SCOPE }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(Object.keys(unset).length ? { $unset: unset } : {}) }, { new: true }).select(PASS_FIELDS).lean();
    if (extraChanges.length && a.claimedBy) {
      // Claimed by an account: its copy of the ticket says the same (the account's switch wins when they disagree).
      const ids = [...new Set([a.ticketId, normalizeTicketId(a.ticketId), normalizeTicketId(a.ticketId).toUpperCase()])];
      const sub = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [`tickets.$.${k}`, v]));
      const uSet = Object.fromEntries(extraChanges.filter((e) => e.field in set).map((e) => [e.field, set[e.field]]));
      const uUnset = Object.fromEntries(extraChanges.filter((e) => e.field in unset).map((e) => [e.field, ""]));
      await User.updateOne({ _id: a.claimedBy, "tickets.ticketId": { $in: ids } },
        { ...(Object.keys(uSet).length ? { $set: sub(uSet) } : {}), ...(Object.keys(uUnset).length ? { $unset: sub(uUnset) } : {}) }).catch(() => {});
    }
    const wording = set["issuedPass.copy"] ? changedFields(before.issuedPass?.copy, set["issuedPass.copy"]) : [];
    const rowBefore = issuedPassRow(before).extras;
    const rowAfter = issuedPassRow(a).extras;
    if (markChanges.length) clearExhibitorCache();
    const fields = [...Object.keys(set).filter((k) => !EXTRAS.some((e) => e.field === k) && !PASS_MARKS.includes(k) && k !== "issuedPass.copy"),
      ...extraChanges.map((e) => `${e.key === "cxo" ? "CxO Breakfast" : e.label} ${extraLabel(rowBefore[e.key].override ?? undefined, rowBefore[e.key].included)} → ${extraLabel(rowAfter[e.key].override ?? undefined, rowAfter[e.key].included)}`),
      ...markChanges,
      ...(wording.length ? [`wording: ${wording.join(", ")}`] : [])];
    await audit(req, "edit", a.ticketId, `${a.name}: ${fields.join(", ") || "no changes"}`);
    res.json({ row: issuedPassRow(await tidyPassCopy(a)) });
  });

  async function passPreview(req, res) {
    const a = await find(req.params.id);
    if (!a) return res.status(404).json({ error: "Pass not found" });
    const opts = sendOptions(req.method === "POST" ? req.body || {} : {}, a);
    if (!opts.ok) return res.status(400).json({ error: opts.error });
    const to = opts.to || passRecipients(a);
    const { subject, html, text, defaults, includes } = await emailFor(a, opts.copy, true);
    res.json({
      to: to.join(", "), toList: to, cc: opts.cc.filter((e) => !to.includes(e)), subject, html, text, defaults, includes,
      attachments: kind.manual ? [{ filename: manualFileName(exhibitorBooth(a).company) }] : [],
    });
  }
  router.get("/:id/preview", passPreview);
  router.post("/:id/preview", passPreview);

  if (kind.manual) {
    router.get("/:id/manual.pdf", async (req, res) => {
      const a = await find(req.params.id);
      if (!a) return res.status(404).json({ error: "Pass not found" });
      const { buf, name } = await manualFor(a);
      sendPdf(res, buf, name);
    });
  }

  router.post("/:id/send", managementOrSingle(staffSends), async (req, res) => {
    const a = await find(req.params.id);
    if (!a) return res.status(404).json({ error: "Pass not found" });
    const opts = sendOptions(req.body || {}, a);
    if (!opts.ok) return res.status(400).json({ error: opts.error });
    const to = opts.to || passRecipients(a);
    if (!to.length) return res.status(400).json({ error: "Add an email address first." });
    const cc = opts.cc.filter((e) => !to.includes(e));
    // The open pixel (People › RSVP email opened): only with the RSVP button and no cc (a cc'd copy would count as their open).
    const track = passEmailPixel({ campaign: kind.campaign, email: a.email || to[0], ticketId: a.ticketId, cc, rsvp: issuedVariant(a).rsvp !== false });
    try {
      const { subject, html, text, attachments } = await emailFor(a, opts.copy, false, null, track.pixel);
      if (kind.manual) {
        const { buf, name } = await manualFor(a);
        attachments.push({ filename: name, content: buf.toString("base64"), content_type: "application/pdf" });
      }
      const { data, error } = await resend().emails.send({
        from: FROM, to, ...(cc.length ? { cc } : {}), reply_to: CONTACT_EMAIL, subject, html, text, attachments,
        tags: [{ name: "campaign", value: kind.campaign }],
      });
      if (error || !data?.id) throw new Error(error?.message || "the email service refused it");
      if (track.key) noteTrackedSend(track.key);
    } catch (err) {
      await audit(req, "send_failed", a.ticketId, `${a.name} → ${to.join(", ")}${staffNote(isManagement(req.user))}: ${err?.message || err}`);
      return res.status(502).json({ error: `Couldn't send: ${err?.message || err}` });
    }
    // passEmailRsvp: whether this email had the RSVP button (People › "RSVP email sent").
    const updated = await Attendee.findOneAndUpdate({ _id: a._id, ...SCOPE },
      { $set: { passEmailSentAt: new Date(), passEmailSentTo: to.join(", "), passEmailRsvp: issuedVariant(a).rsvp }, $inc: { passEmailSentCount: 1 } },
      { new: true }).select(PASS_FIELDS).lean();
    await audit(req, "send", a.ticketId, `${a.name} → ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}${staffNote(isManagement(req.user))}`);
    res.json({ row: issuedPassRow(updated) });
  });

  router.delete("/:id", requireManagement, async (req, res) => {
    const a = await find(req.params.id);
    if (!a) return res.status(404).json({ error: "Pass not found" });
    if (a.checkedIn || a.claimedBy) return res.status(409).json({ error: "This pass has been checked in or used in the app, so it can't be deleted." });
    await Attendee.deleteOne({ _id: a._id, ...SCOPE });
    await audit(req, "delete", a.ticketId, `${a.name} <${passRecipients(a).join(", ")}>`);
    res.json({ deleted: true });
  });

  return router;
}

export default issuedPassRouter("issued");
