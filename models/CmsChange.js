import mongoose from "mongoose";

/* Website content changes on their way to the website (Nov 2026, admin-first workflow).
   One row per Sanity document id that has work in progress or is on staging.

   1. Staff save: the whole edited document goes in `wip` (Sanity is not touched, so
      neither the live site nor staging changes).
   2. "Send to staging" (any staff): `wip` is written to Sanity as the draft
      (`drafts.<id>`), which the staging site shows; `wip` is cleared, `stagedAt/By` set.
   3. "Publish to live" (management): the Sanity draft becomes the published document
      and this row is deleted.
   Staged content itself lives only in Sanity (drafts are private: never served without a
   token), so this row holds no more than who staged it and when. */

const who = { id: String, name: String };

const cmsChangeSchema = new mongoose.Schema({
  docId: { type: String, required: true, unique: true },
  type: { type: String, required: true },
  wip: { type: mongoose.Schema.Types.Mixed, default: null },
  wipAt: Date,
  wipBy: who,
  stagedAt: Date,
  stagedBy: who,
}, { minimize: false });

cmsChangeSchema.index({ type: 1 });

export default mongoose.models.CmsChange || mongoose.model("CmsChange", cmsChangeSchema);
