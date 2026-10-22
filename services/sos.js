import { Resend } from "resend";
import User from "../models/User.js";
import { pushToUsers } from "./push.js";
import { personAccess } from "./appRights.js";
import { rightsContext, RIGHTS_SELECT } from "./rightsStore.js";
import { frontendUrl } from "./profileRequest.js";
import { escapeHtml as esc } from "./ticketInfo.js";
import { ENQUIRE_EMAIL, FROM } from "./appInviteEmail.js";
import { usableEmail } from "./attendingCampaign.js";

/* =========================================================
   Help & SOS (Oct 22 2026)
   ---------------------------------------------------------
   The organiser: "Add a help/SOS section in the app. Allow the
   ability to send messages through the section which staff can see
   and will be able to get to the attendee. Indicate this is for
   emergency only, not for regular requests."
   An attendee's request (models/SosRequest.js) alerts every
   responder at once: a push to each staff account (role admin) and
   each account with the moderate right (the staff person type, so
   volunteers with it too), always (no notification switch, no
   throttle, sent even when the sender is hidden from the app), and
   an email to SOS_ALERT_TO (comma list; default enquire@) from
   enquire@. Staff replies push to the attendee. Nothing here logs
   what anyone wrote. Pure helpers exported for tests; the senders
   never throw.
========================================================= */

export const CATEGORIES = Object.freeze([
  { key: "medical", label: "Medical" },
  { key: "safety", label: "Safety or security" },
  { key: "lost", label: "Lost or separated" },
  { key: "accessibility", label: "Accessibility help" },
  { key: "other", label: "Other urgent" },
].map((c) => Object.freeze(c)));
export const CATEGORY_KEYS = Object.freeze(CATEGORIES.map((c) => c.key));
export const LOCATIONS = Object.freeze(["Harbour Ballroom", "Harbour Ballroom foyer", "Pier 4 & 5", "Registration desk", "Expo floor", "Hotel lobby"]);
export const STATUS_LABELS = Object.freeze({ open: "Sent", acknowledged: "Seen by staff", resolved: "Resolved" });
export const MESSAGE_MAX = 1000;
export const NEW_PER_HOUR = 3;
export const RATE_LIMITED = "You've sent several requests in the last hour. If this is urgent, call 911 or find a staff member.";
export const EMERGENCY_NOTE = "This is for emergencies only, not for regular questions. For anything else, email enquire@thetechfestival.com or visit the registration desk.";

const str = (v) => String(v ?? "");
const line = (v, max) => str(v).replace(/\s+/g, " ").trim().slice(0, max);
const text = (v, max) => str(v).replace(/\r\n?/g, "\n").replace(/[^\P{Cc}\n\t]/gu, "").trim().slice(0, max);
export const categoryLabel = (key) => CATEGORIES.find((c) => c.key === key)?.label || "Other urgent";

/** A category key, from a key or its label ("Safety or security" → "safety"); "" when unknown. */
export function cleanCategory(v) {
  const s = line(v, 60).toLowerCase();
  return CATEGORIES.find((c) => c.key === s || c.label.toLowerCase() === s)?.key || "";
}

/** A phone number as typed, tidied: digits, spaces, + ( ) - . only, ≤ 30 ("" when it has no digits). */
export function cleanPhone(v) {
  const s = line(v, 40).replace(/[^\d+()\-. ]/g, "").trim().slice(0, 30);
  return /\d/.test(s) ? s : "";
}

/** POST /api/app/sos's body → { category, location, message, phone } or { error }. */
export function cleanSosRequest(b = {}) {
  const category = cleanCategory(b?.category);
  if (!category) return { error: `Pick what's happening: ${CATEGORIES.map((c) => c.label).join(", ")}.` };
  const message = text(b?.message, MESSAGE_MAX);
  if (!message) return { error: "Tell staff what's happening." };
  return { category, location: line(b?.location, 120), message, phone: cleanPhone(b?.phone) };
}

/** A follow-up or reply's text, or "" (empty). */
export const cleanBody = (v) => text(v, MESSAGE_MAX);

/** What the attendee sees: their request, its status and the thread (staff by first name). */
export function attendeeDTO(r) {
  return {
    id: str(r._id), category: r.category, categoryLabel: categoryLabel(r.category), location: r.location || "",
    message: r.message, phone: r.phone || "", status: r.status, statusLabel: STATUS_LABELS[r.status] || "Sent",
    messages: (r.messages || []).map((m) => ({
      from: m.from, staffName: m.from === "staff" ? str(m.staffName).trim().split(/\s+/)[0] || "TTFC staff" : "", body: m.body, at: m.at,
    })),
    createdAt: r.createdAt, updatedAt: r.updatedAt,
  };
}

/** What staff see: everything, with who acknowledged / resolved it. */
export function staffDTO(r) {
  return {
    id: str(r._id), userId: str(r.userId), name: r.name || "", email: r.email || "", phone: r.phone || "",
    category: r.category, categoryLabel: categoryLabel(r.category), location: r.location || "", message: r.message,
    status: r.status, statusLabel: STATUS_LABELS[r.status] || "Sent",
    messages: (r.messages || []).map((m) => ({ from: m.from, staffId: m.staffId ? str(m.staffId) : "", staffName: m.staffName || "", body: m.body, at: m.at })),
    acknowledgedBy: r.acknowledgedBy ? { id: str(r.acknowledgedBy), name: r.acknowledgedByName || "" } : null, acknowledgedAt: r.acknowledgedAt || null,
    resolvedBy: r.resolvedBy ? { id: str(r.resolvedBy), name: r.resolvedByName || "" } : null, resolvedAt: r.resolvedAt || null,
    lastMessageAt: r.lastMessageAt || r.createdAt, createdAt: r.createdAt, updatedAt: r.updatedAt,
    links: { app: staffAppPath(r._id), tel: r.phone ? `tel:${str(r.phone).replace(/[^\d+]/g, "")}` : "", mailto: usableEmail(r.email) ? `mailto:${r.email}` : "" },
  };
}

/** Open first, then seen, then resolved; newest first within each. */
export const STATUS_ORDER = Object.freeze({ open: 0, acknowledged: 1, resolved: 2 });
export const sortForStaff = (rows = []) => [...rows].sort((a, b) =>
  (STATUS_ORDER[a.status] ?? 3) - (STATUS_ORDER[b.status] ?? 3) || new Date(b.createdAt) - new Date(a.createdAt));

/** May this person answer SOS requests? Staff accounts (role admin) and anyone with the moderate right. */
export const isResponder = (user, rights) => user?.role === "admin" || !!rights?.moderate;

export const staffAppPath = (id) => `/app/staff/sos/${id}`;

/* ---------- pushes ---------- */

const short = (s, max) => {
  const one = str(s).replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
};

/** The push to staff about a new request (or a follow-up). Pure. */
export function staffNote(r, { followUp = false, body = "" } = {}) {
  const who = str(r.name).trim() || "An attendee";
  return {
    title: followUp ? `SOS: new message from ${who}` : `SOS: ${categoryLabel(r.category)}`,
    body: followUp ? short(body, 140) : short(`${who}${r.location ? ` · ${r.location}` : ""}: ${r.message}`, 160),
    link: "", thread: `sos.${r._id}`, kind: "sos", id: str(r._id), url: staffAppPath(r._id),
  };
}

/** The push to the attendee when staff reply. Pure. */
export const attendeeNote = (r, { staffName = "", body = "" } = {}) => ({
  title: `${str(staffName).trim().split(/\s+/)[0] || "TTFC staff"} (TTFC staff) replied`,
  body: short(body, 160), link: "", thread: `sos.${r._id}`, kind: "sos", id: str(r._id), url: "/app/help",
});

/** Everyone who should hear about an SOS: staff accounts and the people with the moderate right. Not banned. */
export async function responderIds() {
  const ctx = await rightsContext();
  const modTypes = Object.entries(ctx.matrix || {}).filter(([, row]) => row?.moderate).map(([t]) => t);
  const or = [{ role: "admin" }];
  if (modTypes.length) or.push({ types: { $in: modTypes } });
  if (modTypes.includes("volunteer")) or.push({ role: "volunteer" });
  const users = await User.find({ banned: { $ne: true }, $or: or }).select(RIGHTS_SELECT).lean();
  return users.filter((u) => isResponder(u, personAccess(u, ctx).rights)).map((u) => String(u._id));
}

/** Push to every responder, always: no notification switch, no throttle, no hidden-sender check. Never throws. */
export async function alertResponders(note, { except = "" } = {}) {
  try {
    const ids = (await responderIds()).filter((id) => id !== String(except || ""));
    if (ids.length) pushToUsers(ids, note);
    return ids.length;
  } catch (err) {
    console.error("SOS PUSH ERROR:", err?.message || err);
    return 0;
  }
}

/* ---------- the email ---------- */

/** SOS_ALERT_TO (comma list) → addresses; default enquire@. */
export function alertRecipients(env = process.env) {
  const list = str(env.SOS_ALERT_TO || ENQUIRE_EMAIL).split(",").map((e) => usableEmail(e)).filter(Boolean);
  return list.length ? [...new Set(list)] : [ENQUIRE_EMAIL];
}

/** The staff alert email for a new request: { subject, html, text }. Pure. */
export function sosEmail(r, { base = frontendUrl() } = {}) {
  const link = `${str(base).replace(/\/+$/, "")}${staffAppPath(r._id)}`;
  const admin = `${str(base).replace(/\/+$/, "")}/admin`;
  const rows = [
    ["What's happening", categoryLabel(r.category)],
    ["Name", r.name || "(no name)"],
    ["Phone", r.phone || "(not given)"],
    ["Email", r.email || "(none)"],
    ["Where", r.location || "(not given)"],
    ["Message", r.message],
    ["Sent", new Date(r.createdAt || Date.now()).toLocaleString("en-CA", { timeZone: "America/Toronto", dateStyle: "medium", timeStyle: "short" })],
  ];
  const subject = `SOS (${categoryLabel(r.category)}) from ${r.name || "an attendee"}`;
  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(subject)}</title></head>
<body style="margin:0;padding:24px;background:#f6f2fb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#140a26;">
<div style="max-width:560px;margin:0 auto;background:#ffffff;border:2px solid #d62d4b;border-radius:14px;padding:22px 24px;">
<div style="font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:#d62d4b;">Help &amp; SOS · TTFC 2026</div>
<h1 style="font-size:22px;margin:8px 0 16px;">${esc(subject)}</h1>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;font-size:15px;line-height:22px;">
${rows.map(([k, v]) => `<tr><td valign="top" style="padding:4px 12px 4px 0;color:#6b5f88;white-space:nowrap;">${esc(k)}</td><td style="padding:4px 0;${k === "Message" ? "white-space:pre-wrap;" : ""}">${esc(v)}</td></tr>`).join("\n")}
</table>
<p style="margin:20px 0 6px;"><a href="${esc(link)}" style="display:inline-block;padding:12px 20px;border-radius:999px;background:#d62d4b;color:#ffffff;font-weight:700;text-decoration:none;">Open it in the SOS inbox</a></p>
<p style="font-size:13px;color:#6b5f88;margin:12px 0 0;">Reply, acknowledge and resolve it in the web app's SOS inbox or the admin panel (Event day › SOS &amp; help: ${esc(admin)}). Every staff account was sent a push too.</p>
</div></body></html>`;
  const textOut = [subject, "", ...rows.map(([k, v]) => `${k}: ${v}`), "", `SOS inbox: ${link}`, `Admin panel: ${admin} (Event day › SOS & help)`].join("\n");
  return { subject, html, text: textOut, link };
}

let resendClient = null;
const resend = () => (resendClient ||= new Resend(process.env.RESEND_API_KEY));
let sender = null;
/** Tests: replace the email sender (fn(payload) → { id }); null restores Resend. */
export function useSosSender(fn) { sender = typeof fn === "function" ? fn : null; }

/** Emails SOS_ALERT_TO about a new request, from enquire@, reply-to the attendee. Never throws; logs no content. */
export async function emailAlert(r) {
  try {
    const e = sosEmail(r);
    const payload = {
      from: FROM, to: alertRecipients(), reply_to: usableEmail(r.email) || ENQUIRE_EMAIL,
      subject: e.subject, html: e.html, text: e.text, tags: [{ name: "campaign", value: "sos" }],
    };
    if (sender) return await sender(payload);
    const { data, error } = await resend().emails.send(payload);
    if (error) throw new Error(error.message || "Resend refused the email");
    return data;
  } catch (err) {
    console.error("SOS EMAIL ERROR:", err?.message || err);
    return null;
  }
}
