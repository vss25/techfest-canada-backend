import mongoose from "mongoose";

/* One entry in the Phase 3 admin audit log: who (staff) changed what,
   through the new modular Admin APIs. Written fire-and-forget by
   services/auditLog.js — an audit failure must never fail the request
   that caused it.

   This is deliberately separate from the older AdminAudit model
   (models/Admin.js), which the console/moderation side uses with a
   free-form action vocabulary ("view_messages", "ban_user", …). This
   log has a small fixed vocabulary (create|update|delete|login) and a
   resource/resourceId pair so the Admin panel can filter by module.
   Unifying the two is a follow-up decision, not part of this change. */
const adminAuditLogSchema = new mongoose.Schema({
  actorEmail: { type: String, default: "", index: true },
  actorId: { type: String, default: "" },
  action: {
    type: String,
    enum: ["create", "update", "delete", "login"],
    required: true,
  },
  resource: { type: String, required: true, index: true },   // e.g. "event", "ticket-type", "setting"
  resourceId: { type: String, default: "" },                  // eventKey, ticket type id, setting key…
  summary: { type: String, default: "", maxlength: 300 },     // one human line: "Updated event ttfc-2027-…"
  meta: { type: mongoose.Schema.Types.Mixed, default: undefined }, // small extras only (changed fields, counts)
  ip: { type: String, default: "" },
}, { timestamps: true });

adminAuditLogSchema.index({ createdAt: -1 });

export default mongoose.models.AdminAuditLog || mongoose.model("AdminAuditLog", adminAuditLogSchema);
