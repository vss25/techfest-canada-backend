import mongoose from "mongoose";

/* A company's default logo for Admin → People (services/companies.js):
   everyone whose company name folds to `nameKey` shows it. Made when staff
   first pick a logo for the company; never made by listing people. */
const str = { type: String, default: "" };

const companySchema = new mongoose.Schema({
  nameKey: { type: String, required: true, unique: true }, // companyKey(name)
  name: str,          // as staff last typed it
  domain: str,        // "acme.com", what the logo search used
  logoUrl: str,       // where we host it (Cloudinary, Sanity CDN or /api/files/company-logo/:id)
  logoSource: str,    // LOGO_SOURCES in services/companies.js
  logoStore: str,     // "cloudinary" | "sanity" | "database"
  logoRef: str,       // Cloudinary public id, Sanity asset id or CompanyLogo id
  sourceUrl: str,     // the internet address it was fetched from ("" for uploads)
  updatedBy: str,     // staff name
  updatedById: str,
}, { timestamps: true });

export default mongoose.models.Company || mongoose.model("Company", companySchema);
