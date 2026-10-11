import mongoose from "mongoose";

/* One row per website form submission: volunteer, speaker, booth (exhibit),
   sponsor, partnership and general enquiries. Saved before any email goes
   out (routes/forms.js), so nothing is lost to a mail failure. Field rules:
   services/formSubmissions.js. Before Oct 2026 these went through EmailJS
   only; rows recovered from its history have source "recovered". */
const str = { type: String, default: "" };

const formSubmissionSchema = new mongoose.Schema({
  form: { type: String, required: true, enum: ["volunteer", "speaker", "exhibit", "sponsor", "partnership", "inquiry"] },

  // Who
  name: str, firstName: str, lastName: str,
  email: str, phone: str, company: str, jobTitle: str,
  message: str,
  // Everything else the form sent (roles, booth, LinkedIn…), as short text
  fields: { type: mongoose.Schema.Types.Mixed, default: {} },

  // Where from (no IP addresses)
  page: str, referrer: str, userAgent: str,
  fillMs: Number, // how long the form was open
  source: { type: String, enum: ["website", "recovered"], default: "website" },

  // Staff
  status: { type: String, enum: ["new", "contacted", "accepted", "declined", "archived"], default: "new" },
  notes: str,
  updatedBy: str,
  statusChangedAt: Date,

  // Email to FORMS_INBOX: sending → sent | failed; blocked = bot; skipped = recovered row, never emailed
  emailStatus: { type: String, enum: ["sending", "sent", "failed", "blocked", "skipped"] },
  emailTo: { type: [String], default: undefined },
  emailedAt: Date,
  emailId: str,
  emailError: str,

  // Bot (honeypot / random text / instant fill): kept for review, never emailed, hidden in the admin list
  spam: { type: Boolean, default: false },
  spamReason: str,
}, { timestamps: true, minimize: false });

formSubmissionSchema.index({ createdAt: -1 });
formSubmissionSchema.index({ form: 1, createdAt: -1 });
formSubmissionSchema.index({ email: 1 });

export default mongoose.models.FormSubmission || mongoose.model("FormSubmission", formSubmissionSchema);
