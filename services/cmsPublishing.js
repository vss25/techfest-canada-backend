import AdminSetting from "../models/AdminSetting.js";

/* =========================================================
   The publishing switch (Nov 17 2026): "show the production website's
   Nov 14 state until I have made all updates in the CMS to push to prod".

   While paused, nothing in the admin changes the live website's content:
   Publish to live, edits and creates that write straight to live, deleting a
   live item and the agenda import are refused (409). "Running late" (event day)
   isn't: nothing is on an agenda until February. Saving
   and sending to staging keep working, so staff prepare everything on
   staging. A manager turns publishing on at launch (Website changes), then
   publishes everything that's waiting.

   Paused is the default: no row means paused.
========================================================= */

export const PUBLISHING_KEY = "cms.publishing_paused";

export const PAUSED_MESSAGE = "Publishing to the live website is paused until the new website launches. "
  + "Your change is kept: save it and send it to staging. A manager turns publishing on at launch.";

/** { paused, updatedBy, updatedAt } — paused unless a manager turned it on. */
export async function publishingState() {
  const row = await AdminSetting.findOne({ key: PUBLISHING_KEY }).lean();
  return {
    paused: row ? row.value !== false : true,
    updatedBy: row?.updatedBy || "",
    updatedAt: row?.updatedAt || null,
  };
}

export async function setPublishingPaused(paused, by = "") {
  await AdminSetting.updateOne(
    { key: PUBLISHING_KEY },
    { $set: { value: !!paused, valueType: "boolean", module: "cms", updatedBy: by,
      description: "Publishing to the live website is paused (the live site keeps its current content)." } },
    { upsert: true },
  );
  return publishingState();
}

/** Refuses the request (409) while publishing is paused. → true when it was refused. */
export async function refuseWhilePaused(res) {
  if (!(await publishingState()).paused) return false;
  res.status(409).json({ error: PAUSED_MESSAGE, publishingPaused: true });
  return true;
}
