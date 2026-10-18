import mongoose from "mongoose";
import { PERSON_TYPES } from "../services/teamRoles.js";
import { CONTACT_KINDS } from "../services/contactCard.js";

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
  // Everything the buyer filled in on the checkout form (job, company, topics…)
  details: {
    type: mongoose.Schema.Types.Mixed
  },
  // Promo code used at checkout ("" = none).
  promoCode: {
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

    // For staff (role "admin"): "management" sees sales/revenue/pricing and manages
    // staff; "staff" doesn't. Unset = management (accounts made before this existed).
    staffRole: {
      type: String,
      enum: ["management", "staff"]
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
    // Staff-set logo for this person only (Admin → People); "" = their company's default (models/Company.js).
    companyLogoUrl: { type: String, default: "" },
    country:      { type: String, default: "" },
    topics:       { type: [String], default: [] },
    directoryHidden: { type: Boolean, default: false }, // opt out of the app's attendee list
    hideFromLeaderboard: { type: Boolean, default: false }, // opt out of the points leaderboard (still earns points)
    // Staff switches for VIPs who won't reply (services/contactSwitches.js). Staff,
    // accepted connections and people they wrote to can still message them.
    messagesOff:  { type: Boolean, default: false },      // no new 1:1 messages from others
    requestsOff:  { type: Boolean, default: false },      // no new connection requests (badge scan still works)
    // Person types set by staff (services/teamRoles.js): attendee speaker exhibitor vip staff vendor volunteer.
    // Effective types = these ∪ automatic ones (role, passes) − typesOff; they pick the app rights
    // column(s) in services/appRights.js. typesOff is the only way to switch an automatic type off.
    types:        { type: [{ type: String, enum: PERSON_TYPES }], default: [] },
    typesOff:     { type: [{ type: String, enum: PERSON_TYPES }], default: [] },
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
    // Contact card (services/contactCard.js): the ways people can reach them, ≤ 12, in their order.
    // `account: true` = the sign-in email (value never stored, read from `email`). Shared per
    // connection (SocialConnection fromShare / toShare). Unset contactCardSavedAt = never saved:
    // the card is then worked out from email + linkedinUrl.
    contactItems: { type: [{ _id: false, id: String, kind: { type: String, enum: CONTACT_KINDS }, label: String,
                             value: String, shareByDefault: Boolean, account: Boolean }], default: [] },
    contactCardSavedAt: { type: Date },
    // When they last opened each tab's activity (likes, comments, mentions, replies).
    activitySeen: { feed: { type: Date }, discussions: { type: Date } },
    avatarData:   { type: String, default: "", select: false }, // data:image/jpeg;base64,… (≤150 KB)
    avatarVersion: { type: Number, default: 0 },           // bumps on change; 0 = no photo
    // Consent recorded by the apps (server-stamped): 18+ self-confirmation and
    // the version of the app Terms / Privacy Policy they accepted.
    ageConfirmedAt:  { type: Date },
    termsAcceptedAt: { type: Date },
    termsVersion:    { type: String, default: "" },
    // Apple push tokens for this person's phones (newest last, max 5).
    apnsTokens:   { type: [{ token: String, env: String, updatedAt: Date }], default: [], select: false },
    // Android (FCM) registration tokens, same rules (newest last, max 5).
    fcmTokens:    { type: [{ token: String, updatedAt: Date }], default: [], select: false },

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