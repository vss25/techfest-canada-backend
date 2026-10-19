import express from "express";
import { Resend } from "resend";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { CONTACT_EMAIL, FROM, cleanCopy, speakerPassEmailFor } from "../services/speakerPassEmail.js";
import { passRecipients, validateSpeakerEmails } from "../services/speakerPasses.js";
import { LIVE_RSVPS } from "../services/rsvp.js";
import { cxoLabel } from "../services/cxoBreakfast.js";
import {
  ISSUED_PROMO, ISSUE_TIERS, ISSUE_TIER_KEYS, defaultIssuedCopy, issuedPassDoc, issuedPassForEmail, issuedPassRow,
  issuedPassUpdate, issuedVariant, validateIssuedPass,
} from "../services/issuedPasses.js";
import {
  EXHIBITOR_PROMO, EXHIBITOR_TEMPLATE_KEY, EXHIBITOR_TIER, MANUAL_TEMPLATE_KEY, defaultExhibitorCopy,
  exhibitorBooth, exhibitorCopyFor,
} from "../services/exhibitorPasses.js";
import { DEFAULT_MANUAL, buildExhibitorManual, cleanBooth, cleanManual, manualFileName } from "../services/exhibitorManual.js";

/* =========================================================
   Staff-issued passes, two kinds on the same routes:
     /api/console/issued-passes     Admin → Marketing → Issue passes
     /api/console/exhibitor-passes  Admin → Marketing → Exhibitor passes
       (the same pass email, with the Exhibitor Manual PDF attached,
        filled in with their booth; promo code EXHIBITOR)
   Staff only; creating, editing, sending and deleting are management only
   and audited. Nothing is emailed without a send click.

   GET    /tiers                 → { tiers: [{ key, label, access, includes, rsvpReason, copy }], cc, defaultTier, defaultLabel }
   GET    /                      → { rows, counts }
   POST   /preview               → { subject, html, text } for an unsaved pass (same body as POST /)
   POST   /                      { name, email, tier, title?, company?, label?, rsvp?, subject?, headline?, message?,
                                   booth?, zone?, passes? } → 201 { row }   (a new ticket ID; not emailed)
   PATCH  /:id                   any of the fields above → { row }
   GET|POST /:id/preview         → { to, cc, subject, html, text, attachments } (POST: this-send-only to / cc / wording)
   POST   /:id/send              { to?, cc?, subject?, headline?, message? } → { row }
   DELETE /:id                   → { deleted: true } (not once it's checked in or used in the app)
   Exhibitor passes only:
   GET    /email                 → { copy (saved), defaults }          the default wording for every exhibitor pass
   PUT    /email                 { subject, headline, message } → same (management; empty = built-in)
   GET    /manual                → { manual (saved or built-in), defaults, updatedBy, updatedAt }
   PUT    /manual                { manual } → same (management)
   POST   /manual/preview        { manual?, company?, booth?, zone?, passes?, name?, title?, email? } → the PDF
   GET    /:id/manual.pdf        → the PDF as it's attached to that pass's email
========================================================= */

const KINDS = {
  issued: {
    promo: ISSUED_PROMO, campaign: "issued-pass-2026", audit: "issued_pass", ccEnv: "ISSUED_PASS_CC",
    defaultTier: "influence", defaultLabel: "", manual: false,
  },
  exhibitor: {
    promo: EXHIBITOR_PROMO, campaign: "exhibitor-pass-2026", audit: "exhibitor_pass", ccEnv: "EXHIBITOR_PASS_CC",
    // No stored label: the pass is named after its tier ("Connect Pass"), never "Exhibitor Pass".
    defaultTier: EXHIBITOR_TIER, defaultLabel: "", manual: true,
  },
};

const PASS_FIELDS = "name email alsoTo ticketId ticketType promoCode details issuedPass passEmailSentAt passEmailSentTo " +
  "passEmailSentCount passEmailRsvp cxoBreakfast claimedBy checkedIn purchaseDate createdAt";
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
  const DEFAULT_CC = () => String(process.env[kind.ccEnv] ?? process.env.ISSUED_PASS_CC ?? process.env.SPEAKER_CC ?? "lubna@thetechfestival.com")
    .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  const find = (id) => (isId(id) ? Attendee.findOne({ _id: id, ...SCOPE }).select(PASS_FIELDS).lean() : null);

  async function audit(req, action, ticketId = "", detail = "") {
    await AdminAudit.create({
      adminId: req.user._id, adminName: req.user.name, action: `${kind.audit}_${action}`, targetType: "ticket",
      targetId: ticketId, detail: String(detail).slice(0, 500),
    }).catch(() => {});
  }

  /** The default wording for this kind of pass (exhibitors: staff's saved email wording over the built-in). */
  async function copyFor() {
    if (!kind.manual) return defaultIssuedCopy;
    const t = await EmailTemplate.findOne({ key: EXHIBITOR_TEMPLATE_KEY }).lean();
    return exhibitorCopyFor(t);
  }

  /** This send's to / cc / wording, from the body over the pass's saved settings. */
  function sendOptions(body = {}, a) {
    const copy = { ...(a?.issuedPass?.copy || {}), ...validateIssuedPass(body, { partial: true }).value?.copy };
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

  async function emailFor(a, copy, inline) {
    const variant = issuedVariant(a, { copyFor: await copyFor() });
    return speakerPassEmailFor(issuedPassForEmail(a), { inline, copy, variant });
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
      tiers: ISSUE_TIER_KEYS.map((key) => ({ key, ...ISSUE_TIERS[key], copy: cf(kind.defaultLabel || ISSUE_TIERS[key].label) })),
      cc: DEFAULT_CC(),
      defaultTier: kind.defaultTier,
      defaultLabel: kind.defaultLabel,
    });
  });

  router.get("/", async (req, res) => {
    const docs = await Attendee.find(SCOPE).select(PASS_FIELDS).sort({ createdAt: -1 }).lean();
    const rsvps = await rsvpsFor(docs.map((d) => d.ticketId));
    const rows = docs.map((d) => ({ ...issuedPassRow(d), rsvpd: rsvps.get(String(d.ticketId).toLowerCase()) || null }));
    res.json({
      rows,
      counts: { passes: rows.length, sent: rows.filter((r) => r.status === "sent").length, ready: rows.filter((r) => r.status === "ready").length, rsvpd: rows.filter((r) => r.rsvpd).length },
    });
  });

  if (kind.manual) {
    router.get("/email", async (req, res) => {
      const t = await EmailTemplate.findOne({ key: EXHIBITOR_TEMPLATE_KEY }).lean();
      res.json({ copy: { subject: t?.subject || "", headline: t?.headline || "", message: t?.message || "" }, defaults: defaultExhibitorCopy(),
        updatedBy: t?.updatedBy || "", updatedAt: t?.updatedAt || null });
    });
    router.put("/email", requireManagement, async (req, res) => {
      const c = cleanCopy(req.body || {});
      const set = { subject: c.subject || "", headline: c.headline || "", message: c.message || "", updatedBy: String(req.user?.name || req.user?.email || "") };
      const t = await EmailTemplate.findOneAndUpdate({ key: EXHIBITOR_TEMPLATE_KEY }, { $set: set }, { upsert: true, new: true }).lean();
      await audit(req, "email_template", "", ["subject", "headline", "message"].filter((k) => set[k]).join(", ") || "reset to built-in");
      res.json({ copy: { subject: t.subject, headline: t.headline, message: t.message }, defaults: defaultExhibitorCopy(), updatedBy: t.updatedBy, updatedAt: t.updatedAt });
    });
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
    const fake = issuedPassDoc({ ...check.value, emails: [] }, { ticketId: "A1B2C3D4E5F6", promo: kind.promo });
    const { subject, html, text } = await emailFor(fake, fake.issuedPass.copy, true);
    res.json({
      to: check.value.emails.join(", "), cc: DEFAULT_CC(), subject, html, text,
      attachments: kind.manual ? [{ filename: manualFileName(fake.details?.organisation) }] : [],
    });
  });

  router.post("/", requireManagement, async (req, res) => {
    const check = validateIssuedPass(withDefaults(req.body || {}));
    if (!check.ok) return res.status(400).json({ error: check.error });
    if (!check.value.emails.length) return res.status(400).json({ error: "Enter the email address the pass is for." });
    const by = String(req.user?.name || req.user?.email || "");
    let doc;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        doc = await Attendee.create(issuedPassDoc(check.value, { by, promo: kind.promo }));
        break;
      } catch (err) {
        if (err?.code !== 11000 || attempt === 2) throw err; // a ticket ID clash (1 in 2^48): try another
      }
    }
    const cxoNote = typeof check.value.cxoBreakfast === "boolean" ? `, CxO Breakfast ${check.value.cxoBreakfast ? "Yes" : "No"}` : "";
    await audit(req, "create", doc.ticketId, `${check.value.tier} pass for ${check.value.name} <${check.value.emails.join(", ")}>${cxoNote}`);
    res.status(201).json({ row: issuedPassRow(doc.toObject()) });
  });

  router.patch("/:id", requireManagement, async (req, res) => {
    const before = await find(req.params.id);
    if (!before) return res.status(404).json({ error: "Pass not found" });
    const check = validateIssuedPass(req.body || {}, { partial: true });
    if (!check.ok) return res.status(400).json({ error: check.error });
    const set = issuedPassUpdate(check.value, before);
    const cxoSame = "cxoBreakfast" in set && (set.cxoBreakfast ?? null) === (typeof before.cxoBreakfast === "boolean" ? before.cxoBreakfast : null);
    if (cxoSame) { delete set.cxoBreakfast; delete check.value.cxoBreakfast; }
    if (!Object.keys(set).length) return res.json({ row: issuedPassRow(before) });
    // "CxO Breakfast included" back to automatic: take staff's value off the pass.
    const unset = set.cxoBreakfast === null ? { cxoBreakfast: "" } : null;
    if (unset) delete set.cxoBreakfast;
    const a = await Attendee.findOneAndUpdate({ _id: before._id, ...SCOPE }, { ...(Object.keys(set).length ? { $set: set } : {}), ...(unset ? { $unset: unset } : {}) }, { new: true }).select(PASS_FIELDS).lean();
    const fields = [...Object.keys(set).filter((k) => k !== "cxoBreakfast"), ...("cxoBreakfast" in check.value
      ? [`CxO Breakfast ${cxoLabel(before.cxoBreakfast, issuedPassRow(before).cxoEffective)} → ${cxoLabel(a.cxoBreakfast, issuedPassRow(a).cxoEffective)}`] : [])];
    await audit(req, "edit", a.ticketId, `${a.name}: ${fields.join(", ")}`);
    res.json({ row: issuedPassRow(a) });
  });

  async function passPreview(req, res) {
    const a = await find(req.params.id);
    if (!a) return res.status(404).json({ error: "Pass not found" });
    const opts = sendOptions(req.method === "POST" ? req.body || {} : {}, a);
    if (!opts.ok) return res.status(400).json({ error: opts.error });
    const to = opts.to || passRecipients(a);
    const { subject, html, text } = await emailFor(a, opts.copy, true);
    res.json({
      to: to.join(", "), toList: to, cc: opts.cc.filter((e) => !to.includes(e)), subject, html, text,
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

  router.post("/:id/send", requireManagement, async (req, res) => {
    const a = await find(req.params.id);
    if (!a) return res.status(404).json({ error: "Pass not found" });
    const opts = sendOptions(req.body || {}, a);
    if (!opts.ok) return res.status(400).json({ error: opts.error });
    const to = opts.to || passRecipients(a);
    if (!to.length) return res.status(400).json({ error: "Add an email address first." });
    const cc = opts.cc.filter((e) => !to.includes(e));
    try {
      const { subject, html, text, attachments } = await emailFor(a, opts.copy, false);
      if (kind.manual) {
        const { buf, name } = await manualFor(a);
        attachments.push({ filename: name, content: buf.toString("base64"), content_type: "application/pdf" });
      }
      const { data, error } = await resend().emails.send({
        from: FROM, to, ...(cc.length ? { cc } : {}), reply_to: CONTACT_EMAIL, subject, html, text, attachments,
        tags: [{ name: "campaign", value: kind.campaign }],
      });
      if (error || !data?.id) throw new Error(error?.message || "the email service refused it");
    } catch (err) {
      await audit(req, "send_failed", a.ticketId, `${a.name} → ${to.join(", ")}: ${err?.message || err}`);
      return res.status(502).json({ error: `Couldn't send: ${err?.message || err}` });
    }
    // passEmailRsvp: whether this email had the RSVP button (People › "RSVP email sent").
    const updated = await Attendee.findOneAndUpdate({ _id: a._id, ...SCOPE },
      { $set: { passEmailSentAt: new Date(), passEmailSentTo: to.join(", "), passEmailRsvp: issuedVariant(a).rsvp }, $inc: { passEmailSentCount: 1 } },
      { new: true }).select(PASS_FIELDS).lean();
    await audit(req, "send", a.ticketId, `${a.name} → ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`);
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
