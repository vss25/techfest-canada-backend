/* =========================================================
   Pass names (Oct 19 2026)
   ---------------------------------------------------------
   The organiser's passes: the four on sale (Connect, Influence,
   Power, Apex) and the internal Speaker Pass (tier "speaker", never
   sold or listed: Power + both CxO Breakfasts + the VIP Lounge).
   Two names go: "All Access Pass" is the Power Pass ("All Access
   Pass = Power Pass only"), and exhibitor passes, Connect Passes
   underneath, are named "Connect Pass" (being an exhibitor is their
   type, "Is Exhibitor? Yes").

   One-time migration on start (AppContent "migration.pass_names_v1"):
     - printed labels "Exhibitor Pass" and "All Access Pass" on issued
       and exhibitor passes are cleared, so the tier names them
       ("Connect Pass", "Speaker Pass" for an issued Speaker Pass,
       "Power Pass");
     - in staff-saved email wording (each pass's own, and the Speaker
       passes / Exhibitor passes templates) "All Access Pass(es)" →
       "Power Pass(es)" and "Exhibitor Pass(es)" → "Connect Pass(es)".
       On a Speaker Pass, and in the Speaker passes template, "All
       Access Pass" was that pass's old name (an issued "speaker" pass
       was printed "All Access Pass"), so there it becomes "Speaker
       Pass". "Speaker Pass" itself stays: it's a pass again.
   Nothing changes tier. Counts only are kept (never names): in the
   AppContent row, the server log and the admin audit log
   ("pass_names_migration").
========================================================= */

export const MIGRATION_KEY = "migration.pass_names_v1";

const RETIRED_LABEL = /^\s*(all[- ]access|exhibitor)\s+pass\s*$/i;
const RETIRED_NAMES = /\b(All Access|Exhibitor) Pass(es)?\b/i;

/** The retired names in staff-written wording → today's: "All Access Pass" → "Power Pass" ("Speaker Pass" with
    { speaker: true }: wording on a Speaker Pass, where it was that pass's old name), "Exhibitor Pass" → "Connect Pass"
    (plurals and capitals too). Anything else, "Speaker Pass" included, stays. Pure. */
export function renamePassNames(text, { speaker = false } = {}) {
  if (typeof text !== "string" || !text) return text;
  const to = speaker ? "Speaker" : "Power";
  return text
    .replace(/\bAll[- ]Access Passes\b/g, `${to} Passes`).replace(/\bAll[- ]Access Pass\b/g, `${to} Pass`)
    .replace(/\bExhibitor Passes\b/g, "Connect Passes").replace(/\bExhibitor Pass\b/g, "Connect Pass")
    .replace(/\bALL[- ]ACCESS PASS(ES)?\b/g, (m, pl) => `${to.toUpperCase()} PASS${pl || ""}`)
    .replace(/\bEXHIBITOR PASS(ES)?\b/g, (m, pl) => `CONNECT PASS${pl || ""}`);
}

/** { subject, headline, message } with the retired names renamed → { set: { field: text }, changed: n }. Pure. */
export function renameCopy(copy = {}, prefix = "", opts = {}) {
  const set = {};
  for (const k of ["subject", "headline", "message"]) {
    const v = copy?.[k];
    if (typeof v !== "string") continue;
    const next = renamePassNames(v, opts);
    if (next !== v) set[`${prefix}${k}`] = next;
  }
  return { set, changed: Object.keys(set).length };
}

const n = (r) => r?.modifiedCount ?? r?.nModified ?? 0;

/**
 * Runs once (guarded by MIGRATION_KEY). Models are passed in (tests use a throwaway database).
 * Never throws; returns the counts, or null when it had run before or failed.
 */
export async function migratePassNamesOnce({
  Attendee, EmailTemplate = null, AppContent, AdminAudit = null, log = console, onDone = null, now = () => new Date(),
} = {}) {
  try {
    if (await AppContent.exists({ key: MIGRATION_KEY })) return null;
    // 1. Printed labels: the tier names the pass instead ("Connect Pass", "Speaker Pass", "Power Pass").
    const exhibitorLabels = n(await Attendee.updateMany({ promoCode: "EXHIBITOR", "issuedPass.label": RETIRED_LABEL }, { $set: { "issuedPass.label": "" } }));
    const speakerLabels = n(await Attendee.updateMany({ ticketType: /^\s*speaker\s*$/i, "issuedPass.label": RETIRED_LABEL }, { $set: { "issuedPass.label": "" } }));
    const otherLabels = n(await Attendee.updateMany({ "issuedPass.label": RETIRED_LABEL }, { $set: { "issuedPass.label": "" } }));
    // 2. Each pass's own saved wording, then the two templates.
    let passCopiesRenamed = 0;
    const withCopy = await Attendee.find({
      $or: ["subject", "headline", "message"].map((k) => ({ [`issuedPass.copy.${k}`]: RETIRED_NAMES })),
    }).select("ticketType issuedPass.copy").lean();
    for (const a of withCopy) {
      const speaker = /^\s*speaker\s*$/i.test(String(a.ticketType || ""));
      const { set, changed } = renameCopy(a.issuedPass?.copy, "issuedPass.copy.", { speaker });
      if (changed) { await Attendee.updateOne({ _id: a._id }, { $set: set }); passCopiesRenamed++; }
    }
    let templatesRenamed = 0;
    if (EmailTemplate) {
      for (const t of await EmailTemplate.find({ key: { $in: ["speaker-pass", "exhibitor-pass"] } }).lean()) {
        const { set, changed } = renameCopy(t, "", { speaker: t.key === "speaker-pass" });
        if (changed) { await EmailTemplate.updateOne({ _id: t._id }, { $set: set }); templatesRenamed++; }
      }
    }
    const value = { exhibitorLabels, speakerLabels, otherLabels, passCopiesRenamed, templatesRenamed, at: now() };
    await AppContent.create({ key: MIGRATION_KEY, value, updatedBy: "system" });
    const detail = `Pass names: ${exhibitorLabels} exhibitor passes now "Connect Pass", ${speakerLabels} issued Speaker Passes now "Speaker Pass"`
      + `${otherLabels ? `, ${otherLabels} other "All Access" labels cleared` : ""}, ${passCopiesRenamed} pass emails and ${templatesRenamed} templates reworded`;
    if (AdminAudit) {
      await AdminAudit.create({ adminName: "System", action: "pass_names_migration", targetType: "migration", targetId: MIGRATION_KEY, detail }).catch(() => {});
    }
    log.log?.(detail);
    if (onDone) await Promise.resolve().then(onDone).catch(() => {});
    return value;
  } catch (err) {
    log.error?.("Pass-names migration skipped:", err?.message || err);
    return null;
  }
}
