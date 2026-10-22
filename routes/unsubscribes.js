import express from "express";
import Subscription from "../models/Subscription.js";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { SOURCES, cleanEmail, parseEmailList, recordUnsubscribe, resubscribe } from "../services/unsubscribe.js";

/* =========================================================
   /api/console/unsubscribes: Admin › Website & app › Unsubscribed
   emails (Oct 22 2026). Staff only. Everyone here is left out of
   every bulk email (services/unsubscribe.js).

   GET  /?q=                 → { count, rows: [{ email, at, source, sourceLabel, by }], sources, canEdit }
                                newest first, at most 2000 (q: part of the address)
   POST / { emails }          add people who asked by email (a reply saying "unsubscribe", a note to enquire@):
                                a string (pasted text, any separators) or an array → { added, already, invalid, emails }
                                Staff too: adding someone only stops emails. At most 2000 at once. Audited.
   POST /remove { email }     (management) take someone off the list at their request → { removed }. Audited.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

const MAX_ROWS = 2000;
const MAX_ADD = 2000;

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("UNSUBSCRIBES ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

async function audit(req, action, detail = "") {
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action, targetType: "campaign", targetId: "unsubscribes", detail: String(detail).slice(0, 500),
  }).catch(() => {});
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

router.get("/", wrap(async (req, res) => {
  const q = String(req.query.q || "").trim().toLowerCase().slice(0, 100);
  const filter = { subscribed: false, ...(q ? { email: { $regex: escRe(q) } } : {}) };
  const [count, rows] = await Promise.all([
    Subscription.countDocuments({ subscribed: false }),
    Subscription.find(filter).sort({ unsubscribedAt: -1, updatedAt: -1 }).limit(MAX_ROWS)
      .select("email unsubscribedAt unsubscribeSource unsubscribedBy updatedAt").lean(),
  ]);
  res.json({
    count,
    rows: rows.map((r) => {
      const source = r.unsubscribeSource || "";
      return {
        email: r.email,
        at: r.unsubscribedAt || r.updatedAt || null,
        source,
        sourceLabel: SOURCES[source] || "Before this list was kept",
        by: r.unsubscribedBy || "",
      };
    }),
    sources: SOURCES,
    canEdit: isManagement(req.user),
  });
}));

router.post("/", wrap(async (req, res) => {
  const { emails, invalid } = parseEmailList(req.body?.emails);
  if (!emails.length) return res.status(400).json({ error: invalid.length ? `None of those are email addresses: ${invalid.slice(0, 5).join(", ")}.` : "Paste at least one email address." });
  if (emails.length > MAX_ADD) return res.status(400).json({ error: `That's more than ${MAX_ADD} addresses. Add them in parts.` });
  const by = String(req.user.email || req.user.name || req.user._id);
  let added = 0;
  for (const e of emails) {
    const r = await recordUnsubscribe(Subscription, e, { source: "staff", by });
    if (r?.added) added++;
  }
  const already = emails.length - added;
  await audit(req, "unsubscribe_add", `${added} added${already ? `, ${already} already on the list` : ""}: ${emails.slice(0, 20).join(", ")}${emails.length > 20 ? "…" : ""}`);
  res.json({ added, already, invalid, emails });
}));

router.post("/remove", requireManagement, wrap(async (req, res) => {
  const email = cleanEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: "Which email address?" });
  const removed = await resubscribe(Subscription, email, { by: String(req.user.email || req.user.name || req.user._id) });
  if (!removed) return res.status(404).json({ error: "That address isn't on the list." });
  await audit(req, "unsubscribe_remove", email);
  res.json({ removed: true, email });
}));

export default router;
