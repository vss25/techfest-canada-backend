import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { directory } from "./people.js";
import { eventSummary } from "../services/eventSummary.js";
import { inEvent, LEGACY_EVENT_KEY } from "../services/people.js";
import { loadAttendance } from "../services/checkinAttendance.js";

/* =========================================================
   Admin › RSVPs & meals › Event summary (staff, read only)
   ---------------------------------------------------------
   /api/console/summary
     GET /   ?refresh=1 (read the records again now)
             → { builtAt, timeZone, stripe, refundsChecked, speakersLoaded, days,
                 totals, passes { rows, total, marks }, meals { rows, allRsvps,
                 dietaryKeys, otherNotes }, checkin { …, byPass, firstScanOnly,
                 mealScans }, multiPass, leftOut,
                 attendance }  attendance by day from the check-in desk app's marks
                 (contract C10, services/checkinAttendance.js: arrived, checked in, passes
                 collected, each meal admitted / entitled / RSVP'd / no-shows / overrides,
                 by pass colour, ISSUE PASS, NO DETAILS FOUND), read on every request;
                 null when the marks couldn't be read
   Worked out from the People directory (routes/people.js directory(): read at
   most every 20 s, the same copy People, the RSVP headcounts' eligible counts
   and the admin search use), rules in services/eventSummary.js. Any staff
   account, like People and Headcounts & RSVPs (requireAdmin: a password
   sign-in). Never writes, never emails, nothing audited.
========================================================= */

const router = express.Router();
router.use(requireAdmin);

// One summary per directory copy: the directory is rebuilt at most every 20 s, so is this.
// Nov 23 2026: ?event=<eventKey> counts that event's people only (services/people.js inEvent); without it, everyone.
const made = new WeakMap();
function summaryOf(d, event = "") {
  if (!made.has(d)) made.set(d, new Map());
  const byEvent = made.get(d);
  if (!byEvent.has(event)) {
    const people = event ? d.people.filter((p) => inEvent(p, event)) : d.people;
    byEvent.set(event, eventSummary(people, { builtAt: d.builtAt, stripe: d.stripe, speakersLoaded: d.speakersLoaded }));
  }
  return byEvent.get(event);
}

router.get("/", async (req, res) => {
  try {
    const d = await directory({ fresh: req.query.refresh === "1" });
    // Attendance is live (the desk's marks, read now); the headcounts are the directory copy's.
    const event = /^[a-z0-9-]{1,80}$/.test(String(req.query.event || "")) ? String(req.query.event) : "";
    // The desk's attendance is the 2026 main event's (its door days); another event has none yet.
    const attendance = event && event !== LEGACY_EVENT_KEY ? null : await loadAttendance(d).catch((err) => { console.error("EVENT SUMMARY ATTENDANCE ERROR:", err?.message || err); return null; });
    res.set("Cache-Control", "private, no-store");
    res.json({ ...summaryOf(d, event), attendance, event: event || null });
  } catch (err) {
    console.error("EVENT SUMMARY ERROR:", err?.message || err);
    res.status(500).json({ error: "Couldn't build the event summary. Try again." });
  }
});

export default router;
