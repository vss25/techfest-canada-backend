import test from "node:test";
import assert from "node:assert/strict";
import { nameKey, agendaRunOfShow, applyWebsite, planWebsiteLinks, nudgeCopy, NUDGE_COPY } from "../services/speakerWebsite.js";

test("nameKey: honorifics, accents, nicknames and post-nominals don't matter", () => {
  assert.equal(nameKey("Hon. Évan  Solomon"), "evan solomon");
  assert.equal(nameKey("Dr. Rulan S. Parekh, MD"), "rulan parekh");
  assert.equal(nameKey("Heling (Alex) Pu"), "heling pu");
  assert.equal(nameKey("Penny Longman"), nameKey("penny  LONGMAN"));
  assert.equal(nameKey(""), "");
});

const SESSIONS = [
  { day: 1, time: "14:00", endTime: "14:30", title: "Cybersecurity and Digital Trust in the Agentic Age", format: "panel",
    moderator: { name: "Brennan Lodge" }, speakers: [{ name: "Francois Guay" }, { name: "Penny Longman", org: "NKST" }] },
  { day: 2, time: "10:00", endTime: "10:20", title: "Keynote", format: "keynote", speakers: [{ name: "Dr. Jane Roe" }] },
  { day: 1, time: "12:35", endTime: "13:20", title: "Networking Lunch", isBreak: true, speakers: [{ name: "Penny Longman" }] },
  { day: 1, title: "No times", speakers: [{ name: "Penny Longman" }] },
];

test("agendaRunOfShow: the sessions a speaker or moderator is on, breaks and untimed ones skipped", () => {
  const ros = agendaRunOfShow("Penny Longman", SESSIONS);
  assert.equal(ros.sessions.length, 1);
  const [s] = ros.sessions;
  assert.deepEqual([s.day, s.start, s.end, s.format, s.role], [1, "14:00", "14:30", "Panel", "Panellist"]);
  assert.ok(s.lineup.some((p) => p.name === "Brennan Lodge" && p.role === "Moderator"));
  assert.equal(agendaRunOfShow("Brennan Lodge", SESSIONS).sessions[0].role, "Moderator");
  assert.equal(agendaRunOfShow("Jane Roe", SESSIONS).sessions[0].role, "Speaker");
  assert.equal(agendaRunOfShow("Nobody Here", SESSIONS), null);
});

const site = (speakers = [], sessions = SESSIONS) => ({ speakers, byId: new Map(speakers.map((s) => [s.speakerId, s])), sessions });

test("applyWebsite: a renamed speaker's pass follows; sessions come from the agenda", () => {
  const pass = { _id: "1", speakerId: "abc", name: "Penny Longmann", details: { jobTitle: "", organisation: "" }, runOfShow: null };
  const live = applyWebsite(pass, site([{ speakerId: "abc", name: "Penny Longman", title: "CEO", company: "NKST" }]));
  assert.equal(live.doc.name, "Penny Longman");
  assert.deepEqual(live.changes, { name: "Penny Longman", "details.jobTitle": "CEO", "details.organisation": "NKST" });
  assert.equal(live.source, "agenda");
  assert.equal(live.doc.runOfShow.sessions.length, 1);
  assert.equal(live.onWebsite, true);
});

test("applyWebsite: agenda lineups get each person's company (the website, then the saved run of show)", () => {
  const pass = {
    speakerId: "abc", name: "Penny Longman", details: { jobTitle: "CEO", organisation: "NKST" },
    runOfShow: { sessions: [{ day: 1, start: "14:00", end: "14:30", title: "Old", lineup: [{ name: "Francois Guay", org: "CCN" }] }] },
  };
  const live = applyWebsite(pass, site([
    { speakerId: "abc", name: "Penny Longman", title: "CEO", company: "NKST" },
    { speakerId: "bl", name: "Brennan Lodge", company: "BLodgic Inc." },
    { speakerId: "fg", name: "François Guay", company: "Canadian Cybersecurity Network" },
  ], [{ ...SESSIONS[0], moderator: { name: "Brennan Lodge" }, speakers: [...SESSIONS[0].speakers, { name: "Dave Hochhalter" }] }]));
  const org = Object.fromEntries(live.doc.runOfShow.sessions[0].lineup.map((p) => [p.name, p.org]));
  // François is on the website as "Canadian Cybersecurity Network": that beats the "CCN" saved on the pass.
  assert.deepEqual(org, { "Francois Guay": "Canadian Cybersecurity Network", "Penny Longman": "NKST", "Brennan Lodge": "BLodgic Inc.", "Dave Hochhalter": "" });
  // Someone who isn't on the website keeps what was saved on the pass.
  const offSite = applyWebsite(pass, site([{ speakerId: "abc", name: "Penny Longman", company: "NKST" }]));
  assert.equal(offSite.doc.runOfShow.sessions[0].lineup.find((p) => p.name === "Francois Guay").org, "CCN");
  // "David" on the website, "Dave" on the agenda: the one speaker with that surname.
  const withDavid = applyWebsite(pass, site([
    { speakerId: "abc", name: "Penny Longman", company: "NKST" },
    { speakerId: "dh", name: "David Hochhalter", company: "Advance Carbon Removal Coalition" },
  ], [{ ...SESSIONS[0], speakers: [{ name: "Penny Longman" }, { name: "Dave Hochhalter" }] }]));
  assert.equal(withDavid.doc.runOfShow.sessions[0].lineup.find((p) => p.name === "Dave Hochhalter").org, "Advance Carbon Removal Coalition");
});

test("applyWebsite: off the agenda keeps the saved run of show; no website keeps the pass as it is", () => {
  const saved = { sessions: [{ day: 2, start: "09:00", end: "09:30", title: "Panel", format: "", role: "", lineup: [] }] };
  const pass = { speakerId: "manual:x-y", name: "X Y", runOfShow: saved };
  const live = applyWebsite(pass, site([]));
  assert.equal(live.source, "saved");
  assert.equal(live.doc.runOfShow, saved);
  assert.equal(live.changes, null);
  assert.equal(live.onWebsite, false);
  assert.equal(applyWebsite(pass, null).doc, pass);
});

test("planWebsiteLinks: link a manual pass, merge an empty second pass, leave real duplicates", () => {
  const speakers = [
    { speakerId: "s-new", name: "Sumit Bhatia" },
    { speakerId: "s-mat", name: "Matthew Lombardi" },
    { speakerId: "s-par", name: "Parag Patre" },
    { speakerId: "s-both", name: "Busy Person" },
  ];
  const passes = [
    { _id: "m1", speakerId: "manual:sumit-bhatia", name: "Sumit Bhatia", email: "s@x.com" },
    { _id: "m2", speakerId: "manual:matthew-lombardi", name: "Matthew Lombardi", email: "m@x.com" },
    { _id: "w2", speakerId: "s-mat", name: "Matthew Lombardi", email: "" },
    { _id: "m3", speakerId: "manual:parag-patre", name: "Parag Patre", email: "" },
    { _id: "w3", speakerId: "s-par", name: "Parag Patre", email: "p@x.com", passEmailSentAt: new Date() },
    { _id: "m4", speakerId: "manual:busy-person", name: "Busy Person", email: "a@x.com" },
    { _id: "w4", speakerId: "s-both", name: "Busy Person", email: "b@x.com" },
  ];
  const plan = planWebsiteLinks(passes, speakers);
  assert.deepEqual(plan.link.map((l) => [l.keep._id, l.speaker.speakerId]), [["m1", "s-new"]]);
  assert.deepEqual(plan.merge.map((m) => [m.keep._id, m.drop._id]), [["m2", "w2"], ["w3", "m3"]]);
  assert.deepEqual(plan.dupes.map((d) => d.speaker.name), ["Busy Person"]);
});

test("nudgeCopy: defaults unless staff typed something", () => {
  assert.deepEqual(nudgeCopy({}), { ...NUDGE_COPY });
  assert.equal(nudgeCopy({ headline: "Hi!" }).headline, "Hi!");
  assert.equal(nudgeCopy({ headline: "Hi!" }).subject, NUDGE_COPY.subject);
});
