import mongoose from "mongoose";

const ticketSchema = new mongoose.Schema({
  ticketId: {
    type: String,
    required: true
  },
  type: {
    type: String,
    required: true
  },
  purchaseDate: {
    type: Date,
    default: Date.now
  },
  checkedIn: {
    type: Boolean,
    default: false
  },
  checkedInAt: {
    type: Date
  }
});

const userSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: true
    },

    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true
    },

    password: {
      type: String
    },

    role: {
      type: String,
      default: "user"
    },

    provider: {
      type: String,
      default: "local"
    },

    googleId: String,
    linkedinId: String,

    /* ================= ATTENDEE PROFILE (website survey + iOS app) ================= */
    linkedinUrl:  { type: String, default: "" },
    fieldOfWork:  { type: String, default: "" },
    jobTitle:     { type: String, default: "" },
    organization: { type: String, default: "" },
    country:      { type: String, default: "" },
    topics:       { type: [String], default: [] },

    tickets: [ticketSchema],

    /* ================= PASSWORD RESET ================= */

    resetPasswordToken: String,

    resetPasswordExpires: Date
  },
  {
    timestamps: true
  }
);

const User = mongoose.model("User", userSchema);

export default User;