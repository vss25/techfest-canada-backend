import mongoose from "mongoose";

/* One row of the Admin settings registry (Phase 3, plan §6): a single
   staff-editable setting, keyed like the app-content keys the codebase
   already uses ("site.ticket_sales_open", "flag.polls", … — the full list
   lives in services/adminHelpers.js CONTENT_KEYS and is mirrored by the
   KNOWN_KEYS registry in routes/adminSettings.js).

   This generalises the two settings-as-data patterns that came before it:
   AppContent (models/Admin.js — key/value rows the apps read, still the
   live store for those keys) and OrgSetting (per-organisation staff
   settings). AdminSetting does NOT replace either yet: it is the typed,
   validated registry new Admin modules write through, and it coexists
   with AppContent until a later step moves the data over. A row exists
   only once a setting has been explicitly set; "unset" means "the
   registry default applies" (see routes/adminSettings.js). */
const adminSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true },
  module: { type: String, required: true, default: "" },   // registry module, e.g. "site", "flags"
  value: { type: mongoose.Schema.Types.Mixed, default: null },
  valueType: {
    type: String,
    enum: ["string", "number", "boolean", "json"],
    required: true,
  },
  description: { type: String, default: "" },
  updatedBy: { type: String, default: "" },   // staff email (or name) that last set it
}, { timestamps: true });

export default mongoose.models.AdminSetting || mongoose.model("AdminSetting", adminSettingSchema);
