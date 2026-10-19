import express from "express";
import QRCode from "qrcode";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { buildTicketEmail, purchaseEmailDefaults } from "../services/ticketEmail.js";
import { logoPng } from "../services/speakerPassEmail.js";
import { displayPassName } from "../services/ticketInfo.js";
import { PLACEHOLDERS, SECTIONS, cleanFields, compact, fieldsFor, sameAsDefault, tierFor } from "../services/passEmailCopy.js";
import { loadTemplate, saveTemplate } from "../services/emailTemplates.js";

/* =========================================================
   /api/console/purchase-email — the website purchase confirmation's wording
   ---------------------------------------------------------
   Admin › Tickets & attendees › Purchase email. Every piece of text in the
   email sendTicketEmail sends after a Stripe checkout (services/ticketEmail.js),
   kept in the "purchase-email" EmailTemplate (services/passEmailCopy.js): one
   value per field, and per pass type for the pass name, tagline, paragraph,
   what's included and the tips. Staff can look and preview; saving is
   management only and audited. Nothing here sends an email.

   GET  /          → { copy (saved, per pass type in copy.tiers), defaults: { <tier>: built-in }, fields, sections,
                       placeholders, tiers: [{ key, label }], updatedBy, updatedAt }
   PUT  /          every field + tiers: { <tier>: { passName, tagline, blurb, includes, tips } } → same (management)
   POST /preview   { tier ("connect" | … | "booth"), cxoBreakfast?, extras?, ...unsaved template } → { subject, html, text, defaults }
                   (a made-up buyer, Jane Doe; the real builder)
========================================================= */

const router = express.Router();
router.use(requireAdmin);

export const PURCHASE_TIERS = Object.freeze(["connect", "influence", "power", "apex"]);
const SAMPLE = Object.freeze({ name: "Jane Doe", firstName: "Jane", ticketId: "A1B2C3D4E5F6" });
const BOOTH_SAMPLE = Object.freeze({ tier: "booth-gold", ticketId: "BOOTH-GOLD" });

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "email", targetId: "purchase-email", detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

async function payload() {
  const t = await loadTemplate("purchase");
  if (t.error) throw new Error(`Couldn't read the purchase email wording: ${t.error}`);
  return {
    copy: t.copy,
    defaults: Object.fromEntries(PURCHASE_TIERS.map((tier) => [tier, purchaseEmailDefaults({ tier })])),
    fields: fieldsFor("purchase"), sections: SECTIONS, placeholders: PLACEHOLDERS.purchase,
    tiers: PURCHASE_TIERS.map((key) => ({ key, label: displayPassName(key) })),
    updatedBy: t.updatedBy, updatedAt: t.updatedAt,
  };
}

router.get("/", async (req, res) => {
  res.json(await payload());
});

// Saves the whole template (a field left out or "" = the built-in text). Management; audited with what changed.
router.put("/", requireManagement, async (req, res) => {
  const tierDefaults = Object.fromEntries(PURCHASE_TIERS.map((tier) => [tier, purchaseEmailDefaults({ tier })]));
  const generic = [...Object.values(tierDefaults), purchaseEmailDefaults({ named: false }), purchaseEmailDefaults({ wallet: false })];
  const clean = sameAsDefault(cleanFields(req.body || {}, "purchase", { tiers: true }), generic, { tierDefaults });
  const { changed } = await saveTemplate("purchase", clean, { by: String(req.user?.name || req.user?.email || "") });
  await audit(req, "purchase_email_template", changed.length ? `wording: ${changed.join(", ")}` : "wording unchanged");
  res.json(await payload());
});

let qrCache = null;
const sampleQr = async () => (qrCache ||= `data:image/png;base64,${(await QRCode.toBuffer(`TECHFEST:${SAMPLE.ticketId}`, {
  type: "png", errorCorrectionLevel: "M", margin: 1, width: 256,
})).toString("base64")}`);

// The email as a buyer would get it, with the unsaved wording in the body. Never sent.
router.post("/preview", async (req, res) => {
  const body = req.body || {};
  const booth = String(body.tier || "").toLowerCase() === "booth";
  const tier = booth ? BOOTH_SAMPLE.tier : (PURCHASE_TIERS.includes(tierFor(body.tier)) ? tierFor(body.tier) : "power");
  const template = compact(cleanFields(body, "purchase", { tiers: true }));
  const e = buildTicketEmail({
    ...SAMPLE, ...(booth ? { ticketId: BOOTH_SAMPLE.ticketId } : {}), tier,
    // The real email links the signed Wallet and QR addresses; the preview shows the same blocks.
    walletUrl: "#add-to-apple-wallet", qrUrl: await sampleQr(),
    logoSrc: `data:image/png;base64,${logoPng().toString("base64")}`,
    ...(typeof body.cxoBreakfast === "boolean" ? { cxoBreakfast: body.cxoBreakfast } : {}),
    // A pass with its extras switched on or off (services/passExtras.js): { cxo?, lunch?, gala?, awards? } true / false.
    ...(body.extras && typeof body.extras === "object" ? { extras: Object.fromEntries(Object.entries(body.extras).filter(([, v]) => typeof v === "boolean")) } : {}),
    template,
  });
  res.json({ subject: e.subject, preheader: e.preheader, html: e.html, text: e.text, defaults: e.defaults });
});

export default router;
