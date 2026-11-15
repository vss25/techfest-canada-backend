import AdminAuditLog from "../models/AdminAuditLog.js";

/* Fire-and-forget audit recording for the modular Admin APIs (Phase 3).
   Call AFTER the mutation has succeeded:

     recordAudit(req, "update", "event", event.eventKey,
                 `Updated event ${event.eventKey}`, { fields: ["status"] });

   It never throws and never blocks the response: the write is started
   and its errors are swallowed (logged to the server console only).
   `req.user` at this point is the staff User document (requireAdmin in
   middleware/adminAuth.js replaces the token payload with it), but the
   JWT shape ({ id, email }) is tolerated too. */

const MAX_META_BYTES = 2000;

function smallMeta(meta) {
  if (meta === undefined || meta === null) return undefined;
  try {
    if (JSON.stringify(meta).length > MAX_META_BYTES) return { truncated: true };
  } catch {
    return { unserializable: true };
  }
  return meta;
}

export function recordAudit(req, action, resource, resourceId, summary, meta) {
  try {
    const user = req?.user || {};
    const entry = {
      actorEmail: String(user.email || ""),
      actorId: String(user._id || user.id || ""),
      action,
      resource: String(resource || ""),
      resourceId: resourceId === undefined || resourceId === null ? "" : String(resourceId),
      summary: String(summary || "").slice(0, 300),
      meta: smallMeta(meta),
      ip: String(req?.ip || "").slice(0, 100),
    };
    AdminAuditLog.create(entry).catch((err) => {
      console.error("auditLog write failed:", err?.message || err);
    });
  } catch (err) {
    console.error("auditLog write failed:", err?.message || err);
  }
}

export default recordAudit;
