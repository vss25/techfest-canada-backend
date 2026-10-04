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
  },
  // Set when a pass is upgraded in place (same ticketId, new type).
  upgradedFrom: {
    type: String
  },
  // The Stripe Checkout Session this ticket came from (one session = one ticket).
  stripeSessionId: {
    type: String
  },
  // Hidden from staff lists/analytics only (test or duplicate tickets). Still valid for the owner.
  hiddenByStaff: {
    type: Boolean,
    default: false
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
    directoryHidden: { type: Boolean, default: false }, // opt out of the app's attendee list
    banned:       { type: Boolean, default: false },      // set from the admin console
    bannedReason: { type: String, default: "" },
    lastActiveAt: { type: Date },
    appOnboarded: { type: Boolean, default: false },      // finished the app's profile steps once
    // Everything else the app's profile collects (editable from the admin panel too).
    tagline:      { type: String, default: "" },          // short line under the name
    salutation:   { type: String, default: "" },
    gender:       { type: String, default: "" },
    jobLevel:     { type: String, default: "" },
    objectives:   { type: [String], default: [] },        // what they want from TTFC
    availabilitySlots: { type: [String], default: [] },   // when they're free to meet
    meetingSpot:  { type: String, default: "" },
    avatarData:   { type: String, default: "", select: false }, // data:image/jpeg;base64,… (≤150 KB)
    avatarVersion: { type: Number, default: 0 },           // bumps on change; 0 = no photo

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