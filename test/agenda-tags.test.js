// Admin › Agenda: several pillars and sectors per session, and the extra ones staff add. Run: node --test test/agenda-tags.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { cleanTags, tagsFrom, changeSummary, MAX_NAME } from "../services/agendaTags.js";
import { toSanityPatch } from "../services/cmsSchema.js";

test("the extra lists: trimmed, no blanks or repeats, order kept", () => {
  const { value } = cleanTags({ pillars: [" Space Tech ", "", "space tech", { label: "Bio  Tech" }], sectors: ["Agriculture"] });
  assert.deepEqual(value, { pillars: ["Space Tech", "Bio Tech"], sectors: ["Agriculture"] });
  assert.deepEqual(cleanTags({}).value, { pillars: [], sectors: [] });
  assert.match(cleanTags({ pillars: "x" }).error, /list of pillars/);
  assert.match(cleanTags({ sectors: ["x".repeat(MAX_NAME + 1)] }).error, /too long/);
  assert.deepEqual(tagsFrom(null), { pillars: [], sectors: [] });
  assert.deepEqual(tagsFrom({ pillars: ["A"], sectors: 7 }), { pillars: [], sectors: [] });
});

test("the activity log says what was added and removed", () => {
  assert.equal(changeSummary({ pillars: ["A"], sectors: [] }, { pillars: ["B"], sectors: ["S"] }), "Pillars added: B; Pillars removed: A; Sectors added: S");
  assert.match(changeSummary({ pillars: [], sectors: [] }, { pillars: [], sectors: [] }), /no change/);
});

test("a session takes several pillars and sectors, built-in keys and added names alike", () => {
  const { set, error } = toSanityPatch("session", { pillar: "ai", pillars: ["ai", "Space Tech", "AI", " "], sector: "energy", sectors: ["energy", "Agriculture"] }, { creating: false, draft: true });
  assert.ok(!error, String(error));
  assert.deepEqual(set.pillars, ["ai", "Space Tech"]);
  assert.deepEqual(set.sectors, ["energy", "Agriculture"]);
  assert.equal(set.pillar, "ai");
  assert.equal(set.sector, "energy");
  // The old single values still save (sessions saved before today, the one-time import).
  assert.equal(toSanityPatch("session", { pillar: "climate", sector: "fintech" }, { creating: false, draft: true }).set.pillar, "climate");
  // Emptied lists are removed, not saved as [].
  assert.ok(toSanityPatch("session", { pillars: [] }, { creating: false, draft: true }).unset.includes("pillars"));
  assert.match(toSanityPatch("session", { pillars: Array.from({ length: 9 }, (_, i) => `p${i}`) }, { creating: false, draft: true }).error, /up to 8/);
  assert.match(toSanityPatch("session", { sectors: "energy" }, { creating: false, draft: true }).error, /must be a list/);
});
