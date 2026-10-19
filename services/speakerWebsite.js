/* =========================================================
   Speaker passes ⇄ the website (Sanity), live
   ---------------------------------------------------------
   A pass follows its speaker on the website:
     - name, title and company come from the speaker document
       (rename someone in Admin → Speakers and the pass follows);
     - the run of show comes from the agenda: every session that
       lists the speaker (speaker or moderator, matched by name),
       so a speaker added later, or a session moved, shows up in
       their pass email and calendar invites. A pass the speaker
       isn't on the agenda for keeps the run of show staff saved.
   Sync ("Create passes for all speakers") also links a manual
   pass ("manual:<name>", made before the speaker was on the
   website) to the speaker instead of making a second pass, and
   merges the second, empty pass if one was already made.
   Pure parts are unit-tested in test/speaker-website.test.js.
========================================================= */

import { SANITY_PROJECT } from "./rsvp.js";
import { fetchSpeakerDocs } from "./speakerPasses.js";
import { validateRunOfShow } from "./runOfShow.js";

const SESSION_QUERY = '*[_type=="session" && !(_id in path("drafts.**"))]{day, time, endTime, title, format, isBreak, moderator, speakers}';
export const SESSION_URL =
  `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(SESSION_QUERY)}`;

const HONORIFIC = /^(mr|mrs|ms|miss|mx|dr|prof|professor|sir|dame|hon|honourable|honorable|rev|the|rt|bgen|gen|col|maj|capt)$/;

/** "Hon. Évan  Solomon, PhD" → "evan solomon" (first + last word; honorifics, nicknames and post-nominals dropped). */
export function nameKey(name) {
  const words = String(name ?? "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/["“”][^"“”]*["“”]/g, " ")
    .replace(/\([^)]*\)/g, " ")
    .split(",")[0]
    .replace(/[^a-z\s'-]/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  while (words.length > 1 && HONORIFIC.test(words[0])) words.shift();
  if (!words.length) return "";
  return words.length === 1 ? words[0] : `${words[0]} ${words[words.length - 1]}`;
}

export const isManualPass = (a) => String(a?.speakerId || "").startsWith("manual:");

const FORMAT = {
  panel: "Panel", keynote: "Keynote", fireside: "Fireside chat", opening: "Opening", dialogue: "Dialogue",
  performance: "Performance", workshop: "Workshop", awards: "Awards", networking: "Networking",
};
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The run of show for `name` from the agenda (Sanity session docs), or null when they
 * aren't on it. Shape: services/runOfShow.js ({ sessions: [{ day, start, end, title, format, role, lineup }] }).
 * Agenda entries mostly list names only: `orgOf(name)` fills in each person's company.
 */
export function agendaRunOfShow(name, sessions = [], orgOf = () => "") {
  const key = nameKey(name);
  if (!key) return null;
  const list = [];
  for (const s of sessions || []) {
    if (!s || s.isBreak || ![1, 2].includes(Number(s.day)) || !HHMM.test(s.time || "") || !HHMM.test(s.endTime || "") || s.endTime <= s.time) continue;
    const format = FORMAT[String(s.format || "").toLowerCase()] || "";
    const onStage = format === "Panel" ? "Panellist" : "Speaker";
    const people = [
      ...(Array.isArray(s.speakers) ? s.speakers : []).map((p) => ({ name: p?.name, org: p?.org, role: onStage })),
      ...(s.moderator?.name ? [{ name: s.moderator.name, org: s.moderator.org, role: "Moderator" }] : []),
    ].filter((p) => p.name);
    const me = people.find((p) => nameKey(p.name) === key);
    if (!me) continue;
    list.push({
      day: Number(s.day), start: s.time, end: s.endTime, title: s.title || "Session", format, role: me.role,
      lineup: people.map((p) => ({ name: p.name, role: p.role, org: p.org || orgOf(p.name) || "" })),
    });
  }
  if (!list.length) return null;
  const check = validateRunOfShow({ sessions: list.slice(0, 10) });
  return check.ok ? check.value : null;
}

/**
 * The pass as the website has it now: name / title / company from its speaker document, and
 * the run of show from the agenda when they're on it.
 * → { doc (for speakerPassRow and the emails), changes ($set for the stored pass, or null), source, onWebsite }
 */
export function applyWebsite(a, site) {
  if (!site) return { doc: a, changes: null, source: a?.runOfShow?.sessions?.length ? "saved" : null, onWebsite: null };
  const speaker = site.byId.get(String(a.speakerId || ""));
  let doc = a;
  const changes = {};
  if (speaker) {
    const details = { ...(a.details || {}) };
    if (speaker.name && speaker.name !== a.name) changes.name = speaker.name;
    if ((speaker.title || "") !== (details.jobTitle || "")) changes["details.jobTitle"] = speaker.title || "";
    if ((speaker.company || "") !== (details.organisation || "")) changes["details.organisation"] = speaker.company || "";
    if (Object.keys(changes).length) {
      doc = { ...a, name: changes.name ?? a.name, details: { ...details, jobTitle: speaker.title || "", organisation: speaker.company || "" } };
    }
  }
  const fromAgenda = agendaRunOfShow(doc.name, site.sessions, lineupOrgs(a, site));
  let source = a?.runOfShow?.sessions?.length ? "saved" : null;
  if (fromAgenda) { doc = { ...doc, runOfShow: fromAgenda }; source = "agenda"; }
  return { doc, changes: Object.keys(changes).length ? changes : null, source, onWebsite: !!speaker };
}

/**
 * name → company for an agenda lineup: the speaker's company on the website (so an edit in
 * Admin → Speakers shows up in the next email), then (for "David" vs "Dave", "Prof. Aspuru-Guzik")
 * the one website speaker with that surname, then what was saved on this pass's run of show
 * (people who aren't on the website).
 */
function lineupOrgs(a, site) {
  const website = new Map();
  const bySurname = new Map();
  for (const s of site.speakers || []) {
    const k = nameKey(s.name);
    if (k && s.company && !website.has(k)) website.set(k, s.company);
    const last = k.split(" ").pop();
    if (last) bySurname.set(last, bySurname.has(last) ? null : s.company || null);
  }
  const saved = new Map();
  for (const s of a?.runOfShow?.sessions || []) {
    for (const p of s.lineup || []) {
      const k = nameKey(p.name);
      if (k && p.org && !saved.has(k)) saved.set(k, p.org);
    }
  }
  return (name) => {
    const k = nameKey(name);
    return website.get(k) || bySurname.get(k.split(" ").pop()) || saved.get(k) || "";
  };
}

/** Activity that makes a pass worth keeping: an address, a send, the app, check-in. */
const hasActivity = (a) => !!(a?.email || a?.alsoTo?.length || a?.passEmailSentAt || a?.claimedBy || a?.checkedIn);

/**
 * Sync plan for passes vs the website speakers.
 *  link:  a manual pass to give a website speakerId (the speaker has no pass of their own yet);
 *  merge: a manual pass that was used + an empty pass made later for the same speaker:
 *         drop the empty one, link the manual one;
 *  dupes: same person twice with activity on both (left for staff).
 * `passes`: stored speaker passes; `speakers`: parseSpeakerDocs() output.
 */
export function planWebsiteLinks(passes = [], speakers = []) {
  const byKeyManual = new Map();
  for (const p of passes) if (isManualPass(p)) {
    const k = nameKey(p.name);
    if (k && !byKeyManual.has(k)) byKeyManual.set(k, p);
  }
  const bySpeakerId = new Map(passes.filter((p) => p.speakerId && !isManualPass(p)).map((p) => [String(p.speakerId), p]));
  const plan = { link: [], merge: [], dupes: [] };
  for (const s of speakers) {
    const manual = byKeyManual.get(nameKey(s.name));
    if (!manual) continue;
    const own = bySpeakerId.get(s.speakerId);
    if (!own) plan.link.push({ keep: manual, speaker: s });
    else if (!hasActivity(own)) plan.merge.push({ keep: manual, drop: own, speaker: s });
    else if (!hasActivity(manual)) plan.merge.push({ keep: own, drop: manual, speaker: s });
    else plan.dupes.push({ a: manual, b: own, speaker: s });
  }
  return plan;
}

/* ---------- loading (cached for a minute; a failure keeps the last good copy) ---------- */

let cache = null; // { at, site }
const TTL_MS = 60 * 1000;

async function fetchSessions(fetchImpl) {
  const res = await fetchImpl(SESSION_URL, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Agenda unavailable (HTTP ${res.status})`);
  const json = await res.json();
  return Array.isArray(json?.result) ? json.result : [];
}

/** → { speakers, byId: Map(speakerId → speaker), sessions } | null when the website can't be read. */
export async function loadWebsite({ fetchImpl = globalThis.fetch, fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cache.at < TTL_MS) return cache.site;
  try {
    const [speakers, sessions] = await Promise.all([fetchSpeakerDocs({ fetchImpl }), fetchSessions(fetchImpl)]);
    const site = { speakers, byId: new Map(speakers.map((s) => [s.speakerId, s])), sessions };
    cache = { at: Date.now(), site };
    return site;
  } catch (err) {
    console.error("SPEAKER WEBSITE LOAD:", err?.message || err);
    return cache?.site || null;
  }
}

/* ---------- nudge (a reminder to RSVP) ---------- */

export const NUDGE_COPY = Object.freeze({
  subject: "{firstName}, a quick reminder: please RSVP for TTFC 2026",
  headline: "A quick reminder from TTFC 2026.",
  message: "We haven't had your RSVP yet. Please let us know which days and events you'll join: the RSVP button is below, with your Power Pass.\n\nIf you've already replied, thank you, and please ignore this email.",
});

/** The wording for a nudge: the defaults, with anything staff typed taking over. */
export const nudgeCopy = (copy = {}) => ({
  subject: copy.subject || NUDGE_COPY.subject,
  headline: copy.headline || NUDGE_COPY.headline,
  message: copy.message || NUDGE_COPY.message,
});
