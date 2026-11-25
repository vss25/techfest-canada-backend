/* Admin › Agenda › session types (Nov 25 2026): the pure rules in services/agendaTypes.js. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TYPES, cleanTypes, typesFrom, changeSummary } from "../services/agendaTypes.js";
import { SESSION_FORMATS } from "../services/cmsSchema.js";

test("the standard list has the new categories, each on a known colour style", () => {
  const labels = DEFAULT_TYPES.map((t) => t.label);
  for (const l of ["Case Study", "Roundtable", "Reception", "Closing Remarks", "Keynote", "Panel Session"]) assert.ok(labels.includes(l), l);
  for (const t of DEFAULT_TYPES) assert.ok(SESSION_FORMATS.includes(t.format), t.label);
});

test("cleanTypes tidies, keeps order, drops blanks and refuses duplicates", () => {
  const { value } = cleanTypes([{ label: "  Case   Study ", format: "briefing" }, { label: "" }, { label: "Reception", format: "nope" }]);
  assert.deepEqual(value, [{ label: "Case Study", format: "briefing" }, { label: "Reception", format: "keynote" }]);
  assert.match(cleanTypes([{ label: "Panel" }, { label: "panel" }]).error, /twice/);
  assert.match(cleanTypes([]).error, /at least one/);
  assert.match(cleanTypes("x").error, /list/);
  assert.match(cleanTypes([{ label: "x".repeat(61) }]).error, /60 characters/);
});

test("typesFrom falls back to the standard list", () => {
  assert.equal(typesFrom(undefined), DEFAULT_TYPES);
  assert.equal(typesFrom([]), DEFAULT_TYPES);
  assert.deepEqual(typesFrom([{ label: "Talk", format: "keynote" }]), [{ label: "Talk", format: "keynote" }]);
});

test("changeSummary says what changed in plain words", () => {
  const a = [{ label: "Keynote", format: "keynote" }, { label: "Break", format: "break" }];
  assert.equal(changeSummary(a, [...a, { label: "Roundtable", format: "dialogue" }]), "Session types: added Roundtable");
  assert.equal(changeSummary(a, [a[0]]), "Session types: removed Break");
  assert.equal(changeSummary(a, [a[1], a[0]]), "Session types: reordered the list");
  assert.equal(changeSummary(a, [{ label: "Keynote", format: "opening" }, a[1]]), "Session types: changed the colour of Keynote");
});
