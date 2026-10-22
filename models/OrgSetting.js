import mongoose from "mongoose";

/* One organisation in the apps' organisations list (GET /api/app/organisations,
   services/organisations.js), by its key (services/companies.js companyKey):
   what staff set in Admin › Attending organisations, and the automatic logo
   search's bookkeeping. Made the first time either happens; listing makes none.
     hidden      true = left out of the apps' list (staff)
     aliasOf     "merge X into Y": this key counts as Y's key ("" = no alias)
     aliasOff    true = a built-in alias for this key is switched off
     logoCheckedAt / logoCheckDomain / logoCheckResult: the last automatic
                 logo search (at most one a day per organisation, any server) */
const str = { type: String, default: "" };

const orgSettingSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  name: str,                 // the name staff saw when they last changed it
  hidden: { type: Boolean, default: false },
  aliasOf: str,
  aliasOff: { type: Boolean, default: false },
  logoCheckedAt: { type: Date },
  logoCheckDomain: str,
  logoCheckResult: str,      // "found" | "none" | "error" (no details: they could carry a URL)
  updatedBy: str,            // staff name
  updatedById: str,
}, { timestamps: true });

export default mongoose.models.OrgSetting || mongoose.model("OrgSetting", orgSettingSchema);
