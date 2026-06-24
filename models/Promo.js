import mongoose from "mongoose";

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  discount: { type: Number, required: true, min: 1, max: 100 }, // percent
  // Empty array = applies to ALL passes. Otherwise only listed tiers can use it.
  tiers: { type: [String], default: [], enum: ["connect", "influence", "power"] },
  active: { type: Boolean, default: true },
  timesUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Promo", promoSchema);
