import mongoose from "mongoose";

const ticketInventorySchema = new mongoose.Schema(
  {
    // tier name
    tier: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
    },

    // total tickets available
    total: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    // how many sold
    sold: {
      type: Number,
      default: 0,
      min: 0,
    },

    // ticket price for this tier
    price: {
      type: Number,
      required: true,
      default: 0,
      min: 0,
    },

    // removed from sale: hidden from the website/app and checkout;
    // tickets already sold for this tier stay valid
    archived: {
      type: Boolean,
      default: false,
    },
  },
  {
    timestamps: true,
  }
);

/* ================= VIRTUALS ================= */

// remaining tickets
ticketInventorySchema.virtual("remaining").get(function () {
  return Math.max(this.total - this.sold, 0);
});

// prevent oversell
ticketInventorySchema.pre("save", async function () {
  if (this.sold > this.total) {
    throw new Error("Sold cannot exceed total tickets");
  }
});

const TicketInventory = mongoose.model(
  "TicketInventory",
  ticketInventorySchema
);

export default TicketInventory;
