import mongoose from "mongoose";

/* One company card for the app's home-screen spotlight, refreshed daily. */
const updateSchema = new mongoose.Schema(
  { headline: String, source: String, dateLabel: String, url: String },
  { _id: false }
);

const intelCardSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, unique: true },
    whatTheyDo: { type: String, default: "" },
    updates: { type: [updateSchema], default: [] },
    model: String,
    refreshedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

export default mongoose.model("IntelCard", intelCardSchema);
