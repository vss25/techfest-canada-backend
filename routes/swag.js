import express from "express";
import { AdminAudit } from "../models/Admin.js";
import { requireAdmin, requireManagement, isManagement } from "../middleware/adminAuth.js";
import { publicSwag, longTime } from "../services/swagRules.js";
import { loadSwag, loadAnnounced, validSnapshot, currentWinners, announceWinners, takeSnapshot, announcedWinners } from "../services/swag.js";

/* =========================================================
   The top networkers (Oct 22 2026 as "Win the TTFC swag kit"; since Oct 27 2026 an appreciation with no prize: the
   organiser, "you've been the best networker; people like you make the TTFC experience great"), services/swag.js and
   services/swagRules.js. The snapshot, the announcement and the winners depend on swag.celebrate; swag.enabled only
   shows the old prize banner in the app versions that still have it.

   Public (no sign-in), mounted at /api/app/swag:
     GET /  → { enabled, title, kits, cutoff, announce (ISO), cutoffLabel ("4:00 PM on Monday, October 26"),
               cutoffShort ("Oct 26, 4 PM"), announceLabel, rules (with {kits} {cutoff} {announce} filled in),
               phase: "open" | "closed" | "announced", announced, appOnly: true, pitch ("Start conversations and meet
               people in the TTFC app"), celebrate (swag.celebrate), mode: "appreciation", rulesUrl, photoUrl, installUrl,
               winners (Oct 26 2026, only once announced and while swag.celebrate is on; absent otherwise):
                 [{ rank, boardRank, name, organization, avatarUrl, points, userId }] }   Cache-Control 60 s.
             winners: the announced record's, in its order, for the apps' podium and confetti. rank = the podium place
             (1, 2, 3 …); boardRank = their place on the leaderboard at the cutoff (people who can't win are passed over);
             avatarUrl = their photo now (services/socialHelpers.js avatarFor: "/api/files/avatar/<id>?v=<n>", a
             speaker's website photo, or ""); never an email.

   Admin (staff read, management announces the top networkers), mounted at /api/console/swag:
     GET  /           → { settings (as public), winners: [{ userId, name, organization, points, rank }], live, takenAt,
                          staleTakenAt, cutoffPassed, announced: { at, by, winners, postId } | null, canAnnounce,
                          celebrate, autoAnnounce, autoAnnounceAt (ISO: swag.announce), autoAnnounceLabel ("5:00 PM on Tuesday,
                          October 27") }
                        autoAnnounce (swag.autoAnnounce, on by default, Oct 26 2026: "Keep the 5 PM announcement
                        automatic within the app"): at autoAnnounceAt the minute job announces this list by itself
                        (services/swag.js runSwagAutoAnnounce, by "Automatic (5 PM)"), unless it was announced first.
                        winners: the first `kits` who can win, from the leaderboard kept at the cutoff (live: true
                        before it's kept). Oct 26 2026: a leaderboard kept at an earlier cutoff (the cutoff moved later
                        since) doesn't count: live: true until the new cutoff, staleTakenAt = when that one was kept.
     POST /announce { confirm: "ANNOUNCE", userIds: [...] } (management) → { announced }
                        userIds must be exactly the list shown (409 { code: "changed", winners } when it changed);
                        409 { code: "not_yet" } before the cutoff, { code: "swag_off" } while swag.celebrate is off,
                        { code: "already_announced" } the second time. Each top networker gets an in-app notification and
                        a push: "You're one of TTFC's top networkers!" / "Thank you for starting conversations and
                        meeting people at TTFC 2026. People like you make the TTFC experience great." (opens the Profile
                        tab, the leaderboard), and one official feed post names them (swag.feedPost, not pushed to
                        everyone). Audited ("top networkers"). It still works before the automatic time; whichever comes
                        first wins (the other: already_announced).
========================================================= */

export const publicRouter = express.Router();
export const adminRouter = express.Router();

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((err) => {
  console.error("SWAG ERROR:", err?.message || err);
  if (!res.headersSent) res.status(500).json({ error: "Something went wrong. Try again." });
});

publicRouter.get("/", wrap(async (req, res) => {
  const [s, announced] = await Promise.all([loadSwag(), loadAnnounced()]);
  const winners = announced?.at && s.celebrate ? await announcedWinners(announced) : null;
  res.set("Cache-Control", "public, max-age=60");
  res.json(publicSwag(s, { announced: !!announced?.at, winners }));
}));

adminRouter.use(requireAdmin);

adminRouter.get("/", wrap(async (req, res) => {
  const [w, announced] = await Promise.all([currentWinners(), loadAnnounced()]);
  res.json({
    settings: publicSwag(w.settings, { announced: !!announced?.at }), winners: w.winners, live: w.live, takenAt: w.takenAt,
    staleTakenAt: w.staleTakenAt, cutoffPassed: w.cutoffPassed, announced: announced || null,
    canAnnounce: isManagement(req.user) && w.settings.celebrate && w.cutoffPassed && !announced?.at,
    celebrate: w.settings.celebrate,
    autoAnnounce: w.settings.autoAnnounce, autoAnnounceAt: w.settings.announce.toISOString(), autoAnnounceLabel: longTime(w.settings.announce),
  });
}));

adminRouter.post("/announce", requireManagement, wrap(async (req, res) => {
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.confirm !== "ANNOUNCE") return res.status(400).json({ error: "Type ANNOUNCE to confirm." });
  const s = await loadSwag();
  if (!s.celebrate) return res.status(409).json({ code: "swag_off", error: "Celebrating the top networkers is switched off." });
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
    const out = await announceWinners(winners, { by: String(req.user?.name || req.user?.email || ""), byId: req.user._id, settings: s });
    await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action: "swag_announce", targetType: "campaign", targetId: "swag",
      detail: `${winners.length} top networkers celebrated: ${winners.map((w) => w.name).join(", ")}`.slice(0, 500) }).catch(() => {});
    res.json(out);
  } catch (err) {
    if (err?.code === "already_announced") return res.status(409).json({ code: "already_announced", error: err.message });
    throw err;
  }
}));
