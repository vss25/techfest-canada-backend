import crypto from "crypto";
import { csvCell } from "./brochureDownloads.js";
import { personAliasIds, personSubject } from "./checkinDesk.js";

/* =========================================================
   The post-event survey (Oct 26 2026): the questions, the window, the
   links and the checks. Pure (test/survey.test.js).
   ---------------------------------------------------------
   The organiser: "Create a post event survey prompt to all the signed
   in app users. We will use this to share with future delegates,
   exhibitors, and sponsors. The same person can have an opinion about
   all three. Start showing at 4 pm onwards. The survey questions
   should be editable in the admin panel and can be updated from server
   side without needing an app update. The same survey link will also
   be shared with attendees who are not on the app. Talk about
   check-in/registration, meals, food, quality of interactions, would
   you attend again? what can be better?" Later the same evening: "I
   want to share the survey to all the people who were checked in
   today" (an email, services/surveyEmail.js), and "nothing may be sent
   until they've reviewed the survey" (autoNotify was off by default).
   Later still: "They should see this in feed and prompted/notified
   some time after 4 pm. All of them don't need to be notified
   immediately." So the app prompt is automatic again, paced: from
   opensAt + notifyStartDelayMin (15), notifyBatchSize (30) people
   every notifyIntervalMin (5) minutes, the most recently active first,
   until 10 PM Toronto on the opening day (waveDue, services/survey.js
   runSurveyNotify). Nothing goes on deploy; the email is only ever
   sent from the admin panel (routes/survey.js).

   One config (AppContent "survey.config", services/survey.js), the
   defaults below until management saves it:
     { enabled, opensAt, closesAt (ISO with their offset), title, intro,
       thankYou, notifyTitle, notifyBody, autoNotify (+ autoNotifyExplicit:
       management changed it), notifyStartDelayMin (0–240),
       notifyBatchSize (1–200), notifyIntervalMin (1–60), notifiedAt (the
       first prompt), notifiedCount, notifyLastWaveAt (set by the prompt,
       never by a save), questions: [question], retired:
       [question] (questions deleted since: their answers stay in the
       responses and the CSV marks them "(removed)") }
   question: { id (a slug, stable: answers are stored under it),
     section (heading), type: "rating" (1–5 stars) | "nps" (0–10) |
     "choice" (one of options) | "multi" (any of options) | "text" (one
     line, ≤ 200) | "longtext" (≤ 4000) | "consent" (a tick box), label,
     help?, options? (choice / multi), required, minLabel? / maxLabel?
     (rating / nps), allowNA (rating / nps / choice: "na" is an answer,
     "Not applicable"; default true), showIf? { question, includes }
     (shown only when that earlier choice / multi question's answer is
     or includes that option) }
   Oct 26 2026, the organiser: "Allow the ability to skip, provide NA.
   Have questions for speakers from onboarding to hosting to session
   creation, have questions around conference production and content."
   Every default question can be skipped (only the name and email are
   required); a blank answer is a skip (not stored), "na" is stored
   and left out of the averages (counted on its own). The speakers'
   section shows only to people who ticked Speaker; answers to a
   question that isn't shown are ignored (and cleared on a re-send),
   and it's never required.
   Questions "name", "email", "title" and "company" are the person's
   details: prefilled for people the server knows, and copied to the
   response's own fields. (Until the evening of Oct 26 a respondent
   the server didn't know could answer on the shared link with their
   email; the survey is by invitation now, see below.)

   Personal links: https://www.thetechfestival.com/survey?t=<token>,
   token = base64url("<kind>:<id>") + "." + the first 16 bytes of
   HMAC-SHA256("ttfc-survey:v1:" + that, key), base64url; key =
   HMAC-SHA256(JWT_SECRET, "ttfc-survey-link:v1") (never JWT_SECRET
   itself), checked in constant time. kind "u" = an account (the app's
   card and inbox, and the email to people with an account), "p" = a
   pass with no account (Attendee id, the email to pass-only people).
   Tokens don't expire: they only say who is answering.

   Oct 26 2026, later that night, the organiser: "This isn't a public
   survey. This would be sent out to attendees one on one." and "you
   can't survey if you haven't attended or checked in." So the survey
   is by invitation: only a personal link (?t=) or the app's sign-in
   gets the questions or can answer (no answers by typed email any
   more), and only people with a real door check-in on Day 1 or Day 2
   (checkedInPersons: arrived in the lobby, checked in at the pass desk
   or by the door scanner; practice scans never count; the person's
   passes and their email addresses, through the People directory),
   checked at each request, since people still check in on Day 2.
   Staff get personal links for one-on-one sharing in the admin panel.
========================================================= */

export const SURVEY_KEY = "survey.config";
export const SURVEY_PAGE = "https://www.thetechfestival.com/survey";
/** The app prompt's AppNotification batch (one per person, ever). */
export const NOTIFY_BATCH = "survey-2026";
/** The survey email's CampaignSend key: each address once, whichever audience it was sent to. */
export const EMAIL_CAMPAIGN = "survey-2026";
export const CTA = "Share feedback";
export const QUESTION_TYPES = Object.freeze(["rating", "nps", "choice", "multi", "text", "longtext", "consent"]);
export const SCORED_TYPES = Object.freeze(["rating", "nps"]);
/** Types that can be answered "na" (Not applicable), when the question's allowNA is on (the default). */
export const NA_TYPES = Object.freeze(["rating", "nps", "choice"]);
export const NA = "na";
/** The person's details: prefilled, and copied to the response's own fields. */
export const IDENTITY_IDS = Object.freeze(["name", "email", "title", "company"]);
export const MAX_QUESTIONS = 40;
export const LIMITS = Object.freeze({
  id: 40, section: 80, label: 300, help: 300, option: 120, options: 20, scaleLabel: 40,
  title: 120, intro: 600, thankYou: 300, notifyTitle: 80, notifyBody: 300,
  text: 200, longtext: 4000,
});
/** The answers to people the survey turns away. */
export const INVITE_ONLY_MESSAGE = "This survey is by invitation. Please use the link we sent you.";
export const NOT_ATTENDED_MESSAGE = "This survey is for people who attended TTFC 2026.";
/** The event days whose door check-ins count. */
export const EVENT_DAYS = Object.freeze(["2026-10-26", "2026-10-27"]);
/** Email audiences: who had a door check-in (arrived in the lobby or checked in at the pass desk / door scanner). */
export const AUDIENCES = Object.freeze({ day1: ["2026-10-26"], day2: ["2026-10-27"], both: ["2026-10-26", "2026-10-27"] });

const str = (v) => (v === null || v === undefined ? "" : String(v));
const oneLine = (v) => str(v).replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
const multiLine = (v) => str(v).replace(/\r\n?/g, "\n").replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
const EMAIL = /^[^\s@<>"',;:()[\]]+@[^\s@<>"',;:()[\]]+\.[^\s@<>"',;:()[\]]+$/;
export const cleanEmail = (v) => { const s = oneLine(v).toLowerCase(); return s.length <= 254 && EMAIL.test(s) ? s : ""; };
const SLUG = /^[a-z0-9][a-z0-9_-]{0,39}$/;
export const isSlug = (v) => typeof v === "string" && SLUG.test(v);

const q = (id, section, type, label, extra = {}) => Object.freeze({
  id, section, type, label, required: false, ...(NA_TYPES.includes(type) ? { allowNA: true } : {}), ...extra,
});
const YOURS = "Your TTFC 2026";
const CONTENT = "Content and production";
const SPEAKING = "Speaking at TTFC";
const WORDS = "In your words";
const ABOUT = "About you";
const SPEAKERS_ONLY = Object.freeze({ showIf: Object.freeze({ question: "role", includes: "Speaker" }) });
export const DEFAULT_QUESTIONS = Object.freeze([
  q("role", YOURS, "multi", "You were at TTFC as…", { options: ["Delegate", "Exhibitor", "Sponsor or partner", "Speaker", "Media", "Other"] }),
  q("checkin", YOURS, "rating", "Check-in and registration"),
  q("meals", YOURS, "rating", "Meals and catering: timing, service and seating"),
  q("food", YOURS, "rating", "Food quality"),
  q("interactions", YOURS, "rating", "Quality of the people you met and the conversations"),
  q("again", YOURS, "choice", "Would you attend TTFC again?", { options: ["Yes, definitely", "Probably", "Not sure", "No"] }),
  q("recommend", YOURS, "nps", "How likely are you to recommend TTFC to a colleague?", { minLabel: "Not at all", maxLabel: "Extremely" }),
  q("better", YOURS, "longtext", "What can we do better?"),
  q("content", CONTENT, "rating", "Quality and relevance of the content"),
  q("speakers", CONTENT, "rating", "Speakers and panels"),
  q("formats", CONTENT, "rating", "Session formats and length: keynotes, panels, fireside chats"),
  q("agenda", CONTENT, "rating", "Agenda and timing: sessions started and ended on time"),
  q("production", CONTENT, "rating", "Stage production: sound, screens and lighting"),
  q("venue", CONTENT, "rating", "Venue, signage and layout"),
  q("app", CONTENT, "rating", "The TTFC app"),
  q("topics_2027", CONTENT, "longtext", "Which topics should we cover in 2027?"),
  q("sp_onboarding", SPEAKING, "rating", "Speaker onboarding: invitation, information and forms", SPEAKERS_ONLY),
  q("sp_comms", SPEAKING, "rating", "Communication from the TTFC team before the event", SPEAKERS_ONLY),
  q("sp_session", SPEAKING, "rating", "Creating your session: topic, format, moderator and co-panellist briefing", SPEAKERS_ONLY),
  q("sp_hosting", SPEAKING, "rating", "Hosting on the day: arrival, speaker lounge and on-site support", SPEAKERS_ONLY),
  q("sp_av", SPEAKING, "rating", "AV and tech support on stage", SPEAKERS_ONLY),
  q("sp_stage", SPEAKING, "rating", "Stage management and timekeeping", SPEAKERS_ONLY),
  q("sp_again", SPEAKING, "choice", "Would you speak at TTFC again?", { options: ["Yes", "Maybe", "No"], ...SPEAKERS_ONLY }),
  q("sp_better", SPEAKING, "longtext", "What would make speaking at TTFC better?", SPEAKERS_ONLY),
  q("to_delegates", WORDS, "longtext", "What would you tell someone thinking of attending as a delegate?",
    { help: "We'd love to share what you think with future attendees. Answer any that apply." }),
  q("to_exhibitors", WORDS, "longtext", "What would you tell someone thinking of exhibiting?"),
  q("to_sponsors", WORDS, "longtext", "What would you tell someone thinking of sponsoring?"),
  q("consent", WORDS, "consent", "TTFC may quote my answers in this section with my name, title and company."),
  q("name", ABOUT, "text", "Name", { required: true }),
  q("email", ABOUT, "text", "Email", { required: true }),
  q("title", ABOUT, "text", "Title"),
  q("company", ABOUT, "text", "Company"),
]);

export const SURVEY_DEFAULTS = Object.freeze({
  enabled: true,
  opensAt: "2026-10-27T16:00:00-04:00",     // Day 2, 4 PM Toronto (EDT)
  closesAt: "2026-11-30T23:59:00-05:00",    // the end of November (EST)
  // Oct 26 2026, late, the organiser: "They should see this in feed and prompted/notified some time after 4 pm. All of
  // them don't need to be notified immediately." On = the prompt goes out in waves (services/survey.js
  // runSurveyNotify): from opensAt + notifyStartDelayMin, notifyBatchSize people every notifyIntervalMin minutes,
  // until 10 PM Toronto on the day it opens (NOTIFY_END_HOUR). Off = only when staff click Send. (It was off by
  // default earlier that evening, "nothing until they've reviewed it"; a stored false counts only when management
  // switched it off themselves: autoNotifyExplicit, see surveyConfig.)
  autoNotify: true,
  // Oct 27 2026, 3:45 PM, the organiser: "Show the survey for everyone using the app." Off = anyone invited (the
  // app's sign-in or a personal link) gets the card and may answer, checked in or not; on = only people with a door
  // check-in (the rule from Oct 26). The automatic waves and the email still go only to people who checked in.
  checkedInOnly: false,
  notifyStartDelayMin: 15,                  // the first wave at 4:15 PM
  notifyBatchSize: 30,
  notifyIntervalMin: 5,
  title: "How was TTFC 2026?",
  intro: "Two minutes, and it helps us make 2027 better. Your answers about the event, and anything you'd tell future delegates, exhibitors and sponsors.",
  thankYou: "Thank you! Your feedback helps shape TTFC 2027.",
  notifyTitle: "How was TTFC 2026?",
  notifyBody: "Two minutes: check-in, meals, the people you met, and what we can do better.",
});
const TEXT_FIELDS = ["title", "intro", "thankYou", "notifyTitle", "notifyBody"];
/** The paced prompt's numbers: [min, max] (whole numbers). */
export const PACE_LIMITS = Object.freeze({ notifyStartDelayMin: [0, 240], notifyBatchSize: [1, 200], notifyIntervalMin: [1, 60] });
/** The automatic waves stop at 10 PM Toronto on the day the survey opens (nobody is pushed late at night; people
    who come to the app later still see its card, and management's Send reaches everyone left). */
export const NOTIFY_END_HOUR = 22;
const REQUIRED_TEXT = new Set(["title", "notifyTitle", "notifyBody"]);

const parseWhen = (v) => { const d = new Date(str(v).trim()); return Number.isNaN(d.getTime()) ? null : d; };
/** An ISO time with its offset ("2026-10-27T16:00:00-04:00", or …Z), else "". */
export function cleanWhen(v) {
  const s = str(v).trim();
  return s && parseWhen(s) && /T\d\d:\d\d/.test(s) && /([zZ]|[+-]\d\d:?\d\d)$/.test(s) ? s : "";
}

/** Can this question be answered "na"? (rating / nps / choice, unless allowNA is false). */
export const allowsNA = (x) => NA_TYPES.includes(x?.type) && x?.allowNA !== false;

/** A stored question → the public shape (only the known fields, in order). */
export function questionView(x) {
  const out = { id: str(x.id), section: str(x.section), type: str(x.type), label: str(x.label), required: !!x.required };
  if (x.help) out.help = str(x.help);
  if ((x.type === "choice" || x.type === "multi") && Array.isArray(x.options)) out.options = x.options.map(str);
  if (SCORED_TYPES.includes(x.type)) {
    if (x.minLabel) out.minLabel = str(x.minLabel);
    if (x.maxLabel) out.maxLabel = str(x.maxLabel);
  }
  if (NA_TYPES.includes(x.type)) out.allowNA = allowsNA(x);
  if (x.showIf && isSlug(x.showIf.question) && str(x.showIf.includes)) out.showIf = { question: str(x.showIf.question), includes: str(x.showIf.includes) };
  return out;
}

/** The stored config (AppContent value, or nothing) → the config with the defaults filled in. */
export function surveyConfig(stored = null) {
  const v = stored && typeof stored === "object" ? stored : {};
  const pick = (k) => (typeof v[k] === typeof SURVEY_DEFAULTS[k] && (typeof v[k] !== "string" || v[k].trim()) ? v[k] : SURVEY_DEFAULTS[k]);
  const out = {};
  for (const k of Object.keys(SURVEY_DEFAULTS)) out[k] = pick(k);
  // autoNotify was false by default until late on Oct 26 2026, and a save of the whole form stored that default. A
  // stored value counts only when management changed it themselves (a save that changed it sets autoNotifyExplicit);
  // otherwise the default (on) applies.
  out.autoNotify = v.autoNotifyExplicit === true && typeof v.autoNotify === "boolean" ? v.autoNotify : SURVEY_DEFAULTS.autoNotify;
  for (const [k, [lo, hi]] of Object.entries(PACE_LIMITS)) if (!(Number.isInteger(out[k]) && out[k] >= lo && out[k] <= hi)) out[k] = SURVEY_DEFAULTS[k];
  if (!cleanWhen(out.opensAt)) out.opensAt = SURVEY_DEFAULTS.opensAt;
  if (!cleanWhen(out.closesAt)) out.closesAt = SURVEY_DEFAULTS.closesAt;
  const questions = Array.isArray(v.questions) && v.questions.length ? v.questions : DEFAULT_QUESTIONS;
  out.questions = questions.filter((x) => x && isSlug(x.id) && QUESTION_TYPES.includes(x.type)).map(questionView);
  out.retired = (Array.isArray(v.retired) ? v.retired : []).filter((x) => x && isSlug(x.id)).map(questionView);
  out.notifiedAt = v.notifiedAt ? new Date(v.notifiedAt).toISOString() : null;
  out.notifiedCount = Number(v.notifiedCount) || 0;
  out.notifyLastWaveAt = v.notifyLastWaveAt ? new Date(v.notifyLastWaveAt).toISOString() : null;
  out.saved = !!stored;
  return out;
}

/** "YYYY-MM-DD" and "HH:MM" in Toronto → that moment (its offset worked out for that day). */
export function torontoMoment(date, hhmm) {
  const noon = new Date(`${date}T12:00:00Z`);
  const name = new Intl.DateTimeFormat("en-US", { timeZone: "America/Toronto", timeZoneName: "longOffset" }).formatToParts(noon)
    .find((x) => x.type === "timeZoneName")?.value || "GMT-05:00";
  const off = /GMT([+-]\d\d):?(\d\d)?/.exec(name);
  return new Date(`${date}T${hhmm}:00${off ? `${off[1]}:${off[2] || "00"}` : "-05:00"}`);
}

/** The automatic prompt's window: from opensAt + the delay to 10 PM Toronto on the opening day (or closesAt). */
export function notifyWindow(cfg) {
  const opens = parseWhen(cfg?.opensAt);
  const closes = parseWhen(cfg?.closesAt);
  if (!opens || !closes) return null;
  const startsAt = new Date(opens.getTime() + (Number(cfg.notifyStartDelayMin) || 0) * 60_000);
  const day = opens.toLocaleDateString("en-CA", { timeZone: "America/Toronto" });   // YYYY-MM-DD
  const tenPm = torontoMoment(day, `${String(NOTIFY_END_HOUR).padStart(2, "0")}:00`);
  return { startsAt, endsAt: new Date(Math.min(tenPm.getTime(), closes.getTime())) };
}

/**
 * Is a wave due now? enabled, autoNotify on, inside the window, and an interval since the last wave (30 s of slack for
 * the minute job's drift). → { due, nextAt (Date | null), startsAt, endsAt }
 */
export function waveDue(cfg, { now = new Date(), lastWaveAt = cfg?.notifyLastWaveAt || null } = {}) {
  const w = notifyWindow(cfg);
  if (!w || !cfg.enabled || !cfg.autoNotify) return { due: false, nextAt: null, ...(w || {}) };
  const t = new Date(now).getTime();
  const every = (Number(cfg.notifyIntervalMin) || 5) * 60_000;
  const after = lastWaveAt ? new Date(lastWaveAt).getTime() + every : 0;
  const next = Math.max(w.startsAt.getTime(), after);
  if (next >= w.endsAt.getTime()) return { due: false, nextAt: null, ...w };
  return { due: t >= next - 30_000 && t < w.endsAt.getTime(), nextAt: new Date(next), ...w };
}

/** Open now? enabled, and opensAt <= now < closesAt. */
export function surveyOpen(cfg, now = new Date()) {
  const t = new Date(now).getTime();
  const a = parseWhen(cfg?.opensAt)?.getTime();
  const b = parseWhen(cfg?.closesAt)?.getTime();
  return !!cfg?.enabled && Number.isFinite(a) && Number.isFinite(b) && a <= t && t < b;
}

/** "How was TTFC 2026?" → "how_was_ttfc_2026" (≤ 40). */
export function slugOf(label) {
  const s = str(label).normalize("NFKD").replace(/\p{M}+/gu, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  const cut = s.slice(0, 32).replace(/_+$/g, "");
  return /^[a-z0-9]/.test(cut) ? cut : `q_${cut}`.replace(/_+$/g, "") || "q";
}

/**
 * The questions as management saved them (PUT /api/console/survey) → { questions } or { error, index }.
 * Added ones may come without an id: one is made from the label (unique, and never the id of a deleted question, so a
 * new question doesn't take over an old one's answers). Given ids must be slugs ([a-z0-9_-], ≤ 40) and unique.
 * `reserved`: ids not to make up (the deleted questions').
 */
export function cleanQuestions(list, { reserved = [] } = {}) {
  if (!Array.isArray(list) || !list.length) return { error: "Add at least one question." };
  if (list.length > MAX_QUESTIONS) return { error: `At most ${MAX_QUESTIONS} questions.` };
  const given = new Set();
  for (const [i, x] of list.entries()) {
    const id = x && typeof x === "object" ? str(x.id).trim() : "";
    if (!id) continue;
    if (!isSlug(id)) return { error: `Question ${i + 1}: the id "${id.slice(0, 40)}" must be lower-case letters, numbers, _ or - (up to 40).`, index: i };
    if (given.has(id)) return { error: `Question ${i + 1}: the id "${id}" is used twice.`, index: i };
    given.add(id);
  }
  const taken = new Set([...given, ...reserved.map(str)]);
  const out = [];
  let section = "";
  for (const [i, x] of list.entries()) {
    if (!x || typeof x !== "object") return { error: `Question ${i + 1} isn't a question.`, index: i };
    const at = `Question ${i + 1}`;
    const type = str(x.type).trim();
    if (!QUESTION_TYPES.includes(type)) return { error: `${at}: the type must be one of ${QUESTION_TYPES.join(", ")}.`, index: i };
    const label = oneLine(x.label);
    if (!label) return { error: `${at} needs a label.`, index: i };
    if (label.length > LIMITS.label) return { error: `${at}: the label is too long (up to ${LIMITS.label}).`, index: i };
    let id = str(x.id).trim();
    if (!id) {
      const base = slugOf(label);
      id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}_${n}`;
      taken.add(id);
    }
    if (x.section !== undefined) section = oneLine(x.section);
    if (section.length > LIMITS.section) return { error: `${at}: the section heading is too long (up to ${LIMITS.section}).`, index: i };
    const help = oneLine(x.help);
    if (help.length > LIMITS.help) return { error: `${at}: the help text is too long (up to ${LIMITS.help}).`, index: i };
    const q2 = { id, section, type, label, required: x.required === true };
    if (help) q2.help = help;
    if (type === "choice" || type === "multi") {
      const raw = Array.isArray(x.options) ? x.options : typeof x.options === "string" ? x.options.split("\n") : [];
      const options = [];
      for (const o of raw) {
        const t = oneLine(o);
        if (!t) continue;
        if (t.length > LIMITS.option) return { error: `${at}: an option is too long (up to ${LIMITS.option}).`, index: i };
        if (options.some((p) => p.toLowerCase() === t.toLowerCase())) return { error: `${at}: the option "${t}" is there twice.`, index: i };
        options.push(t);
      }
      if (options.length < 2) return { error: `${at} needs at least 2 options.`, index: i };
      if (options.length > LIMITS.options) return { error: `${at}: at most ${LIMITS.options} options.`, index: i };
      q2.options = options;
    }
    if (SCORED_TYPES.includes(type)) {
      for (const k of ["minLabel", "maxLabel"]) {
        const t = oneLine(x[k]);
        if (t.length > LIMITS.scaleLabel) return { error: `${at}: the scale's end labels are up to ${LIMITS.scaleLabel} characters.`, index: i };
        if (t) q2[k] = t;
      }
    }
    if (NA_TYPES.includes(type)) {
      if (x.allowNA !== undefined && typeof x.allowNA !== "boolean") return { error: `${at}: allowNA must be true or false.`, index: i };
      q2.allowNA = x.allowNA !== false;
    }
    if (x.showIf !== undefined && x.showIf !== null && x.showIf !== "") {
      // Shown only when an EARLIER choice / multi question's answer is (or includes) one of its options.
      const want = x.showIf && typeof x.showIf === "object" ? str(x.showIf.question).trim() : "";
      const option = x.showIf && typeof x.showIf === "object" ? oneLine(x.showIf.includes) : "";
      const target = out.find((y) => y.id === want);
      if (!target) {
        const later = list.slice(i).some((y) => y && str(y.id).trim() === want);
        return { error: `${at}: "show only if" must point to a choice question above it${later ? ` ("${want}" comes after it)` : ""}.`, index: i };
      }
      if (target.type !== "choice" && target.type !== "multi") return { error: `${at}: "show only if" must point to a choice question ("${want}" is ${target.type}).`, index: i };
      const hit = target.options.find((o) => o.toLowerCase() === option.toLowerCase());
      if (!hit) return { error: `${at}: "${option.slice(0, 60)}" isn't one of the options of "${target.label}".`, index: i };
      q2.showIf = { question: target.id, includes: hit };
    }
    out.push(q2);
  }
  return { questions: out };
}

/**
 * A save (PUT /api/console/survey, every field optional: what's left out stays) over the current config →
 * { config: the fields to store } or { error, field }. notifiedAt is never taken from a save. Questions deleted here
 * go to `retired` (their answers stay in the responses); one added again with the same id leaves it.
 */
export function cleanSurveySave(body, current) {
  const b = body && typeof body === "object" ? body : {};
  const cur = current || surveyConfig(null);
  const next = {};
  for (const k of ["enabled", "autoNotify", "checkedInOnly"]) {
    if (b[k] === undefined) continue;
    if (typeof b[k] !== "boolean") return { error: `${k} must be true or false.`, field: k };
    if (k === "autoNotify") {
      // Stored only when it changes (a whole-form save repeats what it shows), and then it's management's choice.
      if (b[k] !== cur.autoNotify) { next.autoNotify = b[k]; next.autoNotifyExplicit = true; }
      continue;
    }
    next[k] = b[k];
  }
  for (const [k, [lo, hi]] of Object.entries(PACE_LIMITS)) {
    if (b[k] === undefined) continue;
    const n = typeof b[k] === "number" ? b[k] : /^\s*\d+\s*$/.test(String(b[k])) ? Number(b[k]) : NaN;
    if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${k} must be a whole number from ${lo} to ${hi}.`, field: k };
    next[k] = n;
  }
  for (const k of ["opensAt", "closesAt"]) {
    if (b[k] === undefined) continue;
    const s = cleanWhen(b[k]);
    if (!s) return { error: `${k} must be a date and time with its offset, like 2026-10-27T16:00:00-04:00.`, field: k };
    next[k] = s;
  }
  const opens = parseWhen(next.opensAt || cur.opensAt);
  const closes = parseWhen(next.closesAt || cur.closesAt);
  if (opens && closes && closes <= opens) return { error: "The survey must close after it opens.", field: "closesAt" };
  for (const k of TEXT_FIELDS) {
    if (b[k] === undefined) continue;
    const s = k === "intro" || k === "thankYou" ? multiLine(b[k]) : oneLine(b[k]);
    if (REQUIRED_TEXT.has(k) && !s) return { error: `${k} can't be empty.`, field: k };
    if (s.length > LIMITS[k]) return { error: `${k} is too long (up to ${LIMITS[k]}).`, field: k };
    next[k] = s || SURVEY_DEFAULTS[k];
  }
  if (b.questions !== undefined) {
    const retiredNow = cur.retired || [];
    const c = cleanQuestions(b.questions, { reserved: [...retiredNow.map((x) => x.id), ...(cur.questions || []).map((x) => x.id)] });
    if (c.error) return { error: c.error, field: "questions", index: c.index };
    const ids = new Set(c.questions.map((x) => x.id));
    const removed = (cur.questions || []).filter((x) => !ids.has(x.id));
    const keep = retiredNow.filter((x) => !ids.has(x.id) && !removed.some((r) => r.id === x.id));
    next.questions = c.questions;
    next.retired = [...keep, ...removed.map(questionView)];
  }
  return { config: next };
}

/* ---------- answers ---------- */

const PLEASE = (x) => `Please answer: ${x.label}`;
const isBlank = (v) => v === undefined || v === null || (typeof v === "string" && !v.trim()) || (Array.isArray(v) && !v.length);

/** One answer, checked → { value } (undefined = not answered) or { error }. */
export function cleanAnswer(x, raw) {
  if (isBlank(raw)) return { value: undefined };
  if (allowsNA(x) && typeof raw === "string" && /^\s*(na|n\/a)\s*$/i.test(raw)) return { value: NA };
  switch (x.type) {
    case "rating":
    case "nps": {
      const n = typeof raw === "number" ? raw : /^\s*-?\d+\s*$/.test(str(raw)) ? Number(raw) : NaN;
      const [lo, hi] = x.type === "rating" ? [1, 5] : [0, 10];
      if (!Number.isInteger(n) || n < lo || n > hi) return { error: `${x.label}: choose ${lo} to ${hi}.` };
      return { value: n };
    }
    case "choice": {
      const t = oneLine(raw);
      const hit = (x.options || []).find((o) => o === t) || (x.options || []).find((o) => o.toLowerCase() === t.toLowerCase());
      return hit ? { value: hit } : { error: `${x.label}: choose one of the options.` };
    }
    case "multi": {
      const list = Array.isArray(raw) ? raw : [raw];
      const out = [];
      for (const r of list) {
        const t = oneLine(r);
        if (!t) continue;
        const hit = (x.options || []).find((o) => o === t) || (x.options || []).find((o) => o.toLowerCase() === t.toLowerCase());
        if (!hit) return { error: `${x.label}: choose from the options.` };
        if (!out.includes(hit)) out.push(hit);
      }
      return { value: out.length ? out : undefined };
    }
    case "consent": {
      if (raw === true || raw === "true" || raw === "yes" || raw === 1) return { value: true };
      if (raw === false || raw === "false" || raw === "no" || raw === 0) return { value: false };
      return { error: `${x.label}: tick the box or leave it.` };
    }
    case "text":
    case "longtext": {
      if (typeof raw !== "string" && typeof raw !== "number") return { error: `${x.label}: that isn't text.` };
      const t = x.type === "text" ? oneLine(raw) : multiLine(raw);
      const max = LIMITS[x.type];
      if (t.length > max) return { error: `${x.label}: up to ${max} characters, please (this is ${t.length}).` };
      if (x.id === "email" && t && !cleanEmail(t)) return { error: "Please enter a valid email address." };
      return { value: t ? (x.id === "email" ? cleanEmail(t) : t) : undefined };
    }
    default:
      return { value: undefined };
  }
}

/** Does this answer (a choice's string, a multi's list) pick `option`? */
const picks = (answer, option) => (Array.isArray(answer) ? answer.includes(option) : answer === option);

/**
 * A submission checked against the current questions → { ok: true, answers, unanswered, hidden } or
 * { ok: false, field, error }. `raw`: { [questionId]: value } (other keys are ignored). `fill`: the person's details
 * to fall back on for the identity questions left empty (the body's name / email / title / company, then their
 * account's). A question whose showIf isn't met (its question above not answered with that option, or itself not
 * shown) is hidden: its answer is ignored and it's never required. unanswered = the current questions sent empty or
 * hidden (a re-submission clears them; deleted questions' answers stay).
 */
export function cleanAnswers(questions = [], raw = {}, { fill = {} } = {}) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const answers = {};
  const unanswered = [];
  const hidden = [];
  const shown = new Set();
  for (const x of questions) {
    if (x.showIf && !(shown.has(x.showIf.question) && picks(answers[x.showIf.question], x.showIf.includes))) {
      hidden.push(x.id);
      unanswered.push(x.id);
      continue;
    }
    shown.add(x.id);
    let v = Object.prototype.hasOwnProperty.call(src, x.id) ? src[x.id] : undefined;
    if (IDENTITY_IDS.includes(x.id) && isBlank(v) && !isBlank(fill[x.id])) v = fill[x.id];
    const c = cleanAnswer(x, v);
    if (c.error) return { ok: false, field: x.id, error: c.error };
    const missing = c.value === undefined || (x.type === "consent" && c.value !== true);
    if (x.required && missing) return { ok: false, field: x.id, error: x.type === "consent" ? `Please tick: ${x.label}` : PLEASE(x) };
    if (c.value === undefined) unanswered.push(x.id);
    else answers[x.id] = c.value;
  }
  return { ok: true, answers, unanswered, hidden };
}

/** The response's own name / email / title / company: the answers, else what was sent, else what we know. */
export function respondentFields(answers = {}, body = {}, known = {}) {
  const pick = (k, clean = oneLine, max = LIMITS.text) => {
    for (const v of [answers[k], body[k], known[k]]) { const s = clean(v); if (s) return s.slice(0, max); }
    return "";
  };
  return { name: pick("name"), email: pick("email", cleanEmail, 254), title: pick("title"), company: pick("company") };
}

/* ---------- personal links ---------- */

const PURPOSE = "ttfc-survey:v1";
const SIG_BYTES = 16;   // 22 base64url characters
const TOKEN = /^([A-Za-z0-9_-]{4,120})\.([A-Za-z0-9_-]{22})$/;
const KINDS = new Set(["u", "p"]);

/** The links' key, derived from JWT_SECRET (never the secret itself); null without one. */
export function surveySecret(env = process.env) {
  const base = str(env.JWT_SECRET);
  return base ? crypto.createHmac("sha256", base).update("ttfc-survey-link:v1").digest() : null;
}
const mac = (body, key) => crypto.createHmac("sha256", key).update(`${PURPOSE}:${body}`).digest().subarray(0, SIG_BYTES).toString("base64url");

/** kind "u" (account id) or "p" (Attendee id, a pass with no account) → the token ("" without a secret or an id). */
export function signSurveyToken(kind, id, key = surveySecret()) {
  const s = str(id);
  if (!key || !KINDS.has(kind) || !/^[a-f0-9]{24}$/i.test(s)) return "";
  const body = Buffer.from(`${kind}:${s.toLowerCase()}`).toString("base64url");
  return `${body}.${mac(body, key)}`;
}

/** The token → { kind, id }, or null (not ours, changed, or not a token). Constant-time. Never throws. */
export function verifySurveyToken(token, key = surveySecret()) {
  const m = TOKEN.exec(str(token).trim());
  if (!key || !m) return null;
  const want = Buffer.from(mac(m[1], key));
  const got = Buffer.from(m[2]);
  if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return null;
  const [kind, id] = Buffer.from(m[1], "base64url").toString("utf8").split(":");
  return KINDS.has(kind) && /^[a-f0-9]{24}$/.test(id || "") ? { kind, id } : null;
}

/** The survey page, with a personal token when there is one. */
export const surveyUrl = (token = "") => (token ? `${SURVEY_PAGE}?t=${encodeURIComponent(token)}` : SURVEY_PAGE);

/* ---------- what the routes answer ---------- */

/**
 * GET /api/survey. By invitation: without a personal link or the app's sign-in (`invited`), only the title and the
 * window; invited but not checked in (`eligible` false), the same and a message; otherwise the survey, questions only
 * while open. Staff's preview (`preview`) always shows the questions.
 */
export function publicSurvey(cfg, { now = new Date(), preview = false, invited = false, eligible = false, respondent = null, responded = false } = {}) {
  const open = surveyOpen(cfg, now);
  const head = { open, opensAt: cfg.opensAt, closesAt: cfg.closesAt, title: cfg.title, invitationOnly: true };
  if (!preview && !invited) return { ...head, questions: [] };
  if (!preview && !eligible) return { ...head, eligible: false, message: NOT_ATTENDED_MESSAGE, questions: [] };
  return {
    ...head, eligible: !!eligible, intro: cfg.intro, thankYou: cfg.thankYou,
    questions: open || preview ? cfg.questions.map(questionView) : [],
    respondent: respondent || null, responded: !!responded,
    ...(preview ? { preview: true } : {}),
  };
}

/** GET /api/app/survey: the app's card. show = open, may answer (`eligible`: canAnswer) and not answered yet. */
export function appSurveyCard(cfg, { now = new Date(), responded = false, eligible = true, token = "" } = {}) {
  const open = surveyOpen(cfg, now);
  return {
    show: open && !!eligible && !responded, open, eligible: !!eligible, responded: !!responded, opensAt: cfg.opensAt, closesAt: cfg.closesAt,
    title: cfg.title, body: cfg.notifyBody, cta: CTA, url: surveyUrl(token),
  };
}

/** Averages of the scored questions from an aggregation's row ({ q_<id>: avg }; "na" isn't a number, so it's never
    in one) → { [id]: n (2 decimals) | null (no scores yet) }. */
export function averagesOf(questions = [], row = {}) {
  const out = {};
  for (const x of questions) {
    if (!SCORED_TYPES.includes(x.type)) continue;
    const v = row?.[`q_${x.id}`];
    out[x.id] = typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
  }
  return out;
}

/** "Not applicable" counts from an aggregation's row ({ na_<id>: n }) → { [id]: n } for every question that takes it. */
export function naCountsOf(questions = [], row = {}) {
  const out = {};
  for (const x of questions) if (NA_TYPES.includes(x.type)) out[x.id] = Number(row?.[`na_${x.id}`]) || 0;
  return out;
}

/** The aggregation's $group for averagesOf and naCountsOf (question ids are slugs: safe as field names). */
export function scoreGroup(questions = []) {
  const g = { _id: null };
  for (const x of questions) {
    if (SCORED_TYPES.includes(x.type)) g[`q_${x.id}`] = { $avg: `$answers.${x.id}` };   // $avg skips "na" and blanks
    if (NA_TYPES.includes(x.type)) g[`na_${x.id}`] = { $sum: { $cond: [{ $eq: [`$answers.${x.id}`, NA] }, 1, 0] } };
  }
  return g;
}

/** One response for the admin list. */
export function responseRow(r) {
  return {
    id: str(r._id), at: r.submittedAt || r.updatedAt || r.createdAt || null, firstAt: r.createdAt || null, count: Number(r.count) || 1,
    source: str(r.source) || "link", name: str(r.name), email: str(r.email), title: str(r.title), company: str(r.company),
    userId: r.userId ? str(r.userId) : null, answers: r.answers && typeof r.answers === "object" ? r.answers : {},
  };
}

const answerText = (v) => (Array.isArray(v) ? v.join("; ") : typeof v === "boolean" ? (v ? "Yes" : "No") : v === NA ? "N/A" : str(v));

/**
 * The spreadsheet: one row per response, one column per question (current ones in order), then a column for each
 * deleted question anyone answered, its label + " (removed)" (answers under an id no question has: the id). The
 * person's name / email / title / company get their own columns when those questions aren't there. Formula-escaped
 * cells (csvCell), a BOM so Excel reads it as UTF-8.
 */
export function responsesCsv(rows = [], { questions = [], retired = [] } = {}) {
  const current = new Set(questions.map((x) => x.id));
  const answered = new Set();
  for (const r of rows) for (const [k, v] of Object.entries(r?.answers || {})) if (!isBlank(v)) answered.add(k);
  const removed = [];
  for (const x of retired) if (!current.has(x.id) && answered.has(x.id) && !removed.some((y) => y.id === x.id)) removed.push(x);
  const known = new Set([...current, ...removed.map((x) => x.id)]);
  const orphan = [...answered].filter((k) => !known.has(k)).sort();
  const identity = IDENTITY_IDS.filter((k) => !current.has(k));
  const LABEL = { name: "Name", email: "Email", title: "Title", company: "Company" };
  const head = [
    "Submitted (UTC)", "First submitted (UTC)", "Times submitted", "Source", ...identity.map((k) => LABEL[k]),
    ...questions.map((x) => x.label), ...removed.map((x) => `${x.label} (removed)`), ...orphan.map((k) => `${k} (removed)`),
  ];
  const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "");
  const lines = rows.map((r) => {
    const a = r?.answers || {};
    return [
      when(r.submittedAt || r.updatedAt), when(r.createdAt), Number(r.count) || 1, r.source || "link", ...identity.map((k) => r[k] || ""),
      ...questions.map((x) => answerText(a[x.id])), ...removed.map((x) => answerText(a[x.id])), ...orphan.map((k) => answerText(a[k])),
    ].map(csvCell).join(",");
  });
  return "\uFEFF" + [head.map(csvCell).join(","), ...lines].join("\n");
}

/* ---------- who checked in, the email's audience ---------- */

/** The marks that are a door check-in: arrived in the lobby, checked in at the pass desk or by the door scanner. */
export const DOOR_POINTS = Object.freeze(["arrived", "checked_in"]);
const DOOR = new Set(DOOR_POINTS);

/**
 * The people with a door check-in on these days (the check-in desk's marks, services/checkinDesk.js; practice marks
 * never count), each once (the People directory joins a person's passes: routes/people.js directory()).
 *   byId: the directory's id → person ("t-<ticket>", "u-<account>", "a-<pass>" …); marks: CheckinMark rows
 * → { persons: [person], unmatched (marks of a pass or person not in the directory) }
 */
export function checkedInPersons({ byId = new Map(), marks = [], days = EVENT_DAYS } = {}) {
  const want = new Set(days);
  const seen = new Set();
  const persons = [];
  let unmatched = 0;
  for (const m of marks || []) {
    if (!m?.at || m.practice || !want.has(m.day) || !DOOR.has(m.point)) continue;
    const s = str(m.subject);
    if (!s || s.startsWith("booth:") || s.startsWith("u:")) continue;
    const p = s.startsWith("person:") ? byId.get(s.slice("person:".length)) : byId.get(`t-${s}`);
    if (!p) { unmatched += 1; continue; }
    if (seen.has(p)) continue;
    seen.add(p);
    persons.push(p);
  }
  return { persons, unmatched };
}

/** A person's email addresses (the directory's main one and every one their passes carry), cleaned. */
export const personEmails = (p) => [...new Set([p?.email, ...(p?.emails || []), p?.user?.email].map(cleanEmail).filter(Boolean))];

/** Accounts and addresses of the people who checked in: { userIds: Set, emails: Set }. */
export function checkedInKeys(persons = []) {
  const userIds = new Set();
  const emails = new Set();
  for (const p of persons) {
    if (p?.user?._id) userIds.add(str(p.user._id));
    for (const e of personEmails(p)) emails.add(e);
  }
  return { userIds, emails };
}

const emailIndexes = new WeakMap();
/** The directory's people by each of their addresses (kept per directory copy). */
function emailIndex(dir) {
  const people = dir?.people || [];
  if (emailIndexes.has(people)) return emailIndexes.get(people);
  const idx = new Map();
  for (const p of people) for (const e of personEmails(p)) { if (!idx.has(e)) idx.set(e, []); idx.get(e).push(p); }
  emailIndexes.set(people, idx);
  return idx;
}

/** The directory's people who are this account, this pass, or share this email address. */
export function personsMatching(dir, { userId = "", attendeeId = "", email = "" } = {}) {
  const out = new Set();
  const byId = dir?.byId || new Map();
  if (userId && byId.get(`u-${userId}`)) out.add(byId.get(`u-${userId}`));
  if (attendeeId && byId.get(`a-${attendeeId}`)) out.add(byId.get(`a-${attendeeId}`));
  const e = cleanEmail(email);
  if (e) for (const p of emailIndex(dir).get(e) || []) out.add(p);
  return [...out];
}

/** Every mark subject these people's check-ins are recorded under: their passes (normalized ticket IDs) and their
    ISSUE PASS ids ("person:u-…", "person:a-…", …). */
export function personSubjects(persons = []) {
  const out = new Set();
  for (const p of persons) {
    for (const norm of p?.tickets instanceof Map ? p.tickets.keys() : []) out.add(str(norm));
    for (const id of personAliasIds(p)) out.add(personSubject(id));
  }
  return [...out];
}

/** The best way to send a person a link: their account, else the pass on that address, else their first pass. */
export function linkTarget(p, email = "") {
  if (!p) return null;
  if (p.user?._id) return { kind: "u", id: str(p.user._id) };
  const e = cleanEmail(email);
  const a = (p.attendees || []).find((x) => e && cleanEmail(x?.email) === e) || (p.attendees || [])[0];
  return a?._id ? { kind: "p", id: str(a._id) } : null;
}

/**
 * Who had a door check-in on these days, each person once, then each email address once (the survey email).
 *   byId: the directory; marks: CheckinMark rows ({ subject, day, point, at, practice })
 * → { rows: [{ key, personId, userId, attendeeId, name, firstName, email, title, company }], noEmail, unmatched }
 */
export function checkedInAudience({ byId = new Map(), marks = [], days = AUDIENCES.both } = {}) {
  const { persons, unmatched } = checkedInPersons({ byId, marks, days });
  const emails = new Set();
  const rows = [];
  let noEmail = 0;
  for (const p of persons) {
    const email = cleanEmail(p.email);
    if (!email) { noEmail += 1; continue; }
    if (emails.has(email)) continue;
    emails.add(email);
    const name = str(p.name) === "No name" ? "" : oneLine(p.name);
    const attendee = (p.attendees || []).find((a) => cleanEmail(a?.email) === email) || (p.attendees || [])[0] || null;
    rows.push({
      key: str(p.id), personId: str(p.id), userId: p.user?._id ? str(p.user._id) : null, attendeeId: attendee?._id ? str(attendee._id) : null,
      name, firstName: oneLine(p.firstName) || name.split(" ")[0] || "", email, title: oneLine(p.jobTitle), company: oneLine(p.company),
    });
  }
  return { rows, noEmail, unmatched };
}

/* ---------- who answered (the admin panel's tracking list) ---------- */

/* Oct 26 2026, the organiser: "If they fill the survey, that should update the admin panel and I should see that so
   that I don't end up resending the survey request to them." Everyone with a door check-in, each address once, with
   when they were emailed (the survey email's CampaignSend rows), prompted in the app (the prompt's AppNotification
   rows) and answered (SurveyResponse rows, matched by their account, any of their passes or any of their addresses). */

const minDate = (a, b) => (!a ? b : !b ? a : (new Date(a) < new Date(b) ? a : b));
const maxDate = (a, b) => (!a ? b : !b ? a : (new Date(a) > new Date(b) ? a : b));
const isoOrNull = (d) => (d ? new Date(d).toISOString() : null);

/**
 * The sends and answers, indexed → statusOf({ userIds, attendeeIds, emails }) → { emailedAt, appNotifiedAt,
 * answeredAt (first answer), updatedAt (last), source } (ISO strings or null).
 *   sends: [{ email, sentAt }] (sent survey emails); notes: [{ userId, createdAt }]; responses: SurveyResponse rows.
 */
export function trackingIndex({ sends = [], notes = [], responses = [] } = {}) {
  const sentAt = new Map();
  for (const r of sends) { const e = cleanEmail(r?.email); if (e && r.sentAt) sentAt.set(e, minDate(sentAt.get(e), r.sentAt)); }
  const notified = new Map();
  for (const n of notes) { const id = str(n?.userId); if (id) notified.set(id, minDate(notified.get(id), n.createdAt)); }
  const by = { u: new Map(), a: new Map(), e: new Map() };
  const add = (m, k, r) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(r); };
  for (const r of responses) { add(by.u, r?.userId ? str(r.userId) : "", r); add(by.a, r?.attendeeId ? str(r.attendeeId) : "", r); add(by.e, cleanEmail(r?.email), r); }
  return function statusOf({ userIds = [], attendeeIds = [], emails = [] } = {}) {
    const found = new Set();
    for (const id of userIds) for (const r of by.u.get(str(id)) || []) found.add(r);
    for (const id of attendeeIds) for (const r of by.a.get(str(id)) || []) found.add(r);
    for (const e of emails) for (const r of by.e.get(cleanEmail(e)) || []) found.add(r);
    let answeredAt = null; let updatedAt = null; let source = "";
    for (const r of found) {
      answeredAt = minDate(answeredAt, r.createdAt || r.submittedAt);
      const last = r.submittedAt || r.updatedAt || r.createdAt;
      if (!updatedAt || new Date(last) > new Date(updatedAt)) { updatedAt = last; source = str(r.source); }
    }
    let emailedAt = null;
    for (const e of emails) emailedAt = minDate(emailedAt, sentAt.get(cleanEmail(e)));
    let appNotifiedAt = null;
    for (const id of userIds) appNotifiedAt = minDate(appNotifiedAt, notified.get(str(id)));
    return { emailedAt: isoOrNull(emailedAt), appNotifiedAt: isoOrNull(appNotifiedAt), answeredAt: isoOrNull(answeredAt), updatedAt: isoOrNull(updatedAt), source };
  };
}

/** The ids and addresses a group of directory people go by (for statusOf). */
export const personKeys = (persons = []) => ({
  userIds: persons.map((p) => p?.user?._id).filter(Boolean).map(str),
  attendeeIds: persons.flatMap((p) => (p?.attendees || []).map((a) => (a?._id ? str(a._id) : ""))).filter(Boolean),
  emails: [...new Set(persons.flatMap(personEmails))],
});

/**
 * The tracking list. `byDay`: { day1: [person], day2: [person] } (checkedInPersons for each day); `statusOf`:
 * trackingIndex(). Each address once (people on the same address are one row). → [{ name, email, company, onApp,
 * checkedInDays, emailedAt, appNotifiedAt, answeredAt, updatedAt, source, personId }]
 */
export function trackingRows({ byDay = {}, statusOf = () => ({}) } = {}) {
  const groups = [];
  const byEmail = new Map();
  const seen = new Map();
  for (const [day, persons] of Object.entries(byDay)) {
    for (const p of persons || []) {
      let g = seen.get(p);
      if (!g) {
        const email = cleanEmail(p.email) || personEmails(p)[0] || "";
        g = email ? byEmail.get(email) : null;
        if (!g) { g = { email, persons: [], days: new Set() }; groups.push(g); if (email) byEmail.set(email, g); }
        g.persons.push(p);
        seen.set(p, g);
      }
      g.days.add(day);
    }
  }
  return groups.map((g) => {
    const main = g.persons.find((p) => p.user?._id) || g.persons[0];
    const name = str(main?.name) === "No name" ? "" : oneLine(main?.name);
    const st = statusOf(personKeys(g.persons));
    return {
      name, email: g.email, company: oneLine(main?.company),
      onApp: g.persons.some((p) => !!(p.user && (p.user.appOnboarded || p.user.lastActiveAt))),
      checkedInDays: ["day1", "day2"].filter((d) => g.days.has(d)),
      emailedAt: st.emailedAt || null, appNotifiedAt: st.appNotifiedAt || null, answeredAt: st.answeredAt || null,
      updatedAt: st.updatedAt || null, source: st.source || "", personId: str(main?.id),
    };
  });
}

export const TRACKING_STATUSES = Object.freeze(["all", "answered", "not_answered", "emailed", "not_emailed"]);

/** Filter (status, q: name / email / company) and sort (not answered first, then by name). */
export function filterTracking(rows = [], { status = "all", q = "" } = {}) {
  const want = TRACKING_STATUSES.includes(status) ? status : "all";
  const needle = oneLine(q).toLowerCase();
  const keep = rows.filter((r) => {
    if (want === "answered" && !r.answeredAt) return false;
    if (want === "not_answered" && r.answeredAt) return false;
    if (want === "emailed" && !r.emailedAt) return false;
    if (want === "not_emailed" && r.emailedAt) return false;
    return !needle || [r.name, r.email, r.company].some((v) => str(v).toLowerCase().includes(needle));
  });
  return keep.sort((a, b) => (!!a.answeredAt - !!b.answeredAt) || (a.name || a.email).localeCompare(b.name || b.email, "en", { sensitivity: "base" }));
}

/** The list's totals: { checkedIn, answered, notAnswered, emailed, appNotified, onApp }. */
export function trackingCounts(rows = []) {
  const n = (f) => rows.filter(f).length;
  return {
    checkedIn: rows.length, answered: n((r) => r.answeredAt), notAnswered: n((r) => !r.answeredAt), emailed: n((r) => r.emailedAt),
    appNotified: n((r) => r.appNotifiedAt), onApp: n((r) => r.onApp),
  };
}

/** The tracking list as a spreadsheet (BOM, formula-escaped). */
export function trackingCsv(rows = []) {
  const when = (d) => (d ? new Date(d).toISOString().replace("T", " ").slice(0, 19) : "");
  const head = ["Name", "Email", "Company", "On the app", "Checked in", "Emailed (UTC)", "Prompted in the app (UTC)", "Answered (UTC)", "Last updated (UTC)", "Source"];
  const DAY = { day1: "Day 1", day2: "Day 2" };
  const lines = rows.map((r) => [
    r.name, r.email, r.company, r.onApp ? "Yes" : "No", r.checkedInDays.map((d) => DAY[d]).join(", "),
    when(r.emailedAt), when(r.appNotifiedAt), when(r.answeredAt), when(r.updatedAt), r.source,
  ].map(csvCell).join(","));
  return "﻿" + [head.map(csvCell).join(","), ...lines].join("\n");
}
