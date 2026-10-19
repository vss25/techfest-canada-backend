import {
  PERSON_TYPES, isStaff, typeInfo, publicTypes, cleanTypes, storedTypes, autoTypes, holdsPass, badgeTypes, legacyVip,
} from "./teamRoles.js";

/* =========================================================
   App rights: what each person type may do in the apps.
   Pure (no database), unit-tested in test/app-rights.test.js.
   The matrix is stored by services/rightsStore.js and edited in
   the admin panel (App → App rights, /api/console/app-rights).

   How one person's rights are worked out (effectiveRights):
   1. Their effective types (services/teamRoles.js); none = attendee.
   2. Abilities (sending, posting, groups, contact sharing, staff
      powers): allowed if ANY of their types allows it.
   3. Being contacted (receiveMessages, receiveRequests): allowed only
      if EVERY one of their types allows it (the most protective wins).
   4. Per-person switches: messagesOff → receiveMessages false,
      requestsOff → receiveRequests false.
   5. Staff accounts (role admin) always keep deleteAnyPost, moderate
      and checkIn, whatever the matrix says.
   6. Global app switches: flag.allow_posts off → post false,
      flag.allow_groups off → createGroups false (for everyone).
   VIP is a yes / no flag, not a type (Oct 19 2026): it has no column and
   changes no rights; a VIP gets the rights of their other types. The
   stored matrix's old "vip" column is dropped on start (services/vipFlag.js).
========================================================= */

export const RIGHTS = [
  "sendMessages", "receiveMessages", "sendRequests", "receiveRequests",
  "post", "comment", "startDiscussions", "createGroups", "shareContact",
  "deleteAnyPost", "moderate", "checkIn",
];

export const RIGHT_LABELS = {
  sendMessages: "Send messages",
  receiveMessages: "Receive messages",
  sendRequests: "Send connection requests",
  receiveRequests: "Receive connection requests",
  post: "Post in the feed",
  comment: "Comment",
  startDiscussions: "Start discussions",
  createGroups: "Create groups",
  shareContact: "Share contact details",
  deleteAnyPost: "Delete any post",
  moderate: "Moderate content",
  checkIn: "Check people in",
};

/** Combined with AND across someone's types (the most protective type wins). */
export const INBOUND_RIGHTS = ["receiveMessages", "receiveRequests"];
/** Always on for staff accounts (role admin). */
export const ADMIN_POWERS = ["deleteAnyPost", "moderate", "checkIn"];

const row = (on, off = []) => Object.fromEntries(RIGHTS.map((r) => [r, off.includes(r) ? false : on.includes(r)]));
const NETWORKING = ["sendMessages", "receiveMessages", "sendRequests", "receiveRequests"];
const COMMUNITY = ["post", "comment", "startDiscussions", "createGroups", "shareContact"];

export const DEFAULT_MATRIX = Object.freeze({
  attendee: row([...NETWORKING, ...COMMUNITY]),
  speaker: row([...NETWORKING, ...COMMUNITY]),
  exhibitor: row([...NETWORKING, ...COMMUNITY]),
  staff: row(RIGHTS),
  vendor: row(["sendMessages", "receiveMessages", "comment", "shareContact"]),
  volunteer: row([...NETWORKING, ...COMMUNITY, "checkIn"]),
});

/** A full matrix: every type × every right, stored values over the defaults (non-booleans ignored). */
export function mergeMatrix(stored) {
  const src = stored && typeof stored === "object" ? stored : {};
  const out = {};
  for (const t of PERSON_TYPES) {
    const col = src[t] && typeof src[t] === "object" ? src[t] : {};
    out[t] = {};
    for (const r of RIGHTS) out[t][r] = typeof col[r] === "boolean" ? col[r] : DEFAULT_MATRIX[t][r];
  }
  return out;
}

/**
 * Validates a matrix from the console (PUT /api/console/app-rights).
 * Unknown types or rights and non-boolean values are refused; anything left
 * out keeps its default. → { matrix } or { error }.
 */
export function cleanMatrix(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "matrix must be an object of types" };
  for (const [t, col] of Object.entries(input)) {
    if (!PERSON_TYPES.includes(t)) return { error: `Unknown type: ${t}` };
    if (!col || typeof col !== "object" || Array.isArray(col)) return { error: `${t} must be an object of rights` };
    for (const [r, v] of Object.entries(col)) {
      if (!RIGHTS.includes(r)) return { error: `Unknown right: ${r}` };
      if (typeof v !== "boolean") return { error: `${t}.${r} must be true or false` };
    }
  }
  return { matrix: mergeMatrix(input) };
}

/** What changed between two matrices, for the audit log: ["vendor.receiveMessages: off → on", …]. */
export function matrixChanges(before, after) {
  const a = mergeMatrix(before);
  const b = mergeMatrix(after);
  const out = [];
  for (const t of PERSON_TYPES) for (const r of RIGHTS) {
    if (a[t][r] !== b[t][r]) out.push(`${t}.${r}: ${a[t][r] ? "on" : "off"} → ${b[t][r] ? "on" : "off"}`);
  }
  return out;
}

/**
 * One person's rights.
 *   types  — their effective types (teamRoles.effectiveTypes); [] = attendee
 *   matrix — the stored matrix (merged with the defaults here)
 *   person — the User doc, for messagesOff / requestsOff and role admin
 *   flags  — { allowPosts, allowGroups } global app switches (false = off)
 * → { sendMessages: bool, … } with every key in RIGHTS.
 */
export function effectiveRights(types, matrix = DEFAULT_MATRIX, person = null, flags = {}) {
  const m = mergeMatrix(matrix);
  const list = (Array.isArray(types) ? types : []).filter((t) => PERSON_TYPES.includes(t));
  const cols = (list.length ? list : ["attendee"]).map((t) => m[t]);
  const out = {};
  for (const r of RIGHTS) out[r] = INBOUND_RIGHTS.includes(r) ? cols.every((c) => c[r]) : cols.some((c) => c[r]);
  if (person?.messagesOff) out.receiveMessages = false;
  if (person?.requestsOff) out.receiveRequests = false;
  if (isStaff(person)) for (const r of ADMIN_POWERS) out[r] = true;
  if (flags?.allowPosts === false) out.post = false;
  if (flags?.allowGroups === false) out.createGroups = false;
  return out;
}

/**
 * Everything about one account, from a loaded context
 * (services/rightsStore.js rightsContext(): { matrix, flags, exhibitors }).
 * → { types (effective, all), publicTypes, kind, booth, rights }
 */
export function personAccess(user, ctx = {}) {
  const info = typeInfo(user, ctx.exhibitors || null);
  return {
    ...info,
    // What other people see: their types plus the VIP badge (never rights).
    publicTypes: publicTypes(badgeTypes(info.types, info.vip)),
    rights: effectiveRights(info.types, ctx.matrix, user, ctx.flags),
  };
}

/** Rights only (see personAccess). */
export const rightsFor = (user, ctx = {}) => personAccess(user, ctx).rights;

/** The email an in-person connection sees: only if this person shares contact details
    (shareContact), never a ticket sign-in placeholder address. "" otherwise. */
export function sharedEmail(user, rights) {
  const email = String(user?.email || "").trim();
  if (!rights?.shareContact || !email || /@ticket\.thetechfestival\.com$/i.test(email)) return "";
  return email;
}

/** May this sender reach someone who switched contact off (staff accounts and moderators)? */
export const overridesContact = (sender, senderRights = null) => isStaff(sender) || !!senderRights?.moderate;

/* ================= REFUSALS ================= */

export const RIGHT_ERRORS = {
  sendMessages: "Your account can't send messages in the app.",
  sendRequests: "Your account can't send connection requests in the app.",
  post: "Your account can't post in the feed.",
  comment: "Your account can't comment in the app.",
  startDiscussions: "Your account can't start discussions in the app.",
  createGroups: "Your account can't create groups in the app.",
  moderate: "Your account can't moderate content.",
  checkIn: "Your account can't check people in.",
};
const FLAG_ERRORS = {
  post: "Posting in the feed is switched off right now.",
  createGroups: "New groups are switched off right now.",
};

/** The 403 line for a missing right (a global switch that's off gets its own line). */
export function rightError(right, flags = {}) {
  if (right === "post" && flags?.allowPosts === false) return FLAG_ERRORS.post;
  if (right === "createGroups" && flags?.allowGroups === false) return FLAG_ERRORS.createGroups;
  return RIGHT_ERRORS[right] || "Your account can't do that in the app.";
}

/**
 * Mongo filter for the accounts that may hold `right` under this matrix
 * (role admin always, for the staff powers). Callers check each one with
 * rightsFor; this only narrows the query. Used for report alerts (moderate).
 */
export function holdersQuery(right, matrix = DEFAULT_MATRIX) {
  const m = mergeMatrix(matrix);
  const types = PERSON_TYPES.filter((t) => m[t][right]);
  const or = [{ types: { $in: types } }];
  if (ADMIN_POWERS.includes(right) || types.includes("staff")) or.push({ role: "admin" });
  if (types.includes("volunteer")) or.push({ role: "volunteer" });
  // Pass-based types (and attendee, which anyone without a type gets) can be anyone.
  if (types.some((t) => ["attendee", "speaker", "exhibitor"].includes(t))) return { banned: { $ne: true } };
  return { banned: { $ne: true }, $or: or };
}

/* ================= ADMIN CONSOLE ================= */

/**
 * The person page's type details (GET /api/console/users/:id):
 *   types / typesOff — what staff stored
 *   autoTypes        — [{ type, from: "role" | "pass" }] they get without anyone choosing
 *                      (attendee aside: it's automatic only when `holdsPass` and no other type applies)
 *   effectiveTypes / rights — the result (services/teamRoles.js, effectiveRights above)
 *   vip / vipFrom    — the VIP flag and where it comes from: "account" (User.vip), "pass" (Attendee.vip), "" (not a VIP)
 */
export function consoleTypes(user, ctx = {}) {
  const booth = ctx.exhibitors ? ctx.exhibitors.boothFor(user) : null;
  const exhibitor = booth !== null;
  const acc = personAccess(user, ctx);
  const set = typeof user?.vip === "boolean";
  return {
    types: storedTypes(user?.types),
    typesOff: storedTypes(user?.typesOff),
    autoTypes: autoTypes(user, { exhibitor }),
    holdsPass: holdsPass(user, { exhibitor }),
    effectiveTypes: acc.types,
    rights: acc.rights,
    vip: acc.vip,
    vipFrom: !acc.vip ? "" : set || legacyVip(user) ? "account" : "pass",
  };
}

/** A console edit of the VIP flag ({ vip: true | false }) → { set: { vip }, note } | { set: {} } | { error, status }. */
export function vipEdit(user, body = {}, { vipPass = false } = {}) {
  if (body?.vip === undefined) return { set: {} };
  if (typeof body.vip !== "boolean") return { status: 400, error: "vip must be true or false" };
  const before = isVipNow(user, vipPass);
  if (typeof user?.vip === "boolean" && user.vip === body.vip) return { set: {} };
  return { set: { vip: body.vip }, note: `VIP: ${before ? "Yes" : "No"} → ${body.vip ? "Yes" : "No"}` };
}
const isVipNow = (user, vipPass) => (typeof user?.vip === "boolean" ? user.vip : legacyVip(user) || !!vipPass);

const TEAM_TYPES = ["staff", "volunteer"];

/**
 * A console edit of `types` / `typesOff` (PATCH /api/console/users/:id).
 * → { set: { types?, typesOff? }, note } or { error, status }.
 * Giving or taking away the staff or volunteer type (stored or switched off)
 * is management only, like changing someone's role.
 */
export function typesEdit(user, body = {}, { management = false } = {}) {
  const set = {};
  for (const k of ["types", "typesOff"]) {
    if (body?.[k] === undefined) continue;
    const v = cleanTypes(body[k]);
    if (!v) {
      const vip = Array.isArray(body[k]) && body[k].some((t) => String(t ?? "").trim().toLowerCase() === "vip");
      return { status: 400, error: vip ? "VIP is a yes / no switch now, not a type. Use the VIP switch." : `${k} must be a list of: ${PERSON_TYPES.join(", ")}` };
    }
    const before = storedTypes(user?.[k]);
    if (JSON.stringify(before) === JSON.stringify(v)) continue;
    const team = TEAM_TYPES.some((t) => before.includes(t) !== v.includes(t));
    if (team && !management) return { status: 403, error: "Only management can give or take away the staff and volunteer types" };
    set[k] = v;
  }
  const note = Object.entries(set).map(([k, v]) => `${k}: ${storedTypes(user?.[k]).join(", ") || "none"} → ${v.join(", ") || "none"}`).join("; ");
  return { set, note };
}

/**
 * Mongo filter narrowing the People list to accounts that may have `type`
 * (null for an unknown type). The route then keeps only exact matches,
 * since pass-based types need the exhibitor index.
 */
export function typeCandidates(type) {
  switch (type) {
    case "vendor": return { types: type };
    case "staff": return { $or: [{ role: "admin" }, { types: "staff" }] };
    case "volunteer": return { $or: [{ role: "volunteer" }, { types: "volunteer" }] };
    // Speakers' passes: the marker (Power Passes since Oct 19 2026) or the old "speaker" ticket type.
    case "speaker": return { $or: [{ types: "speaker" }, { "tickets.speakerPass": true }, { "tickets.type": { $regex: "^speaker$", $options: "i" } }] };
    case "exhibitor": case "attendee": return {};
    default: return null;
  }
}
