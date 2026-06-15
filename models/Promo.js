import mongoose from "mongoose";

const promoSchema = new mongoose.Schema({
  code: { type: String, required: true, unique: true, uppercase: true, trim: true, index: true },
  discount: { type: Number, required: true, min: 1, max: 100 },
  active: { type: Boolean, default: true },
  timesUsed: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now },
});

export default mongoose.model("Promo", promoSchema);
