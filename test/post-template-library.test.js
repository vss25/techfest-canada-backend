/* Marketing › Post templates (Nov 23 2026): the pure rules in services/postTemplateLibrary.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { BOXES, cleanBox, cleanTemplate, readyProblems, sizeOf } from "../services/postTemplateLibrary.js";

const IMG = (n) => `https://cdn.sanity.io/images/abc/production/${n}-1200x1200.png`;
const box = (x, y, w, h, extra = {}) => ({ on: true, x, y, w, h, ...extra });

test("sizes per kind and channel; each kind has its own boxes", () => {
  assert.deepEqual(sizeOf("session", "linkedin"), [1200, 995]);
  assert.deepEqual(sizeOf("keynote", "linkedin"), [1200, 1200]);
  assert.deepEqual(sizeOf("partner", "x"), [1600, 900]);
  assert.deepEqual(sizeOf("event", "instagram"), [1080, 1350]);
  assert.ok(BOXES.partner.includes("logo") && !BOXES.partner.includes("people"));
  assert.ok(BOXES.session.includes("people") && !BOXES.session.includes("name"));
});

test("a box: clamped inside the image, text and people rules, bad values fall back", () => {
  const t = cleanBox("title", { x: 0.9, y: -1, w: 0.5, h: 2, align: "justify", color: "red", size: 900, minSize: 999, maxLines: 20, maxChars: 60, weight: 300 });
  assert.equal(t.x, 0.9); assert.equal(t.y, 0);
  assert.ok(Math.abs(t.w - 0.1) < 1e-9);  // stays inside: 0.9 + 0.1
  assert.equal(t.h, 1);
  assert.equal(t.align, "left"); assert.equal(t.color, "#141414");
  assert.equal(t.size, 300); assert.equal(t.minSize, 300); assert.equal(t.maxLines, 8); assert.equal(t.maxChars, 60); assert.equal(t.weight, 600);
  assert.equal(t.twoTone, true);
  const p = cleanBox("people", { card: "cutout", gap: 0.9, perRow: 9, maxCard: 0.25, cardColor: "#123abc" });
  assert.deepEqual([p.card, p.gap, p.perRow, p.maxCard, p.cardColor], ["cutout", 0.3, 6, 0.25, "#123ABC"]);
  assert.equal(p.color, undefined);
  const l = cleanBox("logo", { fit: "stretch", minPx: 500 });
  assert.deepEqual([l.fit, l.minPx], ["contain", 500]);
  assert.equal(cleanBox("brand", { variant: "white" }).variant, "white");
});

test("a template: needs a kind and a name; only the kind's boxes are kept; images only from the library", () => {
  assert.match(cleanTemplate({ name: "X" }).error, /what the template is for/);
  assert.match(cleanTemplate({ kind: "keynote" }).error, /name/);
  const { value } = cleanTemplate({ name: "Speaker, gold", kind: "keynote", channels: {
    linkedin: { background: { url: IMG("bg"), w: 1200, h: 1200 }, boxes: { title: box(0.05, 0.2, 0.9, 0.15), people: box(0.5, 0.4, 0.45, 0.6), logo: box(0, 0, 0.1, 0.1) } },
  } });
  assert.deepEqual(Object.keys(value.channels.linkedin.boxes).sort(), ["people", "title"]);
  assert.equal(value.channels.x, null);
  assert.equal(value.status, "draft");
  assert.match(cleanTemplate({ name: "Y", kind: "event", channels: { linkedin: { background: { url: "https://evil.example.com/a.png" } } } }).error, /image library/);
});

test("ready only with the LinkedIn design and its main boxes placed", () => {
  const base = { name: "Panel", kind: "session" };
  assert.match(cleanTemplate({ ...base, status: "ready" }).error, /LinkedIn design/);
  const noPeople = { ...base, status: "ready", channels: { linkedin: { background: { url: IMG("a") }, boxes: { title: box(0, 0, 1, 0.2) } } } };
  assert.match(cleanTemplate(noPeople).error, /Place the photos on the LinkedIn design/);
  const ok = cleanTemplate({ ...base, status: "ready", channels: { linkedin: { background: { url: IMG("a") }, boxes: { title: box(0, 0, 1, 0.2), people: box(0, 0.3, 1, 0.6) } } } });
  assert.equal(ok.value.status, "ready");
  assert.deepEqual(readyProblems(ok.value), []);
  // A partner template needs its logo placed, not a title.
  assert.match(cleanTemplate({ name: "P", kind: "partner", status: "ready", channels: { linkedin: { background: { url: IMG("p") }, boxes: {} } } }).error, /Place the logo/);
});

test("an edit keeps what it doesn't send", () => {
  const prev = cleanTemplate({ name: "Event", kind: "event", notes: "Gold", channels: { linkedin: { background: { url: IMG("e") }, boxes: { title: box(0, 0, 1, 0.2) } } } }).value;
  const next = cleanTemplate({ name: "Event 2" }, prev).value;
  assert.equal(next.name, "Event 2");
  assert.equal(next.notes, "Gold");
  assert.equal(next.channels.linkedin.background.url, IMG("e"));
});
