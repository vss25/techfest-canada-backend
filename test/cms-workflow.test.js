import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyPatch, assetUrl, assetDims, changeTitle, changedFields, cleanDoc, newDocId, overlayChanges, pickIds,
  publishOrder, strongRefs, weakRefs, withAssetUrls,
} from "../services/cmsWorkflow.js";

const IMG = "image-0123456789abcdef0123456789abcdef01234567-800x1000-jpg";

test("asset ids become CDN addresses and sizes; anything else none", () => {
  assert.equal(assetUrl(IMG, "p1", "production"), "https://cdn.sanity.io/images/p1/production/0123456789abcdef0123456789abcdef01234567-800x1000.jpg");
  assert.equal(assetUrl("file-abc123-pdf", "p1", "production"), "https://cdn.sanity.io/files/p1/production/abc123.pdf");
  assert.equal(assetUrl("event-x", "p1", "d"), "");
  assert.deepEqual(assetDims(IMG), { width: 800, height: 1000, aspectRatio: 0.8 });
  assert.equal(assetDims(""), null);
  const d = withAssetUrls({ _id: "s", image: { _type: "image", asset: { _type: "reference", _ref: IMG } } }, "p1", "production");
  assert.match(d.imageUrl, /800x1000\.jpg$/);
  assert.equal(d.logoUrl, null);
  assert.equal(d.imageDims.width, 800);
});

test("cleanDoc drops system and computed fields and uses the published id", () => {
  assert.deepEqual(cleanDoc({ _id: "drafts.a", _type: "speaker", _rev: "r", _updatedAt: "t", name: "A", imageUrl: "x", imageDims: {}, hasDraft: true, staged: true }),
    { _id: "a", _type: "speaker", name: "A" });
  assert.equal(cleanDoc(null), null);
});

test("applyPatch sets and unsets top-level fields without touching the original", () => {
  const doc = { name: "A", bio: "old", linkedin: "x" };
  assert.deepEqual(applyPatch(doc, { bio: "new" }, ["linkedin"]), { name: "A", bio: "new" });
  assert.equal(doc.bio, "old");
});

test("new ids are per type and unique", () => {
  const a = newDocId("speaker"), b = newDocId("speaker");
  assert.match(a, /^speaker-[a-f0-9]{12}$/);
  assert.notEqual(a, b);
});

test("references are weak on staging and strong again on publish where the target exists", () => {
  const doc = {
    events: [{ _key: "e0", _type: "reference", _ref: "event-ttfc-2027-vancouver-briefing" }, { _key: "e1", _type: "reference", _ref: "event-gone" }],
    image: { _type: "image", asset: { _type: "reference", _ref: IMG } },
  };
  const weak = weakRefs(doc);
  assert.equal(weak.events[0]._weak, true);
  assert.equal(weak.image.asset._weak, undefined);       // assets always exist
  assert.equal(doc.events[0]._weak, undefined);          // original untouched
  const strong = strongRefs(weak, (id) => id === "event-ttfc-2027-vancouver-briefing");
  assert.equal(strong.events[0]._weak, undefined);
  assert.equal(strong.events[1]._weak, true);
});

test("overlayChanges: newest content first (unsent > staged > live) with the three flags", () => {
  const rows = overlayChanges(
    [{ _id: "a", name: "Live A" }, { _id: "b", name: "Live B" }, { _id: "c", name: "Live C" }],
    [{ _id: "drafts.a", name: "Staged A" }, { _id: "drafts.d", name: "Staged new D" }],
    [{ docId: "a", wip: { _id: "a", name: "Unsent A" } }, { docId: "b", wip: { _id: "b", name: "Unsent B" } }, { docId: "e", wip: { _id: "e", name: "Unsent new E" } }, { docId: "f", wip: null }],
  );
  assert.deepEqual(rows.map((r) => [r._id, r.name, r.hasDraft, r.staged, r.unpublished]), [
    ["a", "Unsent A", true, true, false],
    ["b", "Unsent B", true, false, false],
    ["c", "Live C", false, false, false],
    ["d", "Staged new D", false, true, true],
    ["e", "Unsent new E", true, false, true],
  ]);
});

test("pickIds: all when missing, only known ones when given, a bad list refused", () => {
  assert.deepEqual(pickIds(["a", "b"]).ids, ["a", "b"]);
  assert.deepEqual(pickIds(["a", "b"], ["b", "zzz"]).ids, ["b"]);
  assert.ok(pickIds(["a"], "a").error);
  assert.ok(pickIds(["a"], [1]).error);
});

test("events and the home page publish first; titles and changed fields for the Changes list", () => {
  assert.deepEqual(publishOrder([{ _type: "speaker" }, { _type: "homePage" }, { _type: "event" }]).map((d) => d._type), ["event", "homePage", "speaker"]);
  assert.equal(changeTitle("speaker", { name: "Ada" }), "Ada");
  assert.equal(changeTitle("session", { title: "Opening" }), "Opening");
  assert.equal(changeTitle("homePage", {}), "Home page");
  assert.deepEqual(changedFields({ _id: "drafts.a", _rev: "1", name: "A", bio: "new", image: { x: 1 } }, { _id: "a", _rev: "2", name: "A", bio: "old", linkedin: "l" }),
    ["bio", "image", "linkedin"]);
  assert.deepEqual(changedFields({ name: "A" }, null), ["name"]);
});

/* Nov 18 2026: autosave keeps incomplete drafts; required fields are checked at staging. */
import { missingRequired, toSanityPatch as patchFor } from "../services/cmsSchema.js";
test("drafts may leave required fields empty; staging names what's missing", () => {
  assert.equal(patchFor("speaker", { name: "Ada" }, { creating: true }).error, "title is required");
  const d = patchFor("speaker", { name: "Ada" }, { creating: true, draft: true });
  assert.equal(d.error, null);
  assert.equal(patchFor("speaker", { title: "" }, { creating: false }).error, "title is required");
  assert.deepEqual(patchFor("speaker", { title: "" }, { creating: false, draft: true }).unset, ["title"]);
  assert.deepEqual(missingRequired("speaker", { name: "Ada" }), ["job title", "company", "photo", "order number"]);
  assert.deepEqual(missingRequired("speaker", { name: "Ada", title: "CTO", company: "X", order: 1, image: { asset: { _ref: "image-a-1x1-png" } } }), []);
  assert.deepEqual(missingRequired("speaker", { name: "  " , title: "CTO", company: "X", order: 0, image: { asset: { _ref: "image-a-1x1-png" } } }), ["full name"]);
});
