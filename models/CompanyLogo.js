import mongoose from "mongoose";

/* Logo images kept in the database when neither Cloudinary nor a Sanity write
   token is configured (services/logoStore.js). Served by GET
   /api/files/company-logo/:id. One row per distinct image (sha256). */
const companyLogoSchema = new mongoose.Schema({
  sha256: { type: String, required: true, unique: true },
  contentType: { type: String, required: true },
  bytes: { type: Number, default: 0 },
  data: { type: Buffer, required: true },
}, { timestamps: true });

export default mongoose.models.CompanyLogo || mongoose.model("CompanyLogo", companyLogoSchema);
