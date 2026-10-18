import { SocialConnection, SocialMessage } from "../models/Social.js";
import { contactFlags } from "./contactSwitches.js";
import { rightsFor, overridesContact } from "./appRights.js";

/* Viewer-aware contact flags for user cards. userCard() gives the person's
   own receive rights (types + staff switches); this corrects them for the
   person looking, so someone connected to a VIP (or written to by one) still
   sees a Message button and staff / moderators always do. Costs two small
   queries, and only when someone who can't be contacted is in the list.
   `ctx`: { exhibitors, matrix } (services/rightsStore.js; defaults when left out). */

/** Map of id → { acceptsMessages, acceptsRequests } for the people in `users` who don't take messages or requests. */
export async function contactAccess(viewer, users, ctx = {}) {
  const out = new Map();
  if (!viewer) return out;
  const off = [];
  for (const u of users || []) {
    if (!u) continue;
    const rights = rightsFor(u, ctx);
    if (!rights.receiveMessages || !rights.receiveRequests) off.push({ u, rights });
  }
  if (!off.length) return out;
  const viewerRights = rightsFor(viewer, ctx);
  const me = viewer._id;
  const ids = off.filter((o) => !o.rights.receiveMessages).map((o) => o.u._id);
  const [conns, wrote] = ids.length && !overridesContact(viewer, viewerRights)
    ? await Promise.all([
      SocialConnection.find({ status: "accepted", $or: [{ fromUserId: me, toUserId: { $in: ids } }, { fromUserId: { $in: ids }, toUserId: me }] })
        .select("fromUserId toUserId").lean(),
      SocialMessage.distinct("fromUserId", { fromUserId: { $in: ids }, toUserId: me }),
    ])
    : [[], []];
  const connected = new Set(conns.map((c) => String(String(c.fromUserId) === String(me) ? c.toUserId : c.fromUserId)));
  const wroteFirst = new Set(wrote.map(String));
  for (const { u, rights } of off) {
    const id = String(u._id);
    out.set(id, contactFlags({ viewer, user: u, viewerRights, userRights: rights, connected: connected.has(id), theyWroteFirst: wroteFirst.has(id) }));
  }
  return out;
}

/** Card (or directory entry) with the viewer's flags applied. */
export function applyAccess(card, access) {
  if (!card || !access?.has(String(card.id))) return card;
  return { ...card, ...access.get(String(card.id)) };
}
