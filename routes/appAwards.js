import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Nomination from "../models/Nomination.js";
import { switchOn } from "../services/liveSwitches.js";
import { isTeam } from "../services/teamRoles.js";
import { APPLICATIONS_KEY, NOMINATION_SELECT, applicationsPayload, summaryPayload } from "../services/awardApplications.js";

/* =========================================================
   /api/app/awards — the Catalyst Awards numbers and applications
   in the apps and the web app (Oct 21 2026, services/awardApplications.js)
   GET /summary        no sign-in. { enabled, categoriesCount, applicationsCount }
                       for the Awards screen (guests too). Cache-Control public, 60 s.
   GET /applications   signed-in pass holders (staff and volunteer accounts too):
                       { enabled, total, categoriesCount, items: [{ id, nomineeName,
                       nomineeType, nomineeTitle, nomineeOrganisation, nomineeLocation,
                       nomineeWebsite, applicantName, selfNominated, submittedAt }] }
                       sorted by nominee name. 401 without a valid sign-in, 403 for a
                       suspended account or one with no pass. Cache-Control private, 60 s.
   Site settings › "Show award applications in the app" (site.award_applications,
   default on). Off → { enabled: false, total: 0, categoriesCount, items: [] } and
   the summary's applicationsCount 0. Nominations are read at most once a minute
   per server; nothing about them is ever logged.
========================================================= */

const router = express.Router();

const TTL_MS = 60_000;
let memo = { at: 0, rows: null, pending: null };

/** Eligibility needs every nomination's status and category: read them (select-limited) at most once a minute. */
async function nominations() {
  if (memo.rows && Date.now() - memo.at < TTL_MS) return memo.rows;
  if (!memo.pending) {
    memo.pending = Nomination.find({}).select(NOMINATION_SELECT).lean()
      .then((rows) => { memo = { at: Date.now(), rows, pending: null }; return rows; })
      .catch((err) => { memo.pending = null; throw err; });
  }
  return memo.pending;
}

/** For tests (and after an admin change, if one ever needs it at once). */
export function forgetAwardApplications() { memo = { at: 0, rows: null, pending: null }; }

const isBooth = (t) => /^BOOTH-/i.test(String(t?.ticketId || "")) || /^booth/i.test(String(t?.type || ""));

/** null when they may see the list, else [status, body]. */
async function gate(req) {
  const h = String(req.headers.authorization || "");
  if (!h.startsWith("Bearer ")) return [401, { error: "Sign in to see the applications." }];
  let user;
  try {
    const decoded = jwt.verify(h.slice(7), process.env.JWT_SECRET);
    user = await User.findById(decoded.id).select("_id role banned tickets.ticketId tickets.type").lean();
  } catch {
    return [401, { error: "Sign in to see the applications." }];
  }
  if (!user) return [401, { error: "Sign in to see the applications." }];
  if (user.banned) return [403, { error: "This account is suspended. Contact enquire@thetechfestival.com." }];
  if (isTeam(user)) return null;
  if ((user.tickets || []).some((t) => !isBooth(t))) return null;
  if (await Attendee.exists({ claimedBy: user._id, ticketId: { $not: /^BOOTH-/i } })) return null;
  return [403, { error: "Only pass holders can see the applications.", code: "no_pass" }];
}

router.get("/awards/summary", async (req, res) => {
  try {
    const [rows, enabled] = await Promise.all([nominations(), switchOn(APPLICATIONS_KEY)]);
    res.set("Cache-Control", "public, max-age=60");
    res.json(summaryPayload(rows, { enabled }));
  } catch (err) {
    console.error("AWARDS SUMMARY ERROR:", err?.message || err);
    res.status(503).json({ error: "The awards numbers aren't available right now." });
  }
});

router.get("/awards/applications", async (req, res) => {
  const refused = await gate(req);
  if (refused) return res.status(refused[0]).json(refused[1]);
  try {
    const [rows, enabled] = await Promise.all([nominations(), switchOn(APPLICATIONS_KEY)]);
    res.set("Cache-Control", "private, max-age=60");
    res.json(applicationsPayload(rows, { enabled }));
  } catch (err) {
    console.error("AWARD APPLICATIONS ERROR:", err?.message || err);
    res.status(503).json({ error: "The applications aren't available right now. Try again soon." });
  }
});

export default router;
