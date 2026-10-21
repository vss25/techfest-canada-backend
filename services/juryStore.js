/* =========================================================
   Catalyst Awards jury: reading and saving the shared pieces
   (the current rubric, its versions, the settings, the email
   wording). Used by routes/jury.js and routes/juryAdmin.js;
   the rules themselves are in services/jury.js.
========================================================= */

import JuryRubric from "../models/JuryRubric.js";
import Nomination from "../models/Nomination.js";
import EmailTemplate from "../models/EmailTemplate.js";
import { AppContent } from "../models/Admin.js";
import { DEFAULT_CRITERIA, SETTINGS_KEY, plainRubric, plainSettings, poolStatusesFor } from "./jury.js";
import { TEMPLATE_KEYS, templateCopy, templateSet } from "./juryEmailCopy.js";

/** The rubric jurors score on now (the newest version, else the built-in one). */
export async function currentRubric() {
  return plainRubric(await JuryRubric.findOne({}).sort({ version: -1 }).lean());
}

/** Every version, newest first: [{ version, criteria, createdBy, createdAt }]. */
export async function rubricVersions() {
  return (await JuryRubric.find({}).sort({ version: -1 }).lean()).map(plainRubric);
}

/** Every criterion key ever used (so a new criterion never takes an old one's key). */
export async function usedCriterionKeys() {
  const rows = await JuryRubric.find({}, { "criteria.key": 1 }).lean();
  return [...new Set([...DEFAULT_CRITERIA.map((x) => x.key), ...rows.flatMap((r) => (r.criteria || []).map((x) => x.key))])];
}

/** Saves `criteria` as the next version → the new rubric. Races: the unique version index makes the slower save retry. */
export async function saveRubricVersion(criteria, by = "") {
  for (let attempt = 0; attempt < 3; attempt++) {
    const latest = await JuryRubric.findOne({}).sort({ version: -1 }).lean();
    const version = (latest?.version || 1) + 1;
    try {
      const row = await JuryRubric.create({ version, criteria, createdBy: by });
      return plainRubric(row.toObject());
    } catch (err) {
      if (err?.code !== 11000) throw err;
    }
  }
  throw new Error("Someone else saved the rubric at the same time. Reload and try again.");
}

export async function loadSettings() {
  const row = await AppContent.findOne({ key: SETTINGS_KEY }).lean();
  return { ...plainSettings(row?.value), updatedBy: row?.updatedBy || "", updatedAt: row?.updatedAt || null };
}

/** Merges `set` into the stored settings → the new settings. */
export async function saveSettings(set, by = "") {
  const row = await AppContent.findOne({ key: SETTINGS_KEY }).lean();
  const before = row?.value && typeof row.value === "object" ? row.value : {};
  const value = { ...before, ...set };
  await AppContent.findOneAndUpdate({ key: SETTINGS_KEY }, { $set: { value, updatedBy: by } }, { upsert: true });
  return loadSettings();
}

/** Nominations per status. */
export async function nominationCounts() {
  const rows = await Nomination.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]);
  const out = { pending: 0, shortlisted: 0, winner: 0, rejected: 0 };
  for (const r of rows) out[r._id || "pending"] = (out[r._id || "pending"] || 0) + r.n;
  return out;
}

/** The statuses that can be allocated now, with the counts. */
export async function currentPool(settings) {
  const counts = await nominationCounts();
  return { ...poolStatusesFor(settings, counts), counts };
}

/** The saved wording of a jury email → { copy, updatedAt, updatedBy }. Never throws (the built-in text). */
export async function loadJuryTemplate(kind) {
  try {
    const row = await EmailTemplate.findOne({ key: TEMPLATE_KEYS[kind] }).lean();
    return { copy: templateCopy(kind, row), updatedAt: row?.updatedAt || null, updatedBy: row?.updatedBy || "" };
  } catch (err) {
    return { copy: {}, updatedAt: null, updatedBy: "", error: String(err?.message || err) };
  }
}

export async function saveJuryTemplate(kind, copy, by = "") {
  await EmailTemplate.findOneAndUpdate({ key: TEMPLATE_KEYS[kind] }, { $set: templateSet(copy, by) }, { upsert: true });
  return loadJuryTemplate(kind);
}
