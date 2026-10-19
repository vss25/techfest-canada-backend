/* =========================================================
   Four passes only (Oct 19 2026)
   ---------------------------------------------------------
   The organiser: "There is no 'speaker pass'. The option should show
   whether the individual is speaker or not, which is already present
   in type. The pass types are strictly four: Connect, Influence,
   Power and Apex." Speakers' passes became Power Passes everywhere
   (admin, the apps, Apple Wallet, emails), and exhibitor passes,
   already Connect Passes underneath, are named "Connect Pass".

   How a speaker stays a speaker: the pass keeps a marker,
   `speakerPass: true` on the ticket record (Attendee.speakerPass and
   User.tickets[].speakerPass), which services/teamRoles.js
   isSpeakerPass reads, so the automatic speaker type (autoTypes,
   passKind), the CxO Breakfasts (services/cxoBreakfast.js) and the
   VIP Lounge line in the email work as before. Chosen over writing
   "speaker" into User.types because most speakers' passes have no
   account yet (the type has to live on the pass until someone signs
   in with it), the marker travels with the pass when it's claimed,
   staff can still switch the type off with typesOff, and nothing
   staff set by hand gets mixed up with what the pass gives.

   One-time migration on start (AppContent "migration.four_passes_v1"):
     - every pass with the ticket type "speaker" (Admin › Speaker
       passes, issued "Speaker / All Access" passes, complimentary
       ones) → "power" with speakerPass: true, on Attendee rows and on
       accounts (User.tickets); Admin › Speaker passes rows (promo
       SPEAKER) and the account tickets of claimed ones get the marker
       too, whatever their type;
     - printed labels "Speaker Pass", "All Access Pass" and "Exhibitor
       Pass" on issued / exhibitor passes are cleared (the tier names
       them: "Power Pass", "Connect Pass"), and the same names in their
       saved email wording and in the saved Speaker passes / Exhibitor
       passes email templates are renamed;
     - RSVPs saved with the tier "speaker" → "power" (kind "speaker"
       stays: they were matched to the speaker list).
   Counts only are kept (never names): in the AppContent row, the
   server log and the admin audit log ("four_passes_migration").
========================================================= */

export const MIGRATION_KEY = "migration.four_passes_v1";

const SPEAKER_TYPE = /^\s*speaker\s*$/i;
const RETIRED_LABEL = /^\s*(speaker|all access|exhibitor)\s+pass\s*$/i;
const RETIRED_NAMES = /\b(Speaker|All Access|Exhibitor) Pass(es)?\b/;

/** Retired pass names in staff-written wording → the four: "Speaker Pass" and "All Access Pass" → "Power Pass",
    "Exhibitor Pass" → "Connect Pass" (plurals too). Anything else is left as it is. Pure. */
export function renamePassNames(text) {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/\bSpeaker Passes\b/g, "Power Passes").replace(/\bSpeaker Pass\b/g, "Power Pass")
    .replace(/\bAll Access Passes\b/g, "Power Passes").replace(/\bAll Access Pass\b/g, "Power Pass")
    .replace(/\bExhibitor Passes\b/g, "Connect Passes").replace(/\bExhibitor Pass\b/g, "Connect Pass")
    .replace(/\bSPEAKER PASS\b/g, "POWER PASS").replace(/\bEXHIBITOR PASS\b/g, "CONNECT PASS");
}

/** { subject, headline, message } with the retired names renamed → { set: { field: text }, changed: n }. Pure. */
export function renameCopy(copy = {}, prefix = "") {
  const set = {};
  for (const k of ["subject", "headline", "message"]) {
    const v = copy?.[k];
    if (typeof v !== "string") continue;
    const next = renamePassNames(v);
    if (next !== v) set[`${prefix}${k}`] = next;
  }
  return { set, changed: Object.keys(set).length };
}

const n = (r) => r?.modifiedCount ?? r?.nModified ?? 0;

/**
 * Runs once (guarded by MIGRATION_KEY). Models are passed in (tests use a throwaway database).
 * Never throws; returns the counts, or null when it had run before or failed.
 */
export async function migrateFourPassesOnce({
  User, Attendee, Rsvp, EmailTemplate = null, AppContent, AdminAudit = null, log = console, onDone = null, now = () => new Date(),
} = {}) {
  try {
    if (await AppContent.exists({ key: MIGRATION_KEY })) return null;

    // 1. Passes (Attendee rows): the speaker type → a Power Pass marked as a speaker's.
    const markedOld = n(await Attendee.updateMany({ ticketType: SPEAKER_TYPE, speakerPass: { $exists: false } }, { $set: { speakerPass: true } }));
    const passesToPower = n(await Attendee.updateMany({ ticketType: SPEAKER_TYPE }, { $set: { ticketType: "power" } }));
    // Admin › Speaker passes rows are speakers' passes whatever their type.
    const markedSpeakerRows = n(await Attendee.updateMany({ promoCode: "SPEAKER", speakerPass: { $exists: false } }, { $set: { speakerPass: true } }));

    // 2. Accounts: tickets of the speaker type, then the account copies of speakers' passes.
    const holders = await User.find({ "tickets.type": SPEAKER_TYPE }).select("tickets.type").lean();
    const accountTickets = holders.reduce((sum, u) => sum + (u.tickets || []).filter((t) => SPEAKER_TYPE.test(String(t?.type || ""))).length, 0);
    const accountsToPower = holders.length
      ? n(await User.updateMany(
        { "tickets.type": SPEAKER_TYPE },
        { $set: { "tickets.$[t].type": "power", "tickets.$[t].speakerPass": true } },
        { arrayFilters: [{ "t.type": SPEAKER_TYPE }] },
      ))
      : 0;
    const speakerIds = (await Attendee.find({ speakerPass: true }).select("ticketId").lean()).map((a) => a.ticketId).filter(Boolean);
    const markedAccountCopies = speakerIds.length
      ? n(await User.updateMany(
        { tickets: { $elemMatch: { ticketId: { $in: speakerIds }, speakerPass: { $exists: false } } } },
        { $set: { "tickets.$[t].speakerPass": true } },
        { arrayFilters: [{ "t.ticketId": { $in: speakerIds }, "t.speakerPass": { $exists: false } }] },
      ))
      : 0;

    // 3. Printed labels and saved wording on issued / exhibitor passes.
    const labelsCleared = n(await Attendee.updateMany({ "issuedPass.label": RETIRED_LABEL }, { $set: { "issuedPass.label": "" } }));
    let passCopiesRenamed = 0;
    const withCopy = await Attendee.find({
      $or: ["subject", "headline", "message"].map((k) => ({ [`issuedPass.copy.${k}`]: RETIRED_NAMES })),
    }).select("issuedPass.copy").lean();
    for (const a of withCopy) {
      const { set, changed } = renameCopy(a.issuedPass?.copy, "issuedPass.copy.");
      if (changed) { await Attendee.updateOne({ _id: a._id }, { $set: set }); passCopiesRenamed++; }
    }
    let templatesRenamed = 0;
    if (EmailTemplate) {
      for (const t of await EmailTemplate.find({ key: { $in: ["speaker-pass", "exhibitor-pass"] } }).lean()) {
        const { set, changed } = renameCopy(t);
        if (changed) { await EmailTemplate.updateOne({ _id: t._id }, { $set: set }); templatesRenamed++; }
      }
    }

    // 4. RSVPs saved with the speaker tier: a Power Pass (their kind stays "speaker").
    const rsvpsToPower = n(await Rsvp.updateMany({ tier: "speaker" }, { $set: { tier: "power" } }));
    await Rsvp.updateMany({ chosenTier: "speaker" }, { $set: { chosenTier: "power" } });
    await Rsvp.updateMany({ detectedTier: "speaker" }, { $set: { detectedTier: "power" } });

    const value = {
      passesToPower, accountsToPower, accountTickets, markedSpeakerRows: markedOld + markedSpeakerRows, markedAccountCopies,
      labelsCleared, passCopiesRenamed, templatesRenamed, rsvpsToPower, at: now(),
    };
    await AppContent.create({ key: MIGRATION_KEY, value, updatedBy: "system" });
    const detail = `Four passes only: ${passesToPower} passes and ${accountTickets} account tickets (${accountsToPower} accounts) from Speaker to Power`
      + ` (speaker kept with speakerPass), ${value.markedSpeakerRows} passes and ${markedAccountCopies} account copies marked as a speaker's,`
      + ` ${labelsCleared} retired labels cleared, ${passCopiesRenamed} pass emails and ${templatesRenamed} templates renamed, ${rsvpsToPower} RSVPs to Power`;
    if (AdminAudit) {
      await AdminAudit.create({ adminName: "System", action: "four_passes_migration", targetType: "migration", targetId: MIGRATION_KEY, detail }).catch(() => {});
    }
    log.log?.(detail);
    if (onDone) await Promise.resolve().then(onDone).catch(() => {});
    return value;
  } catch (err) {
    log.error?.("Four-passes migration skipped:", err?.message || err);
    return null;
  }
}
