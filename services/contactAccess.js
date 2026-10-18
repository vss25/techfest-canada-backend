import { SocialConnection, SocialMessage } from "../models/Social.js";
import { contactFlags } from "./contactSwitches.js";

/* Viewer-aware contact flags for user cards. userCard() gives the raw switch
   (acceptsMessages: !messagesOff); this corrects it for the person looking, so
   someone connected to a VIP (or written to by one) still sees a Message button
   and staff always do. Costs two small queries, and only when a switched-off
   person is in the list. */

/** Map of id → { acceptsMessages, acceptsRequests } for the switched-off people in `users`. */
export async function contactAccess(viewer, users) {
  const off = (users || []).filter((u) => u && (u.messagesOff || u.requestsOff));
  const out = new Map();
  if (!off.length || !viewer) return out;
  const me = viewer._id;
  const ids = off.filter((u) => u.messagesOff).map((u) => u._id);
  const [conns, wrote] = ids.length && viewer.role !== "admin"
    ? await Promise.all([
      SocialConnection.find({ status: "accepted", $or: [{ fromUserId: me, toUserId: { $in: ids } }, { fromUserId: { $in: ids }, toUserId: me }] })
        .select("fromUserId toUserId").lean(),
      SocialMessage.distinct("fromUserId", { fromUserId: { $in: ids }, toUserId: me }),
    ])
    : [[], []];
  const connected = new Set(conns.map((c) => String(String(c.fromUserId) === String(me) ? c.toUserId : c.fromUserId)));
  const wroteFirst = new Set(wrote.map(String));
  for (const u of off) {
    const id = String(u._id);
    out.set(id, contactFlags({ viewer, user: u, connected: connected.has(id), theyWroteFirst: wroteFirst.has(id) }));
  }
  return out;
}

/** Card (or directory entry) with the viewer's flags applied. */
export function applyAccess(card, access) {
  if (!card || !access?.has(String(card.id))) return card;
  return { ...card, ...access.get(String(card.id)) };
}
