import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanOutreach, pastOrgs, pastPeople, roleOf, withOutreach } from "../services/pastParticipants.js";

const VAN = "ttfc-2027-vancouver-briefing";
const person = (id, o = {}) => ({ id, name: id, types: [], passList: [{ eventKey: "ttfc-2026-main" }], primary: { label: "Power Pass" }, ...o });

test("past people: had a pass for another event, none for this one; never staff; what they were", () => {
  const people = [
    person("delegate"), person("exhibitor", { exhibitor: true, company: "Northline" }), person("speaker", { types: ["speaker"] }),
    person("staffer", { types: ["staff"] }), person("already-here", { passList: [{ eventKey: "ttfc-2026-main" }, { eventKey: VAN }] }),
    person("no-pass", { passList: [] }), person("old-pass", { passList: [{}] }), person("hidden-only", { passList: [{ eventKey: "ttfc-2026-main", hidden: true }] }),
  ];
  const rows = pastPeople(people, VAN);
  assert.deepEqual(rows.map((r) => [r.key, r.role]), [["exhibitor", "Exhibitor"], ["speaker", "Speaker"], ["delegate", "Delegate"], ["old-pass", "Delegate"]]);
  assert.deepEqual(rows[0].events, ["ttfc-2026-main"]);
  assert.equal(roleOf({ types: ["media"] }), "Media");
  // For the first event nobody is "past", not even someone who only has a later event's pass.
  assert.equal(pastPeople([...people, person("van-only", { passList: [{ eventKey: VAN }] })], "ttfc-2026-main").length, 0);
});

test("past organisations: partners of other events only; the featured row are sponsors", () => {
  const rows = pastOrgs([
    { _id: "a", name: "Logitech", matrixGroup: "featured", events: ["event-ttfc-2026-main"] },
    { _id: "b", name: "Acme AI", matrixGroup: "ai", events: ["event-ttfc-2026-main"] },
    { _id: "c", name: "Already", matrixGroup: "ai", events: ["event-ttfc-2026-main", `event-${VAN}`] },
    { _id: "d", name: "Everywhere", matrixGroup: "ai", events: [] },
  ], `event-${VAN}`);
  assert.deepEqual(rows.map((r) => [r.name, r.role]), [["Logitech", "Sponsor"], ["Acme AI", "Partner"]]);
});

test("reach-outs attach to their row; counts for the tiles; statuses from the list", () => {
  const rows = [{ kind: "org", key: "a", role: "Sponsor" }, { kind: "person", key: "p1", role: "Delegate" }];
  const { list, counts } = withOutreach(rows, [{ _id: "o1", kind: "org", key: "a", status: "interested", byName: "Sam", at: "2026-11-20T10:00:00Z" }]);
  assert.equal(list[0].outreach.status, "interested"); assert.equal(list[1].outreach, null);
  assert.deepEqual(counts, { total: 2, notContacted: 1, byRole: { Sponsor: 1, Delegate: 1 }, byStatus: { interested: 1 } });
  assert.equal(cleanOutreach("not_now"), "not_now"); assert.equal(cleanOutreach("sold"), null);
});
