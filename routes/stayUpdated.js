import express from "express";
import WaitlistSignup from "../models/WaitlistSignup.js";
import Subscription from "../models/Subscription.js";
import { AdminAudit, AppContent } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { sendFormSubmissionEmail } from "../services/emailService.js";
import { isUnsubscribed } from "../services/unsubscribe.js";
import { makeWaitlistHandler } from "../services/waitlistHandler.js";
import { sendWaitlistEmail, waitlistEmailFor } from "../services/waitlistEmail.js";
import {
  INTERESTS, NAME_LENGTH, SOURCES, STAY_KEYS, cleanInterests, cleanName, earlierUpdate, stayCopy, waitlistCounts, waitlistCsv,
  waitlistFilter, waitlistRow,
} from "../services/waitlist.js";

/* =========================================================
   "Stay updated": the TTFC 2027 waitlist (Oct 23 2026).

   Public (no sign-in), mounted at /api/stay-updated:
     POST /  { name, company, email, phone, interests: ["delegate"|"exhibitor"|"sponsorship"|"delegation"],
               source: website|webapp|ios|android|programme, consent: true, _hp }
             Only the email is required (Oct 24 2026); a name (2–80: letters, spaces, - ' ’ .), company (≤ 120) or
             phone (7–20 digits) that is given must be right; empty = "" (a repeat keeps what was saved)
             → 200 { ok: true, message }   message: the stay.thanks text ("Thank you for your interest. Someone from
                                            our team will reach out.")
             → 400 { ok: false, field, error } · 429 { ok: false, error } · 500 { ok: false, error }
             The same answer for a first sign-up and a repeat (nobody can find out who is on the list).
             Then, not waited for: the team's email to WAITLIST_INBOX (default enquire@thetechfestival.com, from the
             website forms' sender "TTFC Website <enquire@…>", reply-to the person) and the person's
             "You're on the TTFC 2027 waitlist" (from and reply-to enquire@; first sign-up, or a day after the last;
             never to an address on the unsubscribe list). Logic: services/waitlistHandler.js, services/waitlist.js,
             services/waitlistEmail.js.

   Admin (staff), mounted at /api/console/waitlist (Admin › Sales & emails › 2027 waitlist):
     GET /?q=&interest=delegate|exhibitor|sponsorship|delegation|attending&source=&page=   (q: email, name, company or phone)
             → { total, page, size, counts: { total, attending, delegate, exhibitor, sponsorship, delegation, website,
                 webapp, ios, android, programme }, rows, canExport }   newest first, 50 a page; counts are for the whole list
     GET /export?(same filters)   CSV (management: it holds phone numbers), audited "waitlist_export"
     GET /email-preview?interests=delegate,exhibitor&name=Priya%20Raman   (name: optional, "Hi Priya,")
             → { subject, html, text }   the person's confirmation with the saved wording (nothing is sent)
   Read only: no edits or deletes here.
========================================================= */

export const publicRouter = express.Router();
export const adminRouter = express.Router();

const site = String(process.env.FRONTEND_URL || "https://www.thetechfestival.com").replace(/\/+$/, "");

/** The stay.* wording (saved values over the defaults), kept 30 seconds. */
let copyCache = { at: 0, value: null };
export async function loadStayCopy({ fresh = false } = {}) {
  if (!fresh && copyCache.value && Date.now() - copyCache.at < 30_000) return copyCache.value;
  const value = stayCopy(await AppContent.find({ key: { $in: STAY_KEYS } }, { key: 1, value: 1 }).lean());
  copyCache = { at: Date.now(), value };
  return value;
}

export const waitlistStore = {
  /** One row per email: a repeat updates the name, company and phone (each when given), this time's ticks and where
      from, and adds to the rest. A changed name or company keeps the one before in earlierNames / earlierCompanies. */
  async upsert(v, { at, ipHash, userAgent }) {
    const before = v.name || v.company
      ? await WaitlistSignup.findOne({ email: v.email }, { name: 1, company: 1, earlierNames: 1, earlierCompanies: 1 }).lean()
      : null;
    const run = () => WaitlistSignup.findOneAndUpdate(
      { email: v.email },
      {
        $set: {
          // Name, company and phone are optional: one left empty this time keeps what was saved before.
          ...(v.name ? { name: v.name } : {}),
          ...(v.company ? { company: v.company } : {}),
          ...(v.phone ? { phone: v.phone, phoneDigits: v.phoneDigits } : {}),
          lastInterests: v.interests, source: v.source,
          consent: true, consentAt: at, ipHash, userAgent, lastSubmittedAt: at,
        },
        $addToSet: { interests: { $each: v.interests }, sources: v.source, ...earlierUpdate(before, v) },
        $inc: { count: 1 },
      },
      { upsert: true, returnDocument: "after", setDefaultsOnInsert: true },
    ).lean();
    let row;
    try {
      row = await run();
    } catch (err) {
      if (err?.code !== 11000) throw err;
      row = await run(); // two first sign-ups at once: the second finds the first's row
    }
    return { row, first: (row?.count || 1) <= 1 };
  },
  setAlert: (id, set) => WaitlistSignup.updateOne({ _id: id }, { $set: set }),
  claimConfirmation: (id, before, at) => WaitlistSignup.findOneAndUpdate(
    { _id: id, $or: [{ confirmedAt: null }, { confirmedAt: { $lte: before } }] },
    { $set: { confirmedAt: at, confirmStatus: "sending" } },
    { returnDocument: "before" },
  ).lean(),
  setConfirm: (id, set) => WaitlistSignup.updateOne({ _id: id }, { $set: set }),
};

publicRouter.post("/", makeWaitlistHandler({
  store: waitlistStore,
  sendAlert: (msg) => sendFormSubmissionEmail(msg),
  sendConfirmation: ({ to, interests, copy, name }) => sendWaitlistEmail({ to, interests, copy, name }),
  isUnsubscribed: (email) => isUnsubscribed(Subscription, email),
  loadCopy: () => loadStayCopy(),
  adminUrl: `${site}/admin/waitlist-2027`,
}));

/* ---------- Admin ---------- */

adminRouter.use(requireAdmin);

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("WAITLIST ADMIN ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

const PAGE_SIZE = 50;

adminRouter.get("/", wrap(async (req, res) => {
  const filter = waitlistFilter(req.query);
  const page = Math.max(0, Math.floor(Number(req.query.page)) || 0);
  const [rows, total, all, byInterest, attending, bySource] = await Promise.all([
    WaitlistSignup.find(filter).sort({ createdAt: -1 }).skip(page * PAGE_SIZE).limit(PAGE_SIZE).lean(),
    WaitlistSignup.countDocuments(filter),
    WaitlistSignup.estimatedDocumentCount(),
    WaitlistSignup.aggregate([{ $unwind: "$interests" }, { $match: { interests: { $in: INTERESTS } } }, { $group: { _id: "$interests", n: { $sum: 1 } } }]),
    WaitlistSignup.countDocuments({ interests: { $size: 0 } }),
    WaitlistSignup.aggregate([{ $unwind: "$sources" }, { $match: { sources: { $in: SOURCES } } }, { $group: { _id: "$sources", n: { $sum: 1 } } }]),
  ]);
  res.json({
    total, page, size: PAGE_SIZE,
    counts: waitlistCounts({ total: all, byInterest, attending, bySource }),
    rows: rows.map(waitlistRow),
    canExport: isManagement(req.user),
  });
}));

// Every sign-up matching the filters, as a spreadsheet. Management only, like the other lists: it holds phone numbers.
adminRouter.get("/export", requireManagement, wrap(async (req, res) => {
  const rows = await WaitlistSignup.find(waitlistFilter(req.query)).sort({ createdAt: -1 }).lean();
  await AdminAudit.create({
    adminId: req.user._id, adminName: req.user.name, action: "waitlist_export", targetType: "waitlist", targetId: "2027",
    detail: `${rows.length} rows${req.query.interest ? ` (${String(req.query.interest).slice(0, 20)})` : ""}`,
  }).catch(() => {});
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="ttfc-2027-waitlist-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(waitlistCsv(rows));
}));

// What the person's confirmation looks like with the saved wording (and a name to greet, ?name=). Nothing is sent.
adminRouter.get("/email-preview", wrap(async (req, res) => {
  const copy = await loadStayCopy({ fresh: true });
  const name = cleanName(req.query.name).slice(0, NAME_LENGTH.max);
  const e = waitlistEmailFor({ interests: cleanInterests(String(req.query.interests || "")), copy, name }, { inline: true });
  res.json({ subject: e.subject, html: e.html, text: e.text });
}));
