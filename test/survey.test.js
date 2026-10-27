/* The post-event survey (Oct 26 2026): the defaults, the window, saving questions (add, edit, delete), the answers'
   checks (skip, N/A, show-only-if), the personal links, the CSV, the email's audience and the email. Pure. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_QUESTIONS, SURVEY_DEFAULTS, surveyConfig, surveyOpen, cleanQuestions, cleanSurveySave, cleanAnswers, cleanAnswer,
  respondentFields, signSurveyToken, verifySurveyToken, surveyUrl, publicSurvey, appSurveyCard, averagesOf, naCountsOf,
  scoreGroup, responsesCsv, checkedInAudience, slugOf, AUDIENCES, cleanWhen, checkedInPersons, checkedInKeys, personsMatching,
  personSubjects, linkTarget, INVITE_ONLY_MESSAGE, NOT_ATTENDED_MESSAGE,
} from "../services/surveyRules.js";
import { buildSurveyEmail, surveyMessage, sendSurveyBatch, SURVEY_SUBJECT } from "../services/surveyEmail.js";

const cfg = surveyConfig(null);
const ids = (list) => list.map((x) => x.id);

test("defaults: open Tue 4 PM to Nov 30, nothing sent by itself, the questions in their sections and order", () => {
  assert.deepEqual([cfg.enabled, cfg.autoNotify, cfg.notifiedAt, cfg.saved], [true, false, null, false]);
  assert.equal(SURVEY_DEFAULTS.autoNotify, false);   // the organiser reviews it first
  assert.equal(new Date(cfg.opensAt).toISOString(), "2026-10-27T20:00:00.000Z");
  assert.equal(new Date(cfg.closesAt).toISOString(), "2026-12-01T04:59:00.000Z");
  assert.deepEqual([cfg.title, cfg.thankYou, cfg.notifyTitle], ["How was TTFC 2026?", "Thank you! Your feedback helps shape TTFC 2027.", "How was TTFC 2026?"]);
  assert.deepEqual([...new Set(cfg.questions.map((x) => x.section))], ["Your TTFC 2026", "Content and production", "Speaking at TTFC", "In your words", "About you"]);
  assert.deepEqual(ids(cfg.questions), [
    "role", "checkin", "meals", "food", "interactions", "again", "recommend", "better",
    "content", "speakers", "formats", "agenda", "production", "venue", "app", "topics_2027",
    "sp_onboarding", "sp_comms", "sp_session", "sp_hosting", "sp_av", "sp_stage", "sp_again", "sp_better",
    "to_delegates", "to_exhibitors", "to_sponsors", "consent", "name", "email", "title", "company",
  ]);
  // Everything can be skipped but the name and email.
  assert.deepEqual(ids(cfg.questions.filter((x) => x.required)), ["name", "email"]);
  // N/A on every rating, nps and choice; never on the others.
  for (const x of cfg.questions) assert.equal(x.allowNA, ["rating", "nps", "choice"].includes(x.type) ? true : undefined, x.id);
  // The speakers' section only for people who ticked Speaker.
  for (const x of cfg.questions.filter((y) => y.section === "Speaking at TTFC")) assert.deepEqual(x.showIf, { question: "role", includes: "Speaker" }, x.id);
  const by = Object.fromEntries(cfg.questions.map((x) => [x.id, x]));
  assert.deepEqual(by.again.options, ["Yes, definitely", "Probably", "Not sure", "No"]);
  assert.deepEqual(by.sp_again.options, ["Yes", "Maybe", "No"]);
  assert.deepEqual([by.recommend.type, by.recommend.minLabel, by.recommend.maxLabel], ["nps", "Not at all", "Extremely"]);
  assert.equal(by.to_delegates.help, "We'd love to share what you think with future attendees. Answer any that apply.");
  assert.equal(by.to_exhibitors.label, "What would you tell someone thinking of exhibiting?");
  assert.equal(by.topics_2027.type, "longtext");
  // The defaults pass their own checks.
  assert.equal(cleanQuestions(DEFAULT_QUESTIONS).questions.length, 32);
});

test("the window: enabled and opensAt <= now < closesAt", () => {
  assert.equal(surveyOpen(cfg, new Date("2026-10-27T19:59:59Z")), false);
  assert.equal(surveyOpen(cfg, new Date("2026-10-27T20:00:00Z")), true);
  assert.equal(surveyOpen(cfg, new Date("2026-12-01T04:59:00Z")), false);
  assert.equal(surveyOpen({ ...cfg, enabled: false }, new Date("2026-10-28T12:00:00Z")), false);
  const shut = publicSurvey(cfg, { now: new Date("2026-10-27T12:00:00Z"), invited: true, eligible: true });
  assert.deepEqual([shut.open, shut.questions.length, shut.respondent, shut.responded], [false, 0, null, false]);
  assert.equal(publicSurvey(cfg, { now: new Date("2026-10-27T12:00:00Z"), preview: true }).questions.length, 32);
  const card = appSurveyCard(cfg, { now: new Date("2026-10-28T12:00:00Z"), token: "abc.def" });
  assert.deepEqual([card.show, card.eligible, card.cta, card.url, card.title, card.body], [true, true, "Share feedback", "https://www.thetechfestival.com/survey?t=abc.def", cfg.title, cfg.notifyBody]);
  assert.equal(appSurveyCard(cfg, { now: new Date("2026-10-28T12:00:00Z"), responded: true }).show, false);
  // Not checked in: no card.
  assert.deepEqual(Object.values(appSurveyCard(cfg, { now: new Date("2026-10-28T12:00:00Z"), eligible: false })).slice(0, 3), [false, true, false]);
  assert.equal(cleanWhen("2026-10-27 16:00"), "");
  assert.equal(cleanWhen("2026-10-27T16:00:00-04:00"), "2026-10-27T16:00:00-04:00");
});

test("saving questions: add (an id made from the label), edit every field, delete (kept as retired)", () => {
  const list = cfg.questions.map((x) => ({ ...x }));
  // Edit: a label, a type change, options, required, help, the scale's labels, N/A off.
  const meals = list.find((x) => x.id === "meals");
  Object.assign(meals, { label: "Meals", help: "Breakfast, lunch and dinner", required: true, minLabel: "Poor", maxLabel: "Great", allowNA: false });
  const again = list.find((x) => x.id === "again");
  again.options = ["Yes", "No"];
  // Add two without ids (one with the same label as a deleted question) and one with an id.
  const food = list.findIndex((x) => x.id === "food");
  list.splice(food, 1);   // delete "food"
  list.push({ section: "Extra", type: "rating", label: "Food" });
  list.push({ type: "text", label: "Coffee?" });
  list.push({ id: "wifi", section: "Extra", type: "choice", label: "Wi-Fi", options: ["Good", "Bad"] });
  const r = cleanSurveySave({ questions: list }, cfg);
  assert.equal(r.error, undefined, r.error);
  const q = r.config.questions;
  const by = Object.fromEntries(q.map((x) => [x.id, x]));
  assert.deepEqual([by.meals.label, by.meals.help, by.meals.required, by.meals.minLabel, by.meals.maxLabel, by.meals.allowNA], ["Meals", "Breakfast, lunch and dinner", true, "Poor", "Great", false]);
  assert.deepEqual(by.again.options, ["Yes", "No"]);
  // "food" was deleted: the new "Food" question gets food_2, so it never takes over the old one's answers.
  assert.equal(by.food, undefined);
  assert.deepEqual([by.food_2.section, by.food_2.type, by.food_2.allowNA], ["Extra", "rating", true]);
  assert.equal(by.coffee.section, "Extra");   // a question without a section takes the one above
  assert.deepEqual(by.wifi.options, ["Good", "Bad"]);
  assert.deepEqual(r.config.retired.map((x) => [x.id, x.label]), [["food", "Food quality"]]);
  // Adding "food" back with its id brings it out of retired.
  const back = cleanSurveySave({ questions: [...q, { id: "food", type: "rating", label: "Food quality" }] }, { ...cfg, questions: q, retired: r.config.retired });
  assert.deepEqual(back.config.retired, []);
  // Deleting again keeps the earlier deleted ones too.
  const again2 = cleanSurveySave({ questions: q.filter((x) => x.id !== "wifi") }, { ...cfg, questions: q, retired: r.config.retired });
  assert.deepEqual(again2.config.retired.map((x) => x.id), ["food", "wifi"]);
});

test("saving questions: what's refused", () => {
  const ok = { id: "a", type: "rating", label: "A" };
  const bad = (list) => cleanQuestions(list).error;
  assert.match(bad([]), /at least one/);
  assert.match(bad(Array.from({ length: 41 }, (_, i) => ({ ...ok, id: `q${i}` }))), /At most 40/);
  assert.match(bad([ok, { ...ok }]), /used twice/);
  assert.match(bad([{ ...ok, id: "Bad Id" }]), /lower-case/);
  assert.match(bad([{ ...ok, type: "slider" }]), /type must be/);
  assert.match(bad([{ ...ok, label: " " }]), /needs a label/);
  assert.match(bad([{ id: "c", type: "choice", label: "C", options: ["Only"] }]), /at least 2 options/);
  assert.match(bad([{ id: "c", type: "multi", label: "C", options: ["X", "x"] }]), /twice/);
  assert.match(bad([{ ...ok, allowNA: "yes" }]), /allowNA/);
  // showIf: an existing choice / multi question above it, and one of its options.
  const role = { id: "role", type: "multi", label: "Role", options: ["Speaker", "Delegate"] };
  assert.match(bad([{ ...ok, showIf: { question: "nope", includes: "x" } }]), /show only if/);
  assert.match(bad([{ ...ok, showIf: { question: "role", includes: "Speaker" } }, role]), /comes after it/);
  assert.match(bad([ok, { id: "b", type: "rating", label: "B", showIf: { question: "a", includes: "1" } }]), /choice question \("a" is rating\)/);
  assert.match(bad([role, { ...ok, showIf: { question: "role", includes: "Chef" } }]), /isn't one of the options/);
  assert.deepEqual(cleanQuestions([role, { ...ok, showIf: { question: "role", includes: "speaker" } }]).questions[1].showIf, { question: "role", includes: "Speaker" });
  // The rest of the config.
  assert.match(cleanSurveySave({ opensAt: "tomorrow" }, cfg).error, /offset/);
  assert.match(cleanSurveySave({ closesAt: "2026-10-27T15:00:00-04:00" }, cfg).error, /close after it opens/);
  assert.match(cleanSurveySave({ autoNotify: "yes" }, cfg).error, /true or false/);
  assert.match(cleanSurveySave({ notifyTitle: "x".repeat(81) }, cfg).error, /too long/);
  assert.deepEqual(cleanSurveySave({ notifiedAt: "2026-10-27T20:00:00Z", autoNotify: true }, cfg).config, { autoNotify: true });   // never notifiedAt
  assert.equal(slugOf("How was TTFC 2026?"), "how_was_ttfc_2026");
  assert.equal(slugOf("¿¿"), "q");
});

test("answers: skip, N/A, the types, required, the person's details", () => {
  const qs = cfg.questions;
  const base = { name: "Ann Example", email: "Ann@Example.com" };
  const r = cleanAnswers(qs, { ...base, checkin: 5, meals: "na", recommend: "N/A", again: "probably", role: ["Delegate", "Media"], better: "  More coffee \n\n please ", consent: true, food: "" });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.answers, { role: ["Delegate", "Media"], checkin: 5, meals: "na", again: "Probably", recommend: "na", better: "More coffee\n\n please", consent: true, name: "Ann Example", email: "ann@example.com" });
  assert.ok(r.unanswered.includes("food"));   // blank = skipped, not stored
  // Everything skipped but the name and email: fine.
  assert.equal(cleanAnswers(qs, base).ok, true);
  // Name and email are required (from the details sent alongside, or what we know).
  assert.deepEqual(cleanAnswers(qs, { email: "a@example.com" }).field, "name");
  assert.equal(cleanAnswers(qs, {}, { fill: { name: "Ann", email: "ann@example.com" } }).ok, true);
  assert.match(cleanAnswers(qs, { ...base, email: "not-an-email" }).error, /valid email/);
  for (const [id, v] of [["checkin", 6], ["checkin", 0], ["checkin", 2.5], ["recommend", 11], ["again", "Maybe"], ["role", ["Chef"]], ["consent", "perhaps"]]) {
    assert.equal(cleanAnswers(qs, { ...base, [id]: v }).field, id, `${id}=${JSON.stringify(v)}`);
  }
  assert.equal(cleanAnswers(qs, { ...base, recommend: 0 }).answers.recommend, 0);
  assert.equal(cleanAnswers(qs, { ...base, checkin: "4" }).answers.checkin, 4);
  // Text caps: 200 for a line, 4000 for longtext.
  assert.equal(cleanAnswers(qs, { ...base, title: "x".repeat(201) }).field, "title");
  assert.equal(cleanAnswers(qs, { ...base, better: "x".repeat(4001) }).field, "better");
  assert.equal(cleanAnswers(qs, { ...base, better: "x".repeat(4000) }).ok, true);
  // N/A only where allowNA: not on text, not where it's switched off; it counts as an answer to a required question.
  assert.equal(cleanAnswer({ id: "t", type: "text", label: "T" }, "na").value, "na");   // just the word, as text
  assert.equal(cleanAnswer({ id: "r", type: "rating", label: "R", allowNA: false }, "na").error !== undefined, true);
  assert.equal(cleanAnswers([{ id: "r", type: "rating", label: "R", required: true, allowNA: true }], { r: "na" }).ok, true);
  assert.equal(cleanAnswers([{ id: "r", type: "rating", label: "R", required: true }], {}).field, "r");
  // A required consent must be ticked.
  assert.equal(cleanAnswers([{ id: "c", type: "consent", label: "C", required: true }], { c: false }).field, "c");
  assert.deepEqual(respondentFields({ name: "Ann" }, { email: "ANN@example.com" }, { title: "CTO", company: "Acme" }), { name: "Ann", email: "ann@example.com", title: "CTO", company: "Acme" });
});

test("show-only-if: hidden questions are ignored and never required; shown ones are checked", () => {
  const qs = cfg.questions;
  const base = { name: "Sam", email: "sam@example.com" };
  // Not a speaker: the speakers' answers are dropped (and cleared on a re-send), never refused.
  const del = cleanAnswers(qs, { ...base, role: ["Delegate"], sp_av: 99, sp_again: "Chef" });
  assert.equal(del.ok, true, del.error);
  assert.equal(del.answers.sp_av, undefined);
  assert.ok(del.hidden.includes("sp_av") && del.unanswered.includes("sp_av"));
  // No role at all: hidden too.
  assert.equal(cleanAnswers(qs, { ...base, sp_av: 4 }).answers.sp_av, undefined);
  // A speaker: shown, checked, kept.
  const sp = cleanAnswers(qs, { ...base, role: ["Speaker", "Delegate"], sp_av: 4, sp_again: "na", sp_better: "Earlier briefings" });
  assert.deepEqual([sp.answers.sp_av, sp.answers.sp_again, sp.answers.sp_better, sp.hidden.length], [4, "na", "Earlier briefings", 0]);
  assert.equal(cleanAnswers(qs, { ...base, role: ["Speaker"], sp_av: 9 }).field, "sp_av");
  // A required question behind showIf isn't required while it's hidden; a chain hides with its parent.
  const chain = [
    { id: "kind", type: "choice", label: "Kind", options: ["A", "B"] },
    { id: "sub", type: "choice", label: "Sub", options: ["X", "Y"], required: true, showIf: { question: "kind", includes: "A" } },
    { id: "deep", type: "rating", label: "Deep", required: true, showIf: { question: "sub", includes: "X" } },
  ];
  assert.equal(cleanAnswers(chain, { kind: "B", deep: 3 }).ok, true);
  assert.equal(cleanAnswers(chain, { kind: "B", deep: 3 }).answers.deep, undefined);
  assert.equal(cleanAnswers(chain, { kind: "A" }).field, "sub");
  assert.equal(cleanAnswers(chain, { kind: "A", sub: "X" }).field, "deep");
  // "na" on the parent hides its children.
  assert.equal(cleanAnswers(chain, { kind: "na" }).ok, true);
});

test("averages leave N/A out; N/A is counted on its own", () => {
  const qs = [{ id: "a", type: "rating" }, { id: "n", type: "nps" }, { id: "c", type: "choice" }, { id: "t", type: "text" }];
  const g = scoreGroup(qs);
  assert.deepEqual(Object.keys(g), ["_id", "q_a", "na_a", "q_n", "na_n", "na_c"]);
  assert.deepEqual(averagesOf(qs, { q_a: 4.3333, q_n: null }), { a: 4.33, n: null });
  assert.deepEqual(naCountsOf(qs, { na_a: 2, na_c: 1 }), { a: 2, n: 0, c: 1 });
});

test("personal links: signed, checked in constant time, tamper-proof; u = an account, p = a pass", () => {
  const key = Buffer.from("k".repeat(32));
  const uid = "65a1b2c3d4e5f6a7b8c9d0e1";
  const t = signSurveyToken("u", uid, key);
  assert.match(t, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
  assert.deepEqual(verifySurveyToken(t, key), { kind: "u", id: uid });
  assert.deepEqual(verifySurveyToken(signSurveyToken("p", uid, key), key), { kind: "p", id: uid });
  assert.equal(verifySurveyToken(t, Buffer.from("x".repeat(32))), null);
  const [body, sig] = t.split(".");
  assert.equal(verifySurveyToken(`${Buffer.from(`u:${"0".repeat(24)}`).toString("base64url")}.${sig}`, key), null);
  const flipped = sig[0] === "A" ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
  assert.equal(verifySurveyToken(`${body}.${flipped}`, key), null);
  assert.equal(verifySurveyToken("nonsense", key), null);
  assert.equal(signSurveyToken("x", uid, key), "");
  assert.equal(signSurveyToken("u", "not-an-id", key), "");
  assert.equal(signSurveyToken("u", uid, null), "");
  assert.equal(surveyUrl(t), `https://www.thetechfestival.com/survey?t=${t}`);
});

test("the CSV: a column per question, deleted questions with answers marked (removed), N/A, formula-safe", () => {
  const questions = [{ id: "checkin", type: "rating", label: "Check-in" }, { id: "role", type: "multi", label: "Role" }, { id: "name", type: "text", label: "Name" }];
  const retired = [{ id: "food", type: "rating", label: "Food quality" }, { id: "never", type: "rating", label: "Never answered" }];
  const rows = [
    { submittedAt: new Date("2026-10-27T21:00:00Z"), createdAt: new Date("2026-10-27T20:30:00Z"), count: 2, source: "app", email: "a@example.com", answers: { checkin: 5, role: ["Speaker", "Media"], name: "=Ann", food: 4, oldq: "x" } },
    { submittedAt: new Date("2026-10-27T22:00:00Z"), source: "link", email: "b@example.com", answers: { checkin: "na" } },
  ];
  const csv = responsesCsv(rows, { questions, retired });
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\n");
  assert.equal(lines[0], "Submitted (UTC),First submitted (UTC),Times submitted,Source,Email,Title,Company,Check-in,Role,Name,Food quality (removed),oldq (removed)");
  assert.equal(lines[1], "2026-10-27 21:00:00,2026-10-27 20:30:00,2,app,a@example.com,,,5,Speaker; Media,'=Ann,4,x");
  assert.equal(lines[2], "2026-10-27 22:00:00,,1,link,b@example.com,,,N/A,,,,");
});

test("the email's audience: door check-ins on the day, each person once, each address once, practice never", () => {
  const ann = { id: "u-1", user: { _id: "65a1b2c3d4e5f6a7b8c9d0e1" }, attendees: [], name: "Ann Example", firstName: "Ann", email: "ann@example.com", jobTitle: "CTO", company: "Acme" };
  const bob = { id: "a-2", user: null, attendees: [{ _id: "65a1b2c3d4e5f6a7b8c9d0e2", email: "bob@example.com" }], name: "Bob Pass", firstName: "Bob", email: "BOB@example.com", jobTitle: "", company: "" };
  const twin = { id: "a-3", user: null, attendees: [{ _id: "65a1b2c3d4e5f6a7b8c9d0e3" }], name: "Bob Again", email: "bob@example.com" };
  const noMail = { id: "a-4", user: null, attendees: [], name: "No name", email: "" };
  const issued = { id: "i-5", user: null, attendees: [], name: "Ivy Issued", email: "ivy@example.com" };
  const byId = new Map([["t-CON1", ann], ["t-CON2", ann], ["t-POW3", bob], ["t-CON4", twin], ["t-CON5", noMail], ["i-5", issued]]);
  const m = (subject, day, point = "arrived", extra = {}) => ({ subject, day, point, at: new Date(`${day}T14:00:00Z`), ...extra });
  const marks = [
    m("CON1", "2026-10-26"), m("CON2", "2026-10-26", "checked_in"),   // Ann's two passes: once
    m("POW3", "2026-10-26", "checked_in"), m("CON4", "2026-10-26"),   // Bob and a twin record on the same email: once
    m("CON5", "2026-10-26"),                                         // no email
    m("person:i-5", "2026-10-27"),                                   // an ISSUE PASS person, Day 2
    m("CON1", "2026-10-25"), m("POW3", "2026-10-26", "lunch"),       // a rehearsal day; a meal isn't the door
    m("CON4", "2026-10-26", "arrived", { practice: true, subject: "GHOST" }), m("booth:b1", "2026-10-26"), m("NOPE", "2026-10-26"),
    { subject: "CON1", day: "2026-10-26", point: "arrived", at: null },
  ];
  const d1 = checkedInAudience({ byId, marks, days: AUDIENCES.day1 });
  assert.deepEqual(d1.rows.map((r) => [r.email, r.name, r.firstName, r.userId, r.attendeeId]), [
    ["ann@example.com", "Ann Example", "Ann", "65a1b2c3d4e5f6a7b8c9d0e1", null],
    ["bob@example.com", "Bob Pass", "Bob", null, "65a1b2c3d4e5f6a7b8c9d0e2"],
  ]);
  assert.deepEqual([d1.noEmail, d1.unmatched], [1, 1]);
  assert.deepEqual(checkedInAudience({ byId, marks, days: AUDIENCES.day2 }).rows.map((r) => r.email), ["ivy@example.com"]);
  assert.deepEqual(checkedInAudience({ byId, marks, days: AUDIENCES.both }).rows.map((r) => r.email), ["ann@example.com", "bob@example.com", "ivy@example.com"]);
});

test("the email: the subject, the survey's title and intro, one button to their link, unsubscribe, enquire@; batches", async () => {
  const url = "https://www.thetechfestival.com/survey?t=abc.def";
  const e = buildSurveyEmail({ firstName: "Ann", url, copy: { title: "How was TTFC 2026?", intro: "Two minutes." }, unsubscribeUrl: "https://api.example.com/api/unsubscribe?t=x" });
  assert.equal(e.subject, "How was TTFC 2026? Two minutes, please");
  assert.equal(SURVEY_SUBJECT, e.subject);
  assert.match(e.html, /Hi Ann,/);
  assert.match(e.html, /How was TTFC 2026\?<\/h1>/);
  assert.match(e.html, /Two minutes\./);
  assert.equal((e.html.match(/>Share your feedback</g) || []).length, 1);
  assert.match(e.html, /href="https:\/\/www\.thetechfestival\.com\/survey\?t=abc\.def"/);
  assert.match(e.html, /Unsubscribe<\/a>/);
  assert.match(e.html, /enquire@thetechfestival\.com/);
  assert.doesNotMatch(e.html, /info@/);
  assert.match(e.html, /App Store/);
  assert.match(e.text, /Share your feedback: https:\/\/www\.thetechfestival\.com\/survey\?t=abc\.def/);
  const msg = surveyMessage({ to: "ann@example.com", firstName: "Ann", url, unsubscribe: { url: "https://u", headers: { "List-Unsubscribe": "<https://u>" } }, logoSrc: "https://api.example.com/api/survey/email-logo.png" });
  assert.match(msg.html, /src="https:\/\/api\.example\.com\/api\/survey\/email-logo\.png"/);
  const calls = [];
  const client = { batch: { send: async (p) => { calls.push(p); return { data: { data: p.map((_, i) => ({ id: `re_${i}` })) }, error: null }; } } };
  const out = await sendSurveyBatch([msg, { ...msg, to: "bob@example.com" }], { client });
  assert.deepEqual(out, [{ to: "ann@example.com", id: "re_0" }, { to: "bob@example.com", id: "re_1" }]);
  assert.deepEqual(Object.keys(calls[0][0]).sort(), ["from", "headers", "html", "reply_to", "subject", "text", "to"]);
  assert.deepEqual([calls[0][0].from, calls[0][0].reply_to, calls[0][0].to], ["The Tech Festival Canada <enquire@thetechfestival.com>", "enquire@thetechfestival.com", ["ann@example.com"]]);
  assert.equal("attachments" in calls[0][0], false);   // the batch API takes none
  await assert.rejects(sendSurveyBatch([msg], { client: { batch: { send: async () => ({ data: null, error: { message: "nope" } }) } } }), /nope/);
});

test("by invitation, for people who attended: no link, no questions; not checked in, a message; staff preview", () => {
  const now = new Date("2026-10-28T12:00:00Z");
  const head = { open: true, opensAt: cfg.opensAt, closesAt: cfg.closesAt, title: cfg.title, invitationOnly: true };
  assert.deepEqual(publicSurvey(cfg, { now }), { ...head, questions: [] });
  assert.deepEqual(publicSurvey(cfg, { now, invited: true, eligible: false, respondent: { name: "Pat" } }), { ...head, eligible: false, message: NOT_ATTENDED_MESSAGE, questions: [] });
  const inn = publicSurvey(cfg, { now, invited: true, eligible: true, respondent: { name: "Ann" }, responded: true });
  assert.deepEqual([inn.eligible, inn.questions.length, inn.respondent, inn.responded, inn.intro], [true, 32, { name: "Ann" }, true, cfg.intro]);
  const pv = publicSurvey(cfg, { now: new Date("2026-10-27T12:00:00Z"), invited: true, eligible: false, preview: true });
  assert.deepEqual([pv.preview, pv.eligible, pv.questions.length], [true, false, 32]);
  assert.equal(INVITE_ONLY_MESSAGE, "This survey is by invitation. Please use the link we sent you.");
  assert.equal(NOT_ATTENDED_MESSAGE, "This survey is for people who attended TTFC 2026.");
});

test("who checked in: a person's passes and ISSUE PASS ids, their email addresses; where their link goes", () => {
  const ann = { id: "u-65a1b2c3d4e5f6a7b8c9d0e1", user: { _id: "65a1b2c3d4e5f6a7b8c9d0e1", email: "ann@example.com" }, attendees: [{ _id: "65a1b2c3d4e5f6a7b8c9d0e5" }],
    tickets: new Map([["con1", {}], ["spk1", {}]]), email: "ann@example.com", emails: new Set(["ann@example.com"]) };
  const twin = { id: "a-65a1b2c3d4e5f6a7b8c9d0e2", user: null, attendees: [{ _id: "65a1b2c3d4e5f6a7b8c9d0e2", email: "ANN@example.com" }], tickets: new Map([["con2", {}]]), email: "ann@example.com", emails: new Set(["ann@example.com"]) };
  const pat = { id: "a-65a1b2c3d4e5f6a7b8c9d0e3", user: null, attendees: [{ _id: "65a1b2c3d4e5f6a7b8c9d0e3", email: "pat@example.com" }], tickets: new Map([["con3", {}]]), email: "pat@example.com", emails: new Set(["pat@example.com"]) };
  const rsvpOnly = { id: "r-1", user: null, attendees: [], tickets: new Map(), email: "ivy@example.com", emails: new Set(["ivy@example.com"]) };
  const people = [ann, twin, pat, rsvpOnly];
  const byId = new Map([["u-65a1b2c3d4e5f6a7b8c9d0e1", ann], ["a-65a1b2c3d4e5f6a7b8c9d0e5", ann], ["t-con1", ann], ["t-spk1", ann], ["a-65a1b2c3d4e5f6a7b8c9d0e2", twin], ["t-con2", twin], ["a-65a1b2c3d4e5f6a7b8c9d0e3", pat], ["t-con3", pat], ["r-1", rsvpOnly]]);
  const dir = { people, byId };
  // The account, its pass record and everyone on its address.
  assert.deepEqual(personsMatching(dir, { userId: "65a1b2c3d4e5f6a7b8c9d0e1", email: "Ann@Example.com" }).map((p) => p.id), [ann.id, twin.id]);
  assert.deepEqual(personsMatching(dir, { attendeeId: "65a1b2c3d4e5f6a7b8c9d0e3" }).map((p) => p.id), [pat.id]);
  assert.deepEqual(personsMatching(dir, { email: "nobody@example.com" }), []);
  assert.deepEqual(personSubjects([ann]).sort(), ["con1", "person:a-65a1b2c3d4e5f6a7b8c9d0e5", "person:u-65a1b2c3d4e5f6a7b8c9d0e1", "spk1"]);
  // Check-ins: the twin's pass at the door counts for Ann's address; a rehearsal doesn't count; a meal isn't the door.
  const m = (subject, day, point = "arrived", extra = {}) => ({ subject, day, point, at: new Date(`${day}T14:00:00Z`), ...extra });
  const { persons } = checkedInPersons({ byId, marks: [m("con2", "2026-10-27"), m("con3", "2026-10-25", "checked_in"), m("con3", "2026-10-26", "lunch"), m("con3", "2026-10-26", "arrived", { practice: true })] });
  assert.deepEqual(persons.map((p) => p.id), [twin.id]);
  const keys = checkedInKeys(persons);
  assert.deepEqual([[...keys.userIds], [...keys.emails]], [[], ["ann@example.com"]]);
  assert.deepEqual(checkedInPersons({ byId, marks: [m("person:r-1", "2026-10-26")] }).persons.map((p) => p.id), ["r-1"]);
  // Links: an account first, else the pass on that address; nobody without either.
  assert.deepEqual(linkTarget(ann), { kind: "u", id: "65a1b2c3d4e5f6a7b8c9d0e1" });
  assert.deepEqual(linkTarget(twin, "ann@example.com"), { kind: "p", id: "65a1b2c3d4e5f6a7b8c9d0e2" });
  assert.equal(linkTarget(rsvpOnly), null);
});
