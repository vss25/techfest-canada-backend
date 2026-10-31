import mongoose from "mongoose";

/* A winner's certificate (JPEG or PNG) and post text, waiting while the person
   approves posting on LinkedIn from the website's winner page (routes/awards.js).
   Deleted as soon as it's posted, and by MongoDB after 30 minutes if not. */
const awardPostSchema = new mongoose.Schema({
  draftId: { type: String, required: true, unique: true },
  state: { type: String, default: "", index: true },
  winnerId: { type: String, required: true },
  image: { type: Buffer, required: true },
  text: { type: String, default: "" },
  createdAt: { type: Date, default: Date.now, expires: 30 * 60 },
});

export default mongoose.model("AwardPost", awardPostSchema);
