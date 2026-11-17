import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftId, publishedId, draftFromPublished, publishedFromDraft, overlayDrafts,
  previewQueryError, eventKeyFor, eventConfigFields,
} from "../services/cmsDrafts.js";
import { toSanityPatch, cleanFacts, cleanSteps, CMS_TYPES } from "../services/cmsSchema.js";

test("draft ids round-trip", () => {
  assert.equal(draftId("event-x"), "drafts.event-x");
  assert.equal(publishedId("drafts.event-x"), "event-x");
  assert.equal(publishedId("event-x"), "event-x");
});

test("a draft starts from the published document without system fields", () => {
  const d = draftFromPublished({ _id: "event-x", _type: "event", _rev: "r1", _updatedAt: "t", name: "A" });
  assert.deepEqual(d, { _id: "drafts.event-x", _type: "event", name: "A" });
  assert.equal(draftFromPublished(null), null);
  const p = publishedFromDraft({ _id: "drafts.event-x", _type: "event", _rev: "r2", name: "B" });
  assert.deepEqual(p, { _id: "event-x", _type: "event", name: "B" });
});

test("overlayDrafts shows the draft's content under the published id", () => {
  const rows = overlayDrafts(
    [{ _id: "a", name: "Live A" }, { _id: "b", name: "Live B" }],
    [{ _id: "drafts.a", name: "Draft A" }, { _id: "drafts.c", name: "New C" }],
  );
  assert.deepEqual(rows.map((r) => [r._id, r.name, r.hasDraft, !!r.unpublished]), [
    ["a", "Draft A", true, false], ["b", "Live B", false, false], ["c", "New C", true, true],
  ]);
});

test("preview queries are checked", () => {
  assert.equal(previewQueryError({ query: "*[_type == 'event']" }), null);
  assert.ok(previewQueryError({}));
  assert.ok(previewQueryError({ query: "x".repeat(13000) }));
  assert.ok(previewQueryError({ query: "*", params: [] }));
});

test("event keys follow the existing style", () => {
  assert.equal(eventKeyFor({ city: "Vancouver", year: 2027, type: "briefing" }), "ttfc-2027-vancouver-briefing");
  assert.equal(eventKeyFor({ city: "Toronto", year: 2027, type: "main-event" }), "ttfc-2027-toronto-main");
  assert.equal(eventKeyFor({ city: "Québec City", year: 2028, type: "briefing" }), "ttfc-2028-quebec-city-briefing");
  assert.equal(eventKeyFor({ city: "", year: 2027, type: "briefing" }), null);
  assert.equal(eventKeyFor({ city: "X", year: 2027, type: "gala" }), null);
});

test("eventConfigFields copies the page's basics", () => {
  const f = eventConfigFields({ name: "Vancouver Briefing 2027", city: "Vancouver", type: "briefing", year: 2027, startDate: "2027-02-18" });
  assert.equal(f.city, "Vancouver");
  assert.equal(f.startDate.toISOString().slice(0, 10), "2027-02-18");
});

test("event is an editable type with the page fields", () => {
  assert.ok(CMS_TYPES.includes("event"));
  const { set, error } = toSanityPatch("event", {
    name: "Calgary Briefing 2027", city: "Calgary", type: "briefing", year: 2027,
    startDate: "2027-06-10", theme: "Energy transition", pageMode: "coming-soon",
    knownSoFar: [{ label: "Date", value: "June 2027" }],
    comingNext: [{ label: "Venue announced", when: "January" }, { label: "" }],
  }, { creating: true });
  assert.equal(error, null);
  assert.equal(set.startDate, "2027-06-10");
  assert.equal(set.knownSoFar.length, 1);
  assert.equal(set.comingNext.length, 1);
  assert.equal(set.showReport, true);
});

test("bad dates and lists are refused", () => {
  assert.match(toSanityPatch("event", { startDate: "2027-02-30" }, { creating: false }).error, /date/);
  assert.match(toSanityPatch("event", { knownSoFar: [{ label: "Date" }] }, { creating: false }).error, /label and a value/);
  assert.ok(cleanFacts(new Array(9).fill({ label: "a", value: "b" })).error);
  assert.ok(cleanSteps("x").error);
});

test("sessions and speakers can be tied to events", () => {
  const { set } = toSanityPatch("session", { events: ["event-ttfc-2027-vancouver-briefing"] }, { creating: false });
  assert.equal(set.events[0]._ref, "event-ttfc-2027-vancouver-briefing");
  assert.equal(set.events[0]._type, "reference");
  const cleared = toSanityPatch("speaker", { events: [] }, { creating: false });
  assert.deepEqual(cleared.unset, ["events"]);
  assert.match(toSanityPatch("session", { events: ["drafts.x"] }, { creating: false }).error, /unknown event/);
});
