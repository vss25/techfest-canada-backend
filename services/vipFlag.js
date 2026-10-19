/* =========================================================
   VIP: from a person type to a yes / no flag (Oct 19 2026)
   ---------------------------------------------------------
   Until now "vip" was one of the seven person types (User.types /
   User.typesOff) with its own column in the app rights matrix. The
   user asked for "a yes/no option for VIP that organizers can manually
   update". So VIP is now User.vip (Attendee.vip on a pass-only person),
   switched in Admin → People, and gives no rights of its own: a VIP
   gets the rights of their other types. The apps keep getting kind
   "vip" for the badge (services/teamRoles.js), so no app release.

   One-time migration on start (AppContent "migration.vip_flag_v1"):
     - everyone with "vip" in types (and not in typesOff) → vip: true
       (unless staff already set vip on them);
     - "vip" is taken out of types and typesOff for everyone;
     - the stored rights matrix (AppContent "app.rights") loses its
       "vip" column.
   Counts only are logged (never names), in the AppContent row, the
   server log and the admin audit log ("vip_migration").
========================================================= */

export const MIGRATION_KEY = "migration.vip_flag_v1";
const RIGHTS_KEY = "app.rights";

const hasVip = (list) => (Array.isArray(list) ? list : []).some((t) => String(t ?? "").trim().toLowerCase() === "vip");

/**
 * Pure. users: { _id, types, typesOff, vip } for everyone with "vip" in types or typesOff.
 * → { makeVip: [ids that become vip: true], cleanOnly: [ids that only lose the stored "vip"], keptOwnFlag: n }
 */
export function planVipMigration(users = []) {
  const makeVip = [];
  const cleanOnly = [];
  let keptOwnFlag = 0;
  for (const u of users) {
    const id = String(u?._id ?? "");
    if (!id) continue;
    const wasVip = hasVip(u.types) && !hasVip(u.typesOff);
    if (typeof u.vip === "boolean") { keptOwnFlag += wasVip ? 1 : 0; cleanOnly.push(id); continue; }
    (wasVip ? makeVip : cleanOnly).push(id);
  }
  return { makeVip, cleanOnly, keptOwnFlag };
}

/**
 * Runs once (guarded by MIGRATION_KEY). Models are passed in so tests can use fakes. Never throws.
 * `onDone` (e.g. clearing the rights and exhibitor caches) runs after a migration that ran.
 */
export async function migrateVipTypeOnce({ User, AppContent, AdminAudit = null, log = console, onDone = null, now = () => new Date() } = {}) {
  try {
    if (await AppContent.exists({ key: MIGRATION_KEY })) return null;
    const VIP = /^\s*vip\s*$/i;
    const users = await User.find({ $or: [{ types: VIP }, { typesOff: VIP }] }).select("_id types typesOff vip").lean();
    const { makeVip, cleanOnly, keptOwnFlag } = planVipMigration(users);
    const flagged = makeVip.length
      ? (await User.updateMany({ _id: { $in: makeVip }, vip: { $exists: false } }, { $set: { vip: true } })).modifiedCount ?? 0
      : 0;
    const ids = [...makeVip, ...cleanOnly];
    const cleaned = ids.length
      ? (await User.updateMany({ _id: { $in: ids } }, { $pull: { types: VIP, typesOff: VIP } })).modifiedCount ?? 0
      : 0;
    const matrix = await AppContent.findOne({ key: RIGHTS_KEY }).lean();
    const hadColumn = !!(matrix?.value && typeof matrix.value === "object" && "vip" in matrix.value);
    if (hadColumn) await AppContent.updateOne({ key: RIGHTS_KEY }, { $unset: { "value.vip": "" } });
    const value = { vipYes: flagged, typesCleaned: cleaned, keptOwnFlag, rightsColumnRemoved: hadColumn, at: now() };
    await AppContent.create({ key: MIGRATION_KEY, value, updatedBy: "system" });
    const detail = `VIP is a yes / no switch now: ${flagged} people with the VIP type set to VIP Yes, "vip" removed from ${cleaned} type lists`
      + `${keptOwnFlag ? `, ${keptOwnFlag} already had the switch` : ""}${hadColumn ? ", VIP column removed from App rights" : ""}`;
    if (AdminAudit) await AdminAudit.create({ adminName: "System", action: "vip_migration", targetType: "migration", targetId: MIGRATION_KEY, detail }).catch(() => {});
    log.log?.(detail);
    if (onDone) await Promise.resolve().then(onDone).catch(() => {});
    return value;
  } catch (err) {
    log.error?.("VIP migration skipped:", err?.message || err);
    return null;
  }
}
