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

test("photo galleries take uploaded images only, at most 24", () => {
  const id = "image-abc123def456-1200x800-jpg";
  const { set, error } = toSanityPatch("event", { gallery: [id, { asset: id, alt: "Expo floor" }] }, { creating: false });
  assert.equal(error, null);
  assert.equal(set.gallery.length, 2);
  assert.equal(set.gallery[1].alt, "Expo floor");
  assert.equal(set.gallery[0].asset._ref, id);
  assert.match(toSanityPatch("event", { gallery: ["not-an-image"] }, { creating: false }).error, /upload each photo/);
  assert.match(toSanityPatch("homePage", { highlightPhotos: new Array(25).fill(id) }, { creating: false }).error, /at most 24/);
  assert.deepEqual(toSanityPatch("homePage", { highlightPhotos: [] }, { creating: false }).unset, ["highlightPhotos"]);
});

test("the home page has its hero, highlights and partner fields", () => {
  const { set, error } = toSanityPatch("homePage", {
    heroHeadline: "Canada's technology decision-makers, in one room",
    primaryCtaLabel: "Get tickets", primaryCtaUrl: "/vancouver/2027/briefing",
    stats: [{ value: 1000, suffix: "+", label: "attendees" }],
  }, { creating: true });
  assert.equal(error, null);
  assert.equal(set.primaryCtaUrl, "/vancouver/2027/briefing");
  assert.equal(set.stats.length, 1);
});

test("an event's stand-in speakers and partners: source event, picks and wording", () => {
  const { set, unset, error } = toSanityPatch("event", {
    standInSpeakersFrom: "event-ttfc-2026-main",
    standInSpeakers: ["speaker-a", "speaker-b", "speaker-a"],
    standInSpeakersHeading: "  Who spoke last time ",
    standInSpeakersText: "Meanwhile, Toronto 2026.",
    standInPartnersFrom: "",
    standInPartners: [],
  }, { creating: false, draft: true });
  assert.ok(!error);
  assert.deepEqual(set.standInSpeakersFrom, { _type: "reference", _ref: "event-ttfc-2026-main" });
  assert.deepEqual(set.standInSpeakers.map((r) => r._ref), ["speaker-a", "speaker-b"]);
  assert.equal(set.standInSpeakersHeading, "Who spoke last time");
  assert.ok(unset.includes("standInPartnersFrom"));
  assert.ok(unset.includes("standInPartners"));
  assert.match(toSanityPatch("event", { standInSpeakersFrom: "drafts.event-x" }, { creating: false }).error, /unknown/);
});

test("event hero shade: the five choices, anything else refused, standard when not given (Nov 25 2026)", () => {
  for (const v of ["default", "light", "strong", "brand", "none"]) {
    const { set, error } = toSanityPatch("event", { heroShade: v }, { creating: false });
    assert.equal(error, null, v);
    assert.equal(set.heroShade, v);
  }
  assert.ok(toSanityPatch("event", { heroShade: "neon" }, { creating: false }).error);
  const made = toSanityPatch("event", { name: "Ottawa Briefing 2027", city: "Ottawa", type: "briefing", year: 2027 }, { creating: true });
  assert.equal(made.error, null);
  assert.equal(made.set.heroShade, "default");
});

test("event hero media: photo or video, nothing else; unset stays unset (Nov 25 2026)", () => {
  for (const v of ["photo", "video"]) assert.equal(toSanityPatch("event", { heroMedia: v }, { creating: false }).set.heroMedia, v);
  assert.ok(toSanityPatch("event", { heroMedia: "both" }, { creating: false }).error);
  const made = toSanityPatch("event", { name: "Ottawa Briefing 2027", city: "Ottawa", type: "briefing", year: 2027 }, { creating: true });
  assert.equal(made.error, null);
  assert.equal("heroMedia" in made.set, false);
});

test("event hero framing and height (Nov 25 2026)", () => {
  assert.equal(toSanityPatch("event", { heroFocus: 30 }, { creating: false }).set.heroFocus, 30);
  assert.ok(toSanityPatch("event", { heroFocus: 130 }, { creating: false }).error);
  assert.ok(toSanityPatch("event", { heroFocus: -1 }, { creating: false }).error);
  for (const h of ["standard", "tall", "full"]) assert.equal(toSanityPatch("event", { heroHeight: h }, { creating: false }).set.heroHeight, h);
  assert.ok(toSanityPatch("event", { heroHeight: "huge" }, { creating: false }).error);
});

test("website text & media: wording changes and picture swaps are cleaned, deduplicated and bounded", () => {
  const { set, error } = toSanityPatch("siteCopy", {
    texts: [
      { match: "  Why   come ", text: "Why attend" },
      { match: "Why come", page: "/venue/", text: "Why visit" },
      { match: "Why come", text: "Why join us" },            // same page + text: the later row wins
      { match: "Same", text: "Same" },                       // no change: dropped
      { match: "Empty", text: "  " },                        // empty = the built-in wording: dropped
    ],
    media: [{ match: "/ft-audience.webp", url: "https://cdn.sanity.io/images/x/production/a-1x1.jpg", alt: " The  room " }],
  }, { creating: true, draft: true });
  assert.equal(error, null);
  assert.deepEqual(set.texts.map(({ match, page, text }) => [match, page, text]), [["Why come", undefined, "Why join us"], ["Why come", "/venue", "Why visit"]]);
  assert.equal(new Set(set.texts.map((r) => r._key)).size, 2);
  assert.deepEqual(set.media.map(({ match, url, alt }) => [match, url, alt]), [["/ft-audience.webp", "https://cdn.sanity.io/images/x/production/a-1x1.jpg", "The room"]]);
  assert.deepEqual(toSanityPatch("siteCopy", { texts: [], media: [] }, { creating: false }).unset, ["texts", "media"]);
  assert.match(toSanityPatch("siteCopy", { media: [{ match: "/a.png", url: "javascript:alert(1)" }] }, { creating: false }).error, /https/);
  assert.match(toSanityPatch("siteCopy", { media: [{ match: "/a.png", url: "https://x.test/a.png);x:url(" }] }, { creating: false }).error, /https/);
  assert.match(toSanityPatch("siteCopy", { texts: [{ match: "a", text: "b", page: "venue" }] }, { creating: false }).error, /website address/);
  assert.match(toSanityPatch("siteCopy", { texts: "x" }, { creating: false }).error, /must be a list/);
  const many = Array.from({ length: 1501 }, (_, i) => ({ match: `t${i}`, text: `u${i}` }));
  assert.match(toSanityPatch("siteCopy", { texts: many }, { creating: false }).error, /at most 1500/);
});
