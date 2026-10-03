/* "Who's typing" for the iOS app's group chat, discussions and comments.
   In memory on purpose: it's a few seconds of presence, not data. On a
   single Render instance this is exact; behind several instances it
   degrades to "sometimes missing", never to wrong data. */

const TTL_MS = 6000;
const SCOPES = new Set(["group", "discussion", "post"]);
const rooms = new Map(); // "scope:id" -> Map(userId -> { name, at })

export function isScope(s) { return SCOPES.has(s); }

export function markTyping(scope, id, userId, name, now = Date.now()) {
  const key = `${scope}:${id}`;
  if (!rooms.has(key)) rooms.set(key, new Map());
  rooms.get(key).set(String(userId), { name: String(name || "Someone"), at: now });
}

export function stopTyping(scope, id, userId) {
  rooms.get(`${scope}:${id}`)?.delete(String(userId));
}

/** Names typing in a room in the last few seconds, excluding `viewerId`. */
export function whoIsTyping(scope, id, viewerId, now = Date.now()) {
  const room = rooms.get(`${scope}:${id}`);
  if (!room) return [];
  const out = [];
  for (const [uid, v] of room) {
    if (now - v.at > TTL_MS) { room.delete(uid); continue; }
    if (uid !== String(viewerId)) out.push(v.name);
  }
  if (!room.size) rooms.delete(`${scope}:${id}`);
  return out.slice(0, 5);
}
