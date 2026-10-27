import express from "express";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { publicSwag, longTime } from "../services/swagRules.js";
import { loadSwag, loadAnnounced, validSnapshot, currentWinners, announceWinners, takeSnapshot, announcedWinners } from "../services/swag.js";

/* =========================================================
   "Win the TTFC swag kit" (Oct 22 2026), services/swag.js and services/swagRules.js.

   Public (no sign-in), mounted at /api/app/swag:
     GET /  → { enabled, title, kits, cutoff, announce (ISO), cutoffLabel ("4:00 PM on Monday, October 26"),
               cutoffShort ("Oct 26, 4 PM"), announceLabel, rules (with {kits} {cutoff} {announce} filled in),
               phase: "open" | "closed" | "announced", announced, appOnly: true, pitch ("Only people using the TTFC app can win"),
               rulesUrl, photoUrl, installUrl,
               winners (Oct 26 2026, only once announced; absent before):
                 [{ rank, boardRank, name, organization, avatarUrl, points, userId }] }   Cache-Control 60 s.
             winners: the announced record's, in its order, for the apps' podium and confetti. rank = the podium place
             (1, 2, 3 …); boardRank = their place on the leaderboard at the cutoff (people who can't win are passed over);
             avatarUrl = their photo now (services/socialHelpers.js avatarFor: "/api/files/avatar/<id>?v=<n>", a
             speaker's website photo, or ""); never an email.

   Admin (staff read, management announces), mounted at /api/console/swag:
     GET  /           → { settings (as public), winners: [{ userId, name, organization, points, rank }], live, takenAt,
                          staleTakenAt, cutoffPassed, announced: { at, by, winners } | null, canAnnounce,
                          autoAnnounce, autoAnnounceAt (ISO: swag.announce), autoAnnounceLabel ("5:00 PM on Tuesday,
                          October 27") }
                        autoAnnounce (swag.autoAnnounce, on by default, Oct 26 2026: "Keep the 5 PM announcement
                        automatic within the app"): at autoAnnounceAt the minute job announces this list by itself
                        (services/swag.js runSwagAutoAnnounce, by "Automatic (5 PM)"), unless it was announced first.
                        winners: the first `kits` who can win, from the leaderboard kept at the cutoff (live: true
                        before it's kept). Oct 26 2026: a leaderboard kept at an earlier cutoff (the cutoff moved later
                        since) doesn't count: live: true until the new cutoff, staleTakenAt = when that one was kept.
     POST /announce { confirm: "ANNOUNCE", userIds: [...] } (management) → { announced }
                        userIds must be exactly the list shown (409 { code: "changed", winners } when it changed);
                        409 { code: "not_yet" } before the cutoff, { code: "swag_off" } while off,
                        { code: "already_announced" } the second time. Each winner gets an in-app notification and a
                        push: "You won a TTFC swag kit!" / "Collect it at the registration desk." Audited. It still works
                        before the automatic time; whichever comes first wins (the other: already_announced).
========================================================= */

export const publicRouter = express.Router();
export const adminRouter = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("SWAG ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

publicRouter.get("/", wrap(async (req, res) => {
  const [s, announced] = await Promise.all([loadSwag(), loadAnnounced()]);
  const winners = announced?.at ? await announcedWinners(announced) : null;
  res.set("Cache-Control", "public, max-age=60");
  res.json(publicSwag(s, { announced: !!announced?.at, winners }));
}));

adminRouter.use(requireAdmin);

adminRouter.get("/", wrap(async (req, res) => {
  const [w, announced] = await Promise.all([currentWinners(), loadAnnounced()]);
  res.json({
    settings: publicSwag(w.settings, { announced: !!announced?.at }), winners: w.winners, live: w.live, takenAt: w.takenAt,
    staleTakenAt: w.staleTakenAt, cutoffPassed: w.cutoffPassed, announced: announced || null,
    canAnnounce: isManagement(req.user) && w.settings.enabled && w.cutoffPassed && !announced?.at,
    autoAnnounce: w.settings.autoAnnounce, autoAnnounceAt: w.settings.announce.toISOString(), autoAnnounceLabel: longTime(w.settings.announce),
  });
}));

adminRouter.post("/announce", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "ANNOUNCE") return res.status(400).json({ error: "Type ANNOUNCE to confirm." });
  const s = await loadSwag();
  if (!s.enabled) return res.status(409).json({ code: "swag_off", error: "The swag kit contest is switched off." });
  if (new Date() < s.cutoff) return res.status(409).json({ code: "not_yet", error: "The leaderboard hasn't closed yet." });
  // Past the cutoff: keep the leaderboard now if the minute job hasn't yet (or kept it at an earlier cutoff), so the
  // list can't move under the click.
  if (!(await validSnapshot(s))) await takeSnapshot({ settings: s });
  const { winners } = await currentWinners();
  const want = Array.isArray(b.userIds) ? b.userIds.map(String) : [];
  if (JSON.stringify(want) !== JSON.stringify(winners.map((w) => w.userId))) {
    return res.status(409).json({ code: "changed", error: "The list changed. Check it again before announcing.", winners });
  }
  try {
    const out = await announceWinners(winners, { by: String(req.user?.name || req.user?.email || ""), byId: req.user._id });
    await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "swag_announce", targetType: "campaign", targetId: "swag",
      detail: `${winners.length} winners: ${winners.map((w) => w.name).join(", ")}`.slice(0, 500) }).catch(() => {});
    res.json(out);
  } catch (err) {
    if (err?.code === "already_announced") return res.status(409).json({ code: "already_announced", error: err.message });
    throw err;
  }
}));
