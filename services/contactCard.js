import { randomBytes } from "node:crypto";

/* =========================================================
   Contact card: the ways someone can be reached (User.contactItems)
   and what they share with each connection (SocialConnection
   fromShare / toShare). Pure (no database), unit-tested in
   test/contact-card.test.js. Routes: routes/social.js.

   Item: { id, kind, label, value, shareByDefault, account? }
     kind    one of CONTACT_KINDS
     label   optional ("Work", "Personal"), ≤ 30 characters
     value   checked and tidied per kind (cleanValue)
     account true = the sign-in email: its value is never stored,
             it's read from User.email every time (never a
             @ticket.thetechfestival.com placeholder)
   At most MAX_CONTACT_ITEMS. Until someone saves their card
   (contactCardSavedAt), their items are worked out from the
   profile: the account email and the profile LinkedIn, both
   shared by default (what a badge scan shared before this).

   What a side shares with a connection: the item ids it picked
   (resolved live against its current items, so an edited value
   updates and a deleted item disappears). A side that never
   picked shares its "share by default" items on an in-person
   (badge scan) connection, as before, and nothing on an online
   one. Only accepted connections show anything, and only while
   the sharer's types have the shareContact right.
========================================================= */

export const CONTACT_KINDS = ["email", "phone", "whatsapp", "linkedin", "website", "x", "instagram", "wechat", "other"];
export const MAX_CONTACT_ITEMS = 12;
export const MAX_LABEL = 30;
const MAX_OTHER = 200;
const ID_RX = /^[A-Za-z0-9_-]{1,40}$/;
const PLACEHOLDER_RX = /@ticket\.thetechfestival\.com$/i;

/** Fields the contact helpers read from a User. */
export const CONTACT_SELECT = "email linkedinUrl contactItems contactCardSavedAt contactQrShare";

export const SHARE_OFF_ERROR = "Contact sharing is off for your pass type.";
export const TOO_MANY_ERROR = `You can add up to ${MAX_CONTACT_ITEMS} contact details.`;

const ERRORS = {
  kind: "Pick what kind of contact detail this is.",
  email: "Enter a valid email address.",
  phone: "Enter a phone number with 6 to 15 digits. A + and the country code are fine.",
  whatsapp: "Enter your WhatsApp number with 6 to 15 digits. A + and the country code are fine.",
  linkedin: "Enter a LinkedIn link, like linkedin.com/in/yourname.",
  website: "Enter a website address, like example.com.",
  x: "Enter an X handle, like @yourname.",
  instagram: "Enter an Instagram handle, like @yourname.",
  wechat: "Enter your WeChat ID (letters, numbers, - and _).",
  other: "Enter the contact detail.",
};

export const newItemId = () => randomBytes(6).toString("base64url");

/** Collapses whitespace and drops control characters. */
const tidy = (s) => String(s ?? "").replace(/[\u0000-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim();

export const isPlaceholderEmail = (e) => PLACEHOLDER_RX.test(String(e || "").trim());

/** The sign-in email as a contact detail ("" for none or a ticket sign-in placeholder). */
export function accountEmailOf(user) {
  const e = String(user?.email || "").trim().toLowerCase();
  return !e || isPlaceholderEmail(e) ? "" : e;
}

/** Strips a scheme, "www." / country subdomains and a trailing slash: "https://ca.linkedin.com/in/x/" → { host: "linkedin.com", path: "in/x" }. */
function splitUrlish(raw) {
  let s = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  s = s.split(/[?#]/)[0];
  const slash = s.indexOf("/");
  const host = (slash < 0 ? s : s.slice(0, slash)).toLowerCase();
  const path = (slash < 0 ? "" : s.slice(slash + 1)).replace(/\/+$/, "");
  return { host, path };
}

const HANDLE = {
  x: { rx: /^[A-Za-z0-9_]{1,15}$/, hosts: ["x.com", "twitter.com", "mobile.twitter.com", "www.x.com", "www.twitter.com"] },
  instagram: { rx: /^[A-Za-z0-9._]{1,30}$/, hosts: ["instagram.com", "www.instagram.com", "instagr.am"] },
};

function cleanHandle(kind, raw) {
  const { rx, hosts } = HANDLE[kind];
  let s = raw;
  if (/[./]/.test(s) && !/^@/.test(s)) {
    const { host, path } = splitUrlish(s);
    if (hosts.includes(host)) s = path.split("/")[0];
    else if (kind === "instagram" && !s.includes("/") && rx.test(s)) s = raw;   // dots are fine in Instagram names
    else return null;
  }
  s = s.replace(/^@+/, "");
  return rx.test(s) ? `@${s}` : null;
}

function cleanLinkedIn(raw) {
  const s = raw;
  if (/\s/.test(s)) return null;
  let path;
  if (/linkedin\.com/i.test(s)) {
    const { host, path: p } = splitUrlish(s);
    if (!/^([a-z]{2,3}\.|www\.)?linkedin\.com$/.test(host)) return null;
    path = p;
  } else if (/^(in|company|school|pub|showcase)\/[^/\s]+\/?$/i.test(s)) {
    path = s.replace(/\/$/, "");
  } else if (/^@?[A-Za-z0-9_%-]{3,100}$/.test(s)) {
    path = `in/${s.replace(/^@/, "")}`;
  } else return null;
  if (!/^(in|company|school|pub|showcase)\/[^/\s]+(\/[^\s]*)?$/i.test(path)) return null;
  return `https://www.linkedin.com/${path}`;
}

function cleanWebsite(raw) {
  if (/\s/.test(raw) || raw.length > 300) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  let u;
  try { u = new URL(withScheme); } catch { return null; }
  if (!["http:", "https:"].includes(u.protocol) || u.username || u.password) return null;
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i.test(u.hostname) && !/^xn--/.test(u.hostname)) return null;
  const href = u.href;
  return u.pathname === "/" && !u.search && !u.hash ? href.replace(/\/$/, "") : href;
}

function cleanPhone(raw) {
  const s = raw.replace(/\s+/g, " ");
  if (!/^\+?[\d ().-]+$/.test(s)) return null;
  const digits = s.replace(/\D/g, "");
  if (digits.length < 6 || digits.length > 15) return null;
  return s;
}

/**
 * One value, checked and tidied for its kind.
 * → { value } or { error } (a sentence the apps can show as it is).
 */
export function cleanValue(kind, raw) {
  if (!CONTACT_KINDS.includes(kind)) return { error: ERRORS.kind };
  const s = tidy(raw);
  if (!s) return { error: ERRORS[kind] };
  let v = null;
  switch (kind) {
    case "email": {
      const e = s.toLowerCase();
      v = e.length <= 254 && /^[^\s@<>()",;:\\[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/.test(e) ? e : null;
      break;
    }
    case "phone": case "whatsapp": v = cleanPhone(s); break;
    case "linkedin": v = cleanLinkedIn(s); break;
    case "website": v = cleanWebsite(s); break;
    case "x": case "instagram": v = cleanHandle(kind, s); break;
    case "wechat": {
      const w = s.replace(/^@/, "");
      v = /^[A-Za-z0-9_-]{2,40}$/.test(w) ? w : null;
      break;
    }
    case "other": v = s.length <= MAX_OTHER ? s : null; break;
  }
  return v ? { value: v } : { error: ERRORS[kind] };
}

export const cleanLabel = (raw) => tidy(raw).slice(0, MAX_LABEL);

/**
 * The list from PUT /api/social/contact-card.
 *   accountEmail — accountEmailOf(user): an `account: true` item is dropped without one
 * → { items } (ready to store: account items keep value "") or { error, index }.
 * Ids that are missing, malformed or repeated get a new one. One account item at most.
 */
export function cleanItems(input, { accountEmail = "" } = {}) {
  if (!Array.isArray(input)) return { error: "items must be a list" };
  if (input.length > MAX_CONTACT_ITEMS) return { error: TOO_MANY_ERROR };
  const items = [];
  const ids = new Set();
  let hasAccount = false;
  for (let index = 0; index < input.length; index++) {
    const raw = input[index];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: "Each contact detail must be an object.", index };
    let id = typeof raw.id === "string" && ID_RX.test(raw.id) ? raw.id : "";
    if (!id || ids.has(id)) id = newItemId();
    const shareByDefault = raw.shareByDefault === true;
    if (raw.account === true) {
      if (!accountEmail || hasAccount) continue;
      hasAccount = true;
      ids.add(id);
      items.push({ id, kind: "email", label: cleanLabel(raw.label), value: "", shareByDefault, account: true });
      continue;
    }
    const kind = String(raw.kind || "");
    const v = cleanValue(kind, raw.value);
    if (v.error) return { error: v.error, index };
    ids.add(id);
    items.push({ id, kind, label: cleanLabel(raw.label), value: v.value, shareByDefault });
  }
  return { items };
}

/**
 * Someone's contact details as they see them (and as shares resolve against):
 * saved items with the account email filled in, or, before they ever saved,
 * the account email and profile LinkedIn (ids "account" / "linkedin", shared by default).
 */
export function contactItemsFor(user) {
  if (!user) return [];
  const accountEmail = accountEmailOf(user);
  if (user.contactCardSavedAt && Array.isArray(user.contactItems)) {
    const out = [];
    for (const it of user.contactItems) {
      if (!it?.id) continue;
      if (it.account) {
        if (accountEmail) out.push({ id: it.id, kind: "email", label: it.label || "", value: accountEmail, shareByDefault: !!it.shareByDefault, account: true });
      } else if (CONTACT_KINDS.includes(it.kind) && it.value) {
        out.push({ id: it.id, kind: it.kind, label: it.label || "", value: it.value, shareByDefault: !!it.shareByDefault });
      }
    }
    return out;
  }
  const out = [];
  if (accountEmail) out.push({ id: "account", kind: "email", label: "", value: accountEmail, shareByDefault: true, account: true });
  const li = user.linkedinUrl ? cleanValue("linkedin", user.linkedinUrl) : null;
  if (li?.value) out.push({ id: "linkedin", kind: "linkedin", label: "", value: li.value, shareByDefault: true });
  return out;
}

/**
 * What people who scan this person's connect QR get: the ids picked on the QR sheet
 * (contactQrShare, resolved live), else the share-by-default items. → { ids, picked }.
 */
export function qrShareOf(user) {
  const items = contactItemsFor(user);
  if (Array.isArray(user?.contactQrShare)) {
    const want = new Set(user.contactQrShare.map(String));
    return { ids: items.filter((it) => want.has(it.id)).map((it) => it.id), picked: true };
  }
  return { ids: items.filter((it) => it.shareByDefault).map((it) => it.id), picked: false };
}

/**
 * A badge / connect QR scan: the person scanned (`target`) hadn't picked for this connection,
 * so they share what their QR sheet says (a copy, so a later QR change leaves this connection alone).
 * → true when it set something. Never without their shareContact right.
 */
export function applyQrShare(connection, target, targetRights) {
  if (!targetRights?.shareContact || !Array.isArray(target?.contactQrShare)) return false;
  if (pickedShare(connection, target._id).picked) return false;
  return setShare(connection, target._id, qrShareOf(target).ids);
}

/** What the person themself gets back (GET / PUT /api/social/contact-card). */
export function contactCardDTO(user, rights) {
  const qr = qrShareOf(user);
  return {
    qrShare: qr.ids,
    qrSharePicked: qr.picked,
    items: contactItemsFor(user),
    accountEmail: accountEmailOf(user),
    canShare: !!rights?.shareContact,
    saved: !!user?.contactCardSavedAt,
    max: MAX_CONTACT_ITEMS,
    kinds: CONTACT_KINDS,
  };
}

/** A shared item as the other person sees it: never the id or the defaults. */
export const sharedItemDTO = (it) => ({ kind: it.kind, label: it.label || "", value: it.value });

/**
 * A share list from the apps: only ids of the sharer's current items, once each,
 * in the sharer's order. null when `input` isn't a list (nothing to change).
 */
export function cleanShareIds(input, items) {
  if (!Array.isArray(input)) return null;
  const want = new Set(input.filter((x) => typeof x === "string"));
  return (items || []).filter((it) => want.has(it.id)).map((it) => it.id);
}

/** Which side of a connection `userId` is: "from" (sent the request / scanned) or "to". null when neither. */
export function sideOf(connection, userId) {
  const id = String(userId);
  if (String(connection?.fromUserId) === id) return "from";
  if (String(connection?.toUserId) === id) return "to";
  return null;
}

/** What `userId` picked for this connection: { picked, ids } (ids as stored, unresolved). */
export function pickedShare(connection, userId) {
  const side = sideOf(connection, userId);
  const ids = side ? connection?.[`${side}Share`] : undefined;
  return Array.isArray(ids) ? { picked: true, ids: ids.map(String) } : { picked: false, ids: [] };
}

/** Stores `ids` as what `userId` shares on this connection (a mongoose doc or a plain object). → true when set. */
export function setShare(connection, userId, ids, now = new Date()) {
  const side = sideOf(connection, userId);
  if (!side) return false;
  connection[`${side}Share`] = [...ids];
  connection[`${side}ShareAt`] = now;
  return true;
}

/**
 * The item ids `sharer` shares (or will share, once accepted) on this connection, resolved
 * against their current items: what they picked, else their defaults on an in-person
 * connection, else nothing. [] without the shareContact right.
 */
export function effectiveShareIds(connection, sharer, sharerRights) {
  if (!connection || !sharer || !sharerRights?.shareContact) return [];
  const items = contactItemsFor(sharer);
  const { picked, ids } = pickedShare(connection, sharer._id);
  if (picked) {
    const want = new Set(ids);
    return items.filter((it) => want.has(it.id)).map((it) => it.id);
  }
  return connection.kind === "inPerson" ? items.filter((it) => it.shareByDefault).map((it) => it.id) : [];
}

/**
 * What `sharer` shares with the other side of an accepted connection: [{ kind, label, value }].
 * Empty for pending / declined rows, blocks, or without the sharer's shareContact right.
 */
export function sharedContactFrom(connection, sharer, sharerRights, { blocked = false } = {}) {
  if (blocked || connection?.status !== "accepted") return [];
  const ids = new Set(effectiveShareIds(connection, sharer, sharerRights));
  return contactItemsFor(sharer).filter((it) => ids.has(it.id)).map(sharedItemDTO);
}

/**
 * The share fields on a connection or person payload for `viewer`:
 *   sharedContact — what the other person shares with the viewer (accepted only)
 *   myShare       — the ids the viewer shares with them now (resolved)
 *   mySharePicked — whether the viewer ever picked for this connection (else defaults apply)
 */
export function shareFields(connection, { viewer, viewerRights, other, otherRights, blocked = false }) {
  if (!connection) return { sharedContact: [], myShare: [], mySharePicked: false };
  return {
    sharedContact: sharedContactFrom(connection, other, otherRights, { blocked }),
    myShare: effectiveShareIds(connection, viewer, viewerRights),
    mySharePicked: pickedShare(connection, viewer?._id).picked,
  };
}

/** The old `email` field (in-person rows only, for older app builds): the first shared email. */
export const legacyEmail = (shared) => (shared || []).find((it) => it.kind === "email")?.value || "";

/** First LinkedIn item's value ("" when none): kept in step with the profile LinkedIn (User.linkedinUrl). */
export const firstLinkedIn = (items) => (items || []).find((it) => it.kind === "linkedin" && it.value)?.value || "";

/**
 * The profile LinkedIn changed (PATCH /api/profile): the same change on a saved card's
 * first LinkedIn item (added when there's none and room; removed when cleared).
 * → the new stored list, or null when nothing changes (never saved, or the same).
 */
export function syncLinkedInItem(user, linkedinUrl) {
  if (!user?.contactCardSavedAt || !Array.isArray(user.contactItems)) return null;
  const items = user.contactItems.map((it) => ({ id: it.id, kind: it.kind, label: it.label || "", value: it.value || "", shareByDefault: !!it.shareByDefault, ...(it.account ? { account: true } : {}) }));
  const i = items.findIndex((it) => it.kind === "linkedin" && !it.account);
  const v = linkedinUrl ? cleanValue("linkedin", linkedinUrl).value : "";
  if (!linkedinUrl) {
    if (i < 0) return null;
    items.splice(i, 1);
    return items;
  }
  if (!v) return null;   // not a LinkedIn link we can use: leave the card alone
  if (i >= 0) {
    if (items[i].value === v) return null;
    items[i].value = v;
    return items;
  }
  if (items.length >= MAX_CONTACT_ITEMS) return null;
  items.push({ id: newItemId(), kind: "linkedin", label: "", value: v, shareByDefault: true });
  return items;
}
