import express from "express";
import { Resend } from "resend";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { CONTACT_EMAIL, FROM, speakerPassEmailFor } from "../services/speakerPassEmail.js";
import { passRecipients, validateSpeakerEmails } from "../services/speakerPasses.js";
import { LIVE_RSVPS } from "../services/rsvp.js";
import {
  ISSUED_PROMO, ISSUE_TIERS, ISSUE_TIER_KEYS, defaultIssuedCopy, issuedPassDoc, issuedPassForEmail, issuedPassRow,
  issuedPassUpdate, issuedVariant, validateIssuedPass,
} from "../services/issuedPasses.js";

/* =========================================================
   /api/console/issued-passes: Admin → Tickets & attendees → Issue passes.
   Staff only; creating, editing, sending and deleting are management only
   and audited. Nothing is emailed without a send click.

   GET    /tiers                 → { tiers: [{ key, label, access, includes, rsvpReason, copy }], cc }
   GET    /                      → { rows, counts }
   POST   /preview               → { subject, html, text } for an unsaved pass (same body as POST /)
   POST   /                      { name, email, tier, title?, company?, label?, rsvp?, subject?, headline?, message? }
                                 → 201 { row }   (a new ticket ID; not emailed)
   PATCH  /:id                   any of the fields above → { row }
   GET|POST /:id/preview         → { to, cc, subject, html, text } (POST: this-send-only to / cc / wording)
   POST   /:id/send              { to?, cc?, subject?, headline?, message? } → { row }
   DELETE /:id                   → { deleted: true } (not once it's checked in or used in the app)
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const PASS_FIELDS = "name email alsoTo ticketId ticketType promoCode details issuedPass passEmailSentAt passEmailSentTo " +
  "passEmailSentCount claimedBy checkedIn purchaseDate createdAt";
const SCOPE = { promoCode: ISSUED_PROMO };
const DEFAULT_CC = () => String(process.env.ISSUED_PASS_CC ?? process.env.SPEAKER_CC ?? "lubna@thetechfestival.com")
  .split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
const isId = (id) => /^[a-f0-9]{24}$/i.test(String(id || ""));
const find = (id) => (isId(id) ? Attendee.findOne({ _id: id, ...SCOPE }).select(PASS_FIELDS).lean() : null);

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));

async function audit(req, action, ticketId = "", detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "ticket",
    targetId: ticketId, detail: String(detail).slice(0, 500),
  }).catch(() => {});
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

const emailFor = (a, copy, inline) => speakerPassEmailFor(issuedPassForEmail(a), { inline, copy, variant: issuedVariant(a) });

async function rsvpsFor(ticketIds) {
  const ids = ticketIds.filter(Boolean);
  if (!ids.length) return new Map();
  const docs = await Rsvp.find({ ...LIVE_RSVPS, ticketId: { $in: ids.map((t) => String(t).toLowerCase()) } }).select("ticketId days options updatedAt").lean();
  return new Map(docs.map((r) => [String(r.ticketId).toLowerCase(), { at: r.updatedAt || null, days: r.days || [], options: r.options || [] }]));
}

router.get("/tiers", (req, res) => {
  res.json({
    tiers: ISSUE_TIER_KEYS.map((key) => ({ key, ...ISSUE_TIERS[key], copy: defaultIssuedCopy(ISSUE_TIERS[key].label) })),
    cc: DEFAULT_CC(),
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

// Preview of a pass that isn't saved yet (the "Issue a pass" form).
router.post("/preview", async (req, res) => {
  const check = validateIssuedPass({ name: "Jane Doe", email: "", tier: "influence", ...req.body }, { partial: false });
  if (!check.ok) return res.status(400).json({ error: check.error });
  const fake = issuedPassDoc({ ...check.value, emails: [] }, { ticketId: "A1B2C3D4E5F6" });
  const { subject, html, text } = await emailFor(fake, fake.issuedPass.copy, true);
  res.json({ to: check.value.emails.join(", "), cc: DEFAULT_CC(), subject, html, text });
});

router.post("/", requireManagement, async (req, res) => {
  const check = validateIssuedPass(req.body || {});
  if (!check.ok) return res.status(400).json({ error: check.error });
  if (!check.value.emails.length) return res.status(400).json({ error: "Enter the email address the pass is for." });
  const by = String(req.user?.name || req.user?.email || "");
  let doc;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      doc = await Attendee.create(issuedPassDoc(check.value, { by }));
      break;
    } catch (err) {
      if (err?.code !== 11000 || attempt === 2) throw err; // a ticket ID clash (1 in 2^48): try another
    }
  }
  await audit(req, "issued_pass_create", doc.ticketId, `${check.value.tier} pass for ${check.value.name} <${check.value.emails.join(", ")}>`);
  res.status(201).json({ row: issuedPassRow(doc.toObject()) });
});

router.patch("/:id", requireManagement, async (req, res) => {
  const before = await find(req.params.id);
  if (!before) return res.status(404).json({ error: "Pass not found" });
  const check = validateIssuedPass(req.body || {}, { partial: true });
  if (!check.ok) return res.status(400).json({ error: check.error });
  const set = issuedPassUpdate(check.value, before);
  if (!Object.keys(set).length) return res.json({ row: issuedPassRow(before) });
  const a = await Attendee.findOneAndUpdate({ _id: before._id, ...SCOPE }, { $set: set }, { new: true }).select(PASS_FIELDS).lean();
  await audit(req, "issued_pass_edit", a.ticketId, `${a.name}: ${Object.keys(set).join(", ")}`);
  res.json({ row: issuedPassRow(a) });
});

async function passPreview(req, res) {
  const a = await find(req.params.id);
  if (!a) return res.status(404).json({ error: "Pass not found" });
  const opts = sendOptions(req.method === "POST" ? req.body || {} : {}, a);
  if (!opts.ok) return res.status(400).json({ error: opts.error });
  const to = opts.to || passRecipients(a);
  const { subject, html, text } = await emailFor(a, opts.copy, true);
  res.json({ to: to.join(", "), toList: to, cc: opts.cc.filter((e) => !to.includes(e)), subject, html, text });
}
router.get("/:id/preview", passPreview);
router.post("/:id/preview", passPreview);

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
    const { data, error } = await resend().emails.send({
      from: FROM, to, ...(cc.length ? { cc } : {}), reply_to: CONTACT_EMAIL, subject, html, text, attachments,
      tags: [{ name: "campaign", value: "issued-pass-2026" }],
    });
    if (error || !data?.id) throw new Error(error?.message || "the email service refused it");
  } catch (err) {
    await audit(req, "issued_pass_send_failed", a.ticketId, `${a.name} → ${to.join(", ")}: ${err?.message || err}`);
    return res.status(502).json({ error: `Couldn't send: ${err?.message || err}` });
  }
  const updated = await Attendee.findOneAndUpdate({ _id: a._id, ...SCOPE },
    { $set: { passEmailSentAt: new Date(), passEmailSentTo: to.join(", ") }, $inc: { passEmailSentCount: 1 } },
    { new: true }).select(PASS_FIELDS).lean();
  await audit(req, "issued_pass_send", a.ticketId, `${a.name} → ${to.join(", ")}${cc.length ? ` (cc ${cc.join(", ")})` : ""}`);
  res.json({ row: issuedPassRow(updated) });
});

router.delete("/:id", requireManagement, async (req, res) => {
  const a = await find(req.params.id);
  if (!a) return res.status(404).json({ error: "Pass not found" });
  if (a.checkedIn || a.claimedBy) return res.status(409).json({ error: "This pass has been checked in or used in the app, so it can't be deleted." });
  await Attendee.deleteOne({ _id: a._id, ...SCOPE });
  await audit(req, "issued_pass_delete", a.ticketId, `${a.name} <${passRecipients(a).join(", ")}>`);
  res.json({ deleted: true });
});

export default router;
