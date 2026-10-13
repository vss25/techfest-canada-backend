/* =========================================================
   Speaker Passes
   ---------------------------------------------------------
   A "ghost" pass for every speaker on the website: ticketType
   "speaker" ("Speaker Pass"), promo code SPEAKER. Never sold, never
   on the Tickets page or in the inventory; it includes everything.

   The ticket ID works like any other: app sign-in with the last
   name, the website /rsvp page (tier "speaker" = every option) and
   the check-in QR (TECHFEST:<ticketId>).

   Passes are made from the Sanity speaker list (one per speaker
   document, keyed by `speakerId`, so running the sync again never
   duplicates) with no email: speakers have none on file. Staff add
   each email in Admin → Speaker passes, preview, then send.

   Pure parts here (unit-tested in test/speaker-passes.test.js);
   routes/console.js does the storage, services/speakerPassEmail.js
   the email.
========================================================= */

import crypto from "crypto";
import { SANITY_PROJECT, fullNameMatches } from "./rsvp.js";

export const SPEAKER_TYPE = "speaker";
export const SPEAKER_PROMO = "SPEAKER";
export const SPEAKER_PASS_LABEL = "Speaker Pass";

export const SPEAKER_PASS_QUERY = '*[_type=="speaker"]{_id,name,title,company}';
export const SPEAKER_PASS_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(SPEAKER_PASS_QUERY)}`;

/** Speakers who never get a pass (case, accents and honorifics ignored: "Dr. Chris Golden"). */
export const EXCLUDED_SPEAKERS = [["Chris", "Golden"], ["Christopher", "Golden"]];

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const clean = (v, max = 200) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export const newSpeakerTicketId = () => crypto.randomBytes(6).toString("hex");

export function isExcludedSpeaker(name) {
  return EXCLUDED_SPEAKERS.some(([first, last]) => fullNameMatches(clean(name), first, last));
}

/** Sanity query result → [{ speakerId, name, title, company }] (drafts and nameless docs dropped). */
export function parseSpeakerDocs(json) {
  const list = Array.isArray(json?.result) ? json.result : Array.isArray(json) ? json : [];
  const out = [];
  const seen = new Set();
  for (const d of list) {
    const speakerId = clean(d?._id, 120);
    const name = clean(d?.name, 120);
    if (!speakerId || !name || speakerId.startsWith("drafts.") || seen.has(speakerId)) continue;
    seen.add(speakerId);
    out.push({ speakerId, name, title: clean(d?.title), company: clean(d?.company) });
  }
  return out;
}

/** Reads the public speaker list (Sanity CDN). Throws when it can't, so a sync never runs on a partial list. */
export async function fetchSpeakerDocs({ fetchImpl = globalThis.fetch, url = SPEAKER_PASS_URL } = {}) {
  const res = await fetchImpl(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Speaker list unavailable (HTTP ${res.status})`);
  return parseSpeakerDocs(await res.json());
}

/**
 * What a sync would do. `existingSpeakerIds`: speakerIds that already have a pass.
 * → { create: [speaker], existing: [speaker], excluded: [speaker] }
 */
export function planSpeakerPasses(speakers = [], existingSpeakerIds = []) {
  const have = new Set([...existingSpeakerIds].map(String));
  const plan = { create: [], existing: [], excluded: [] };
  for (const s of speakers) {
    if (isExcludedSpeaker(s.name)) plan.excluded.push(s);
    else if (have.has(s.speakerId)) plan.existing.push(s);
    else plan.create.push(s);
  }
  return plan;
}

/** The Attendee document for a new Speaker Pass (no email yet). */
export function speakerPassDoc(s, { ticketId = newSpeakerTicketId(), now = new Date() } = {}) {
  const details = {};
  if (s.title) details.jobTitle = s.title;
  if (s.company) details.organisation = s.company;
  return {
    name: s.name, email: "", ticketId, ticketType: SPEAKER_TYPE, promoCode: SPEAKER_PROMO,
    speakerId: s.speakerId, purchaseDate: now, ...(Object.keys(details).length ? { details } : {}),
  };
}

const isDuplicateKey = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));

/**
 * Creates the missing passes. Idempotent: keyed by speakerId (and a unique index on it,
 * so two clicks at once still make one pass each; a clash counts as "existing").
 * @param {object} deps
 * @param {() => Promise<Array>} deps.loadSpeakers       parseSpeakerDocs() output
 * @param {() => Promise<string[]>} deps.existingSpeakerIds
 * @param {(doc: object) => Promise<object>} deps.create  stores one Attendee
 */
export async function syncSpeakerPasses({ loadSpeakers, existingSpeakerIds, create, newTicketId = newSpeakerTicketId, now = () => new Date() }) {
  const speakers = await loadSpeakers();
  const plan = planSpeakerPasses(speakers, await existingSpeakerIds());
  const createdNames = [];
  let existing = plan.existing.length;
  for (const s of plan.create) {
    try {
      // A ticket ID clash (1 in 2^48) just gets another ID; a speakerId clash means another sync won.
      for (let attempt = 0; ; attempt++) {
        try {
          await create(speakerPassDoc(s, { ticketId: newTicketId(), now: now() }));
          createdNames.push(s.name);
          break;
        } catch (err) {
          if (!isDuplicateKey(err) || /speakerId/.test(String(err?.message || "")) || attempt >= 2) throw err;
        }
      }
    } catch (err) {
      if (isDuplicateKey(err)) { existing += 1; continue; }
      throw err;
    }
  }
  return {
    total: speakers.length,
    created: createdNames.length,
    existing,
    excluded: plan.excluded.length,
    createdNames,
    excludedNames: plan.excluded.map((s) => s.name),
  };
}

/* ---------- Emails ---------- */

/** "" clears it; otherwise a valid address, lower-cased. */
export function validateSpeakerEmail(raw) {
  if (typeof raw !== "string") return { ok: false, error: "Enter an email address." };
  const email = raw.trim().toLowerCase();
  if (!email) return { ok: true, email: "" };
  if (email.length > 254 || !EMAIL.test(email)) return { ok: false, error: "Enter a valid email address." };
  return { ok: true, email };
}

/** Sent counts only for the address it went to: a corrected email is "ready" again. */
export function passStatus(a) {
  const email = String(a?.email || "").trim().toLowerCase();
  if (!email) return "no-email";
  if (a?.passEmailSentAt && String(a.passEmailSentTo || "").toLowerCase() === email) return "sent";
  return "ready";
}

/** One row for Admin → Speaker passes. */
export function speakerPassRow(a) {
  return {
    id: String(a._id),
    speakerId: a.speakerId || "",
    name: a.name || "",
    title: a.details?.jobTitle || "",
    company: a.details?.organisation || "",
    ticketId: a.ticketId,
    email: a.email || "",
    emailSentAt: a.passEmailSentAt || null,
    emailSentTo: a.passEmailSentTo || "",
    sentCount: Number(a.passEmailSentCount) || 0,
    status: passStatus(a),
    claimed: !!a.claimedBy,
    checkedIn: !!a.checkedIn,
    createdAt: a.createdAt || a.purchaseDate || null,
    runOfShow: a.runOfShow?.sessions?.length ? a.runOfShow : null,
    sessions: a.runOfShow?.sessions?.length || 0,
    contact: a.speakerContact || "",
    invitesSentAt: a.invitesSentAt || null,
    invitesSentCount: Number(a.invitesSentCount) || 0,
  };
}

/** A pass for a speaker who isn't on the website (keyed "manual:<name>", so it's made once). */
export function manualSpeakerPassDoc({ name, title = "", company = "" }, opts) {
  const n = clean(name, 120);
  const key = n.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return speakerPassDoc({ speakerId: `manual:${key}`, name: n, title: clean(title), company: clean(company) }, opts);
}

export function speakerPassCounts(rows = []) {
  return {
    passes: rows.length,
    rsvpd: rows.filter((r) => r.rsvp).length,
    withRunOfShow: rows.filter((r) => r.sessions > 0).length,
    withEmail: rows.filter((r) => r.status !== "no-email").length,
    sent: rows.filter((r) => r.status === "sent").length,
    ready: rows.filter((r) => r.status === "ready").length,
  };
}

/** Passes "Send to all ready" would email: an email, not yet sent to that address. */
export const readyToSend = (attendees = []) => attendees.filter((a) => passStatus(a) === "ready");

/* ---------- Names ---------- */

const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|hon|honourable|honorable|rev|the|rt)\.?$/i;

/** "Dear <first name>": honorifics skipped, a nickname wins ("Heling (Alex) Pu" → "Alex"). */
export function speakerFirstName(name) {
  const raw = clean(name);
  const nick = /["“”]([^"“”]{2,40})["“”]/.exec(raw) || /\(([^()]{2,40})\)/.exec(raw);
  if (nick && !/^(phd|md|dr|ret)$/i.test(nick[1].trim())) return nick[1].trim().split(" ")[0];
  const words = raw.replace(/\([^)]*\)/g, " ").split(" ").filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  return words[0] || "";
}

/** The last name staff tell a speaker to sign in with (last word, post-nominals dropped). */
export function speakerLastName(name) {
  const words = clean(name).replace(/\([^)]*\)/g, " ").split(",")[0].split(" ").filter(Boolean);
  return words.length > 1 ? words[words.length - 1] : words[0] || "";
}

/**
 * First and last name for the personal RSVP link: the last word is the last name, the
 * rest the first name, with honorifics, nicknames and post-nominals dropped
 * ("Dr. Rulan S. Parekh" → Rulan S. / Parekh, "Heling (Alex) Pu" → Heling / Pu).
 */
export function rsvpNameParts(name) {
  const words = clean(name)
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .split(",")[0]
    .split(" ")
    .filter(Boolean);
  const last = words.pop() || "";
  while (words.length && HONORIFIC.test(words[0])) words.shift();
  return { first: words.join(" "), last };
}

/** The sample used by the "Preview email" button (never a real person). */
export const SAMPLE_SPEAKER = Object.freeze({
  name: "Jane Doe", title: "Chief AI Officer", company: "Example Corp", ticketId: "A1B2C3D4E5F6",
});
