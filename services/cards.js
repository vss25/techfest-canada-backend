import { userCard } from "./socialHelpers.js";
import { contactAccess, applyAccess } from "./contactAccess.js";
import { loadExhibitors, clearExhibitorCache } from "./exhibitorCache.js";
import { loadMatrix } from "./rightsStore.js";

/* User cards as the signed-in viewer sees them: contact flags from each
   person's receive rights, corrected for the viewer (services/contactAccess.js),
   their public types and the Network kind/booth (services/teamRoles.js). */

// Exhibitor passes are cached for a minute (services/exhibitorCache.js).
export { loadExhibitors, clearExhibitorCache };

/** Cards for `users` (null entries stay null) as `viewer` sees them. */
export async function cardsFor(viewer, users) {
  const list = (users || []).filter(Boolean);
  const [exhibitors, matrix] = await Promise.all([loadExhibitors(), loadMatrix()]);
  const access = await contactAccess(viewer, list, { exhibitors, matrix });
  const me = String(viewer?._id || viewer?.id || "");
  return (users || []).map((u) => (u ? applyAccess(userCard(u, { exhibitors, matrix, self: !!me && String(u._id || u.id) === me }), access) : null));
}
