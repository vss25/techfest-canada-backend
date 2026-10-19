/* =========================================================
   Attendee list: everyone is shown; only staff can hide someone
   ---------------------------------------------------------
   Until Oct 18 2026 people could hide themselves (PATCH /api/profile
   { directoryHidden }) and staff could hide anyone (Admin › App users,
   PATCH /api/console/users/:id { directoryHidden }). Both wrote the same
   User.directoryHidden. Now:

     • /api/profile ignores directoryHidden (older apps still send it);
     • staff edits set directoryHidden and directoryHiddenByStaff together;
     • every reader still checks directoryHidden, unchanged.

   One-time migration on deploy (AppContent "migration.directory_self_hide_v1"):
   people who hid themselves are shown again. Staff hides are kept. The only
   record of a staff hide is the admin audit log ("edit_user" with
   "directoryHidden" in the changed fields, logged since the console could
   set it, Oct 3), so anyone staff ever toggled stays as they are and is
   marked directoryHiddenByStaff. Guest Attendee records hidden because the
   owner deleted their account (Attendee.directoryHidden) are not touched.
========================================================= */

export const MIGRATION_KEY = "migration.directory_self_hide_v1";

/** The admin console's boolean for the switch (same parsing as its other switches). */
export const staffDirectoryHide = (v) => v === true || v === "true";

/** An audit row records a staff change to the attendee-list switch. */
export const isStaffDirectoryAudit = (row) =>
  row?.action === "edit_user" && /(^|[\s,|])directoryHidden(?=$|[\s,|])/.test(String(row?.detail || ""));

/**
 * Pure. hidden: users with directoryHidden true ({ _id, directoryHiddenByStaff }),
 * audits: admin audit rows. → { unhide: [ids hidden by themselves], keep: [ids staff hid] }.
 */
export function planDirectoryUnhide(hidden = [], audits = []) {
  const staffTouched = new Set(audits.filter(isStaffDirectoryAudit).map((a) => String(a.targetId)));
  const unhide = [];
  const keep = [];
  for (const u of hidden) {
    const id = String(u?._id ?? "");
    if (!id) continue;
    if (u.directoryHiddenByStaff || staffTouched.has(id)) keep.push(id);
    else unhide.push(id);
  }
  return { unhide, keep };
}

/**
 * Runs once (guarded by MIGRATION_KEY). Logs counts only, never names.
 * Models are passed in so tests can use fakes. Never throws.
 */
export async function migrateDirectorySelfHideOnce({ User, AdminAudit, AppContent, log = console } = {}) {
  try {
    if (await AppContent.exists({ key: MIGRATION_KEY })) return null;
    const hidden = await User.find({ directoryHidden: true }).select("_id directoryHiddenByStaff").lean();
    const audits = hidden.length
      ? await AdminAudit.find({ action: "edit_user", targetType: "user", detail: /directoryHidden/ }).select("action targetId detail").lean()
      : [];
    const { unhide, keep } = planDirectoryUnhide(hidden, audits);
    // directoryHiddenByStaff in the filter too: a staff hide that landed meanwhile is never undone.
    const shown = unhide.length
      ? (await User.updateMany({ _id: { $in: unhide }, directoryHiddenByStaff: { $ne: true } }, { $set: { directoryHidden: false } })).modifiedCount ?? 0
      : 0;
    if (keep.length) await User.updateMany({ _id: { $in: keep } }, { $set: { directoryHiddenByStaff: true } });
    const value = { shown, keptStaffHidden: keep.length, at: new Date() };
    await AppContent.create({ key: MIGRATION_KEY, value, updatedBy: "system" });
    log.log?.(`Attendee list: ${shown} self-hidden people shown again, ${keep.length} staff-hidden kept hidden`);
    return value;
  } catch (err) {
    log.error?.("Attendee list migration skipped:", err?.message || err);
    return null;
  }
}
