import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { directory } from "./people.js";
import { eventSummary } from "../services/eventSummary.js";

/* =========================================================
   Admin › RSVPs & meals › Event summary (staff, read only)
   ---------------------------------------------------------
   /api/console/summary
     GET /   ?refresh=1 (read the records again now)
             → { builtAt, timeZone, stripe, refundsChecked, speakersLoaded, days,
                 totals, passes { rows, total, marks }, meals { rows, allRsvps,
                 dietaryKeys, otherNotes }, checkin { …, byPass, firstScanOnly,
                 mealScans }, multiPass, leftOut }
   Worked out from the People directory (routes/people.js directory(): read at
   most every 20 s, the same copy People, the RSVP headcounts' eligible counts
   and the admin search use), rules in services/eventSummary.js. Any staff
   account, like People and Headcounts & RSVPs (requireAdmin: a password
   sign-in). Never writes, never emails, nothing audited.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

// One summary per directory copy: the directory is rebuilt at most every 20 s, so is this.
const made = new WeakMap();
function summaryOf(d) {
  if (!made.has(d)) made.set(d, eventSummary(d.people, { builtAt: d.builtAt, stripe: d.stripe, speakersLoaded: d.speakersLoaded }));
  return made.get(d);
}

router.get("/", async (req, res) => {
  try {
    const d = await directory({ fresh: req.query.refresh === "1" });
    res.set("Cache-Control", "private, no-store");
    res.json(summaryOf(d));
  } catch (err) {
    console.error("EVENT SUMMARY ERROR:", err?.message || err);
    res.status(500).json({ error: "Couldn't build the event summary. Try again." });
  }
});

export default router;
