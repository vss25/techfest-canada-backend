import { test } from "node:test";
import assert from "node:assert/strict";
import { CMS_FIELDS, toSanityPatch, auditEditDetail, auditCreateDetail, SPONSOR_DESCRIPTION_MAX } from "../services/cmsSchema.js";

/* Sponsors = partner records in the "featured" (paid) row. The admin panel edits a
   description and two switches on that one record; the website and the apps read it. */

const NEW_PARTNER = { name: "NuPort Robotics", category: "partnersAndSupporters", logo: "image-a1-10x10-png", matrixGroup: "featured" };

test("partners carry a description and separate website / app switches", () => {
  const f = CMS_FIELDS.partner;
  assert.equal(f.description.kind, "string");
  assert.equal(f.description.max, 600);
  assert.equal(SPONSOR_DESCRIPTION_MAX, 600);
  assert.equal(f.showOnWebsite.kind, "boolean");
  assert.equal(f.showInApp.kind, "boolean");
  // The alumni strip and the other logo strips don't get them: one source for sponsors.
  for (const t of ["sponsor", "sponsorMarquee", "homeSponsor"]) {
    assert.equal(CMS_FIELDS[t].description, undefined, t);
    assert.equal(CMS_FIELDS[t].showInApp, undefined, t);
  }
});

test("new partners are shown everywhere unless staff switch a place off", () => {
  const p = toSanityPatch("partner", NEW_PARTNER, { creating: true });
  assert.equal(p.error, null);
  assert.equal(p.set.active, true);
  assert.equal(p.set.showOnWebsite, true);
  assert.equal(p.set.showInApp, true);
  const off = toSanityPatch("partner", { ...NEW_PARTNER, showInApp: false }, { creating: true });
  assert.equal(off.set.showInApp, false);
  assert.equal(off.set.showOnWebsite, true);
});

test("switches toggle one place at a time and never touch the master switch", () => {
  const p = toSanityPatch("partner", { showOnWebsite: false }, { creating: false });
  assert.deepEqual(p.set, { showOnWebsite: false });
  assert.deepEqual(p.unset, []);
  assert.deepEqual(toSanityPatch("partner", { showInApp: "true" }, { creating: false }).set, { showInApp: true });
  // Edits don't add defaults.
  assert.deepEqual(toSanityPatch("partner", { name: "Dell Technologies" }, { creating: false }).set, { name: "Dell Technologies" });
  // Cleared = back to the default (shown).
  assert.deepEqual(toSanityPatch("partner", { showInApp: null }, { creating: false }).unset, ["showInApp"]);
});

test("descriptions are trimmed, capped at 600 characters, keep line breaks, and clear to unset", () => {
  const long = "x".repeat(700);
  assert.equal(toSanityPatch("partner", { description: long }, { creating: false }).set.description.length, 600);
  assert.equal(toSanityPatch("partner", { description: "  Robots for warehouses.\nMade in Toronto.  " }, { creating: false }).set.description,
    "Robots for warehouses.\nMade in Toronto.");
  assert.deepEqual(toSanityPatch("partner", { description: "" }, { creating: false }).unset, ["description"]);
});

test("audit log shows where a partner was switched on or off", () => {
  assert.equal(auditEditDetail({ showInApp: false, description: "Hi" }, []), "showInApp=false, description");
  assert.equal(auditEditDetail({}, ["showOnWebsite", "description"]), "showOnWebsite=true, description");
  // The session live switches keep their wording.
  assert.equal(auditEditDetail({ polls: "off", title: "Panel" }, ["qa"]), "polls=off, title, qa=auto");
  assert.equal(auditCreateDetail(toSanityPatch("partner", NEW_PARTNER, { creating: true }).set),
    "NuPort Robotics · showOnWebsite=true, showInApp=true");
  assert.equal(auditCreateDetail({ title: "Panel", polls: "on" }), "Panel · polls=on");
  assert.equal(auditCreateDetail({ name: "Amazon" }), "Amazon");
});
