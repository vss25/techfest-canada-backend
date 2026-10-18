import { AppContent } from "../models/Admin.js";
import { mergeMatrix, personAccess } from "./appRights.js";
import { switchOn } from "./liveSwitches.js";
import { loadExhibitors } from "./exhibitorCache.js";

/* =========================================================
   Where the app rights matrix lives: one AppContent row
   (key "app.rights", value = { type: { right: bool } }). Not in
   CONTENT_KEYS, so /api/app/content never sends it. Cached for
   10 s like the other switches; a save clears this process's copy.
   Rules in services/appRights.js.
========================================================= */

export const RIGHTS_KEY = "app.rights";
const TTL = 10_000;
let cached = null;   // { at, matrix, updatedBy, updatedAt }

async function readRow() {
  if (cached && Date.now() - cached.at < TTL) return cached;
  try {
    const doc = await AppContent.findOne({ key: RIGHTS_KEY }).lean();
    cached = { at: Date.now(), matrix: mergeMatrix(doc?.value), updatedBy: doc?.updatedBy || "", updatedAt: doc?.updatedAt || null };
  } catch (err) {
    if (!cached) throw err;   // keep the last known matrix if Mongo hiccups
  }
  return cached;
}

/** The full matrix (defaults merged in). */
export async function loadMatrix() {
  return (await readRow()).matrix;
}

/** { matrix, updatedBy, updatedAt } for the console. */
export async function matrixInfo() {
  const { matrix, updatedBy, updatedAt } = await readRow();
  return { matrix, updatedBy, updatedAt };
}

export async function saveMatrix(matrix, by = "") {
  const value = mergeMatrix(matrix);
  await AppContent.updateOne({ key: RIGHTS_KEY }, { $set: { value, updatedBy: by } }, { upsert: true });
  cached = null;
  return value;
}

export const clearRightsCache = () => { cached = null; };

/** The global app switches that apply on top of the matrix. */
export async function loadFlags() {
  const [allowPosts, allowGroups] = await Promise.all([switchOn("flag.allow_posts"), switchOn("flag.allow_groups")]);
  return { allowPosts, allowGroups };
}

/** Everything rights checks need, loaded once per request: { matrix, flags, exhibitors }. */
export async function rightsContext() {
  const [matrix, flags, exhibitors] = await Promise.all([loadMatrix(), loadFlags(), loadExhibitors()]);
  return { matrix, flags, exhibitors };
}

/** { types, publicTypes, kind, booth, rights } for one account (loads the context). */
export async function accessOf(user, ctx = null) {
  return personAccess(user, ctx || (await rightsContext()));
}

/** Fields of User that rights checks read (select these when loading someone to check). */
export const RIGHTS_SELECT = "name role tickets types typesOff messagesOff requestsOff banned";
