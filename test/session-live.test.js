import { test } from "node:test";
import assert from "node:assert/strict";
import {
  LIVE_MODES, OFF_ERRORS, liveMode, autoReason, featureOn, sessionLive,
  parseSessionLive, makeSessionLiveCache, allowedIn, LIVE_URL,
} from "../services/sessionLive.js";
import { toSanityPatch, sessionDoc, CMS_FIELDS, LIVE_MODES as SCHEMA_MODES } from "../services/cmsSchema.js";
import { makeAgendaCache } from "../services/points.js";

const panel = { format: "panel", moderator: { name: "Shawn Abbott" } };

test("live modes: auto, on, off; anything else is auto", () => {
  assert.deepEqual(LIVE_MODES, ["auto", "on", "off"]);
  assert.deepEqual(SCHEMA_MODES, LIVE_MODES);
  assert.equal(liveMode("on"), "on");
  assert.equal(liveMode("off"), "off");
  for (const v of [undefined, null, "", "auto", "ON", true, 1]) assert.equal(liveMode(v), "auto");
});

test("auto resolves from the moderator, keynotes and breaks", () => {
  assert.equal(autoReason(panel), "moderator");
  assert.equal(autoReason({ format: "keynote", moderator: { name: "A" } }), "keynote");
  assert.equal(autoReason({ isBreak: true, moderator: { name: "A" } }), "break");
  assert.equal(autoReason({ format: "break", moderator: { name: "A" } }), "break");
  assert.equal(autoReason({ format: "panel", moderator: { name: "   " } }), "noModerator");
  assert.equal(autoReason({ format: "panel" }), "noModerator");
  assert.equal(autoReason({ format: "fireside", moderator: {} }), "noModerator");
  assert.equal(autoReason({ isBreak: false, moderator: { name: "A" } }), "moderator");   // no format at all
  assert.equal(autoReason(null), "noModerator");
});

test("featureOn: on always on, off always off, auto follows the moderator rule", () => {
  for (const f of ["polls", "qa"]) {
    assert.equal(featureOn(panel, f), true);                                    // missing = auto
    assert.equal(featureOn({ ...panel, [f]: "auto" }, f), true);
    assert.equal(featureOn({ ...panel, [f]: "off" }, f), false);
    assert.equal(featureOn({ format: "keynote", [f]: "on" }, f), true);         // on beats keynote
    assert.equal(featureOn({ isBreak: true, [f]: "on" }, f), true);             // and breaks
    assert.equal(featureOn({ format: "keynote", moderator: { name: "A" } }, f), false);
    assert.equal(featureOn({ isBreak: true, moderator: { name: "A" } }, f), false);
    assert.equal(featureOn({ format: "panel" }, f), false);
  }
  // the two switches are independent
  assert.deepEqual(sessionLive({ ...panel, polls: "off" }), { pollsOn: false, qaOn: true });
  assert.deepEqual(sessionLive({ format: "keynote", qa: "on" }), { pollsOn: false, qaOn: true });
});

test("the global switches still apply on top", () => {
  assert.deepEqual(sessionLive({ ...panel, polls: "on", qa: "on" }, { polls: false, qa: true }), { pollsOn: false, qaOn: true });
  assert.deepEqual(sessionLive({ ...panel, polls: "on", qa: "on" }, { polls: true, qa: false }), { pollsOn: true, qaOn: false });
  assert.deepEqual(sessionLive(panel, {}), { pollsOn: true, qaOn: true });
});

test("off messages", () => {
  assert.equal(OFF_ERRORS.polls, "Polls are off for this session.");
  assert.equal(OFF_ERRORS.qa, "Q&A is off for this session.");
});

test("parseSessionLive keys each session by sessionId and _id", () => {
  const map = parseSessionLive({ result: [
    { _id: "abc", sessionId: "d1-06", ...panel },
    { _id: "kn1", format: "keynote", moderator: { name: "A" } },
    { _id: "br1", sessionId: "d1-09", isBreak: true, qa: "on" },
    null, { _id: "  " },
  ] });
  assert.deepEqual(map.get("d1-06"), { pollsOn: true, qaOn: true });
  assert.deepEqual(map.get("abc"), { pollsOn: true, qaOn: true });
  assert.deepEqual(map.get("kn1"), { pollsOn: false, qaOn: false });
  assert.deepEqual(map.get("d1-09"), { pollsOn: false, qaOn: true });
  assert.equal(map.has(""), false);
  assert.equal(parseSessionLive({ result: [] }), null);
  assert.equal(parseSessionLive(null), null);
  assert.match(decodeURIComponent(LIVE_URL), /apicdn\.sanity\.io.*polls, qa/);
});

test("lookup: cached 60 s, last good copy on failure, fail open, logs once per outage", async () => {
  let t = 0;
  let calls = 0;
  let reply = { ok: true, json: async () => ({ result: [{ _id: "s1", sessionId: "d1-01", ...panel, qa: "off" }] }) };
  const fetchImpl = async () => { calls += 1; if (reply instanceof Error) throw reply; return reply; };
  const logged = [];
  const log = { error: (...a) => logged.push(a.join(" ")) };
  const cache = makeSessionLiveCache({ fetchImpl, now: () => t, log });

  assert.equal(await allowedIn(cache, "d1-01", "polls"), true);
  assert.equal(await allowedIn(cache, "d1-01", "qa"), false);
  assert.equal(await allowedIn(cache, "s1", "qa"), false);
  assert.equal(await allowedIn(cache, " d1-01 ", "qa"), false);
  assert.equal(await allowedIn(cache, "not-on-agenda", "qa"), true);   // unknown session → allow
  assert.equal(calls, 1);

  t = 59_000; await cache.get();
  assert.equal(calls, 1);                                               // still cached
  t = 61_000;
  reply = new Error("offline");
  assert.equal(await allowedIn(cache, "d1-01", "qa"), false);          // last good copy
  assert.equal(calls, 2);
  t = 130_000; await cache.get();
  assert.equal(calls, 3);
  assert.equal(logged.length, 1);                                       // one line per outage
  assert.match(logged[0], /SESSION LIVE ERROR/);

  reply = { ok: true, json: async () => ({ result: [{ _id: "s1", sessionId: "d1-01", ...panel }] }) };
  t = 200_000;
  assert.equal(await allowedIn(cache, "d1-01", "qa"), true);           // switched back to auto
  reply = { ok: false, status: 503 };
  t = 300_000; await cache.get();
  assert.equal(logged.length, 2);                                       // a new outage logs again

  const never = makeSessionLiveCache({ fetchImpl: async () => ({ ok: false, status: 503 }), now: () => 0, log: { error() {} } });
  assert.equal(await allowedIn(never, "d1-01", "polls"), true);        // agenda unreadable → allow
});

test("points agenda cache also logs once per outage", async () => {
  let t = 0;
  const logged = [];
  const cache = makeAgendaCache({ fetchImpl: async () => { throw new Error("offline"); }, now: () => t, retryMs: 10, log: { error: (...a) => logged.push(a.join(" ")) } });
  await cache.get(); t = 20; await cache.get(); t = 40; await cache.get();
  assert.equal(logged.length, 1);
  assert.match(logged[0], /POINTS AGENDA ERROR/);
});

test("CMS session rules: polls and qa are auto/on/off, default auto", () => {
  assert.deepEqual(CMS_FIELDS.session.polls.values, ["auto", "on", "off"]);
  assert.deepEqual(CMS_FIELDS.session.qa.values, ["auto", "on", "off"]);

  const base = { day: 1, time: "10:00", endTime: "10:30", title: "Panel" };
  const created = toSanityPatch("session", base, { creating: true });
  assert.equal(created.error, null);
  assert.equal(created.set.polls, "auto");
  assert.equal(created.set.qa, "auto");
  assert.equal(toSanityPatch("session", { ...base, polls: "off" }, { creating: true }).set.polls, "off");

  const edit = toSanityPatch("session", { polls: "on", qa: "off" }, { creating: false });
  assert.deepEqual(edit.set, { polls: "on", qa: "off" });
  assert.deepEqual(toSanityPatch("session", { title: "X" }, { creating: false }).set, { title: "X" });   // a patch adds no defaults
  assert.deepEqual(toSanityPatch("session", { qa: null }, { creating: false }).unset, ["qa"]);
  assert.match(toSanityPatch("session", { polls: "maybe" }, { creating: false }).error, /polls must be one of: auto, on, off/);
  assert.match(toSanityPatch("session", { qa: true }, { creating: false }).error, /qa must be one of/);

  // other types get no defaults
  assert.equal(toSanityPatch("speaker", { name: "A", title: "B", company: "C", image: "image-abc123-400x500-jpg", order: 1 }, { creating: true }).set.polls, undefined);
});

test("agenda import keeps valid polls/qa values and defaults the rest to auto", () => {
  const s = { id: "d1-06", day: 1, time: "10:10", endTime: "10:35", title: "T" };
  assert.equal(sessionDoc({ ...s, polls: "off", qa: "on" }).doc.polls, "off");
  assert.equal(sessionDoc({ ...s, polls: "off", qa: "on" }).doc.qa, "on");
  const d = sessionDoc({ ...s, polls: "bogus" }).doc;
  assert.equal(d.polls, "auto");
  assert.equal(d.qa, "auto");
});
