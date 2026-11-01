/* The Catalyst Awards winners' pure rules (services/awardWinners.js, Oct 31 2026): the website's award names for the
   canonical pillars and sectors, the defaults (company, presented to, date), the overrides, what's public (never an
   email, phone or nominator), the order, the admin patch, the certificate image check and the way back from LinkedIn.
   Fictional nominees. */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AWARDS_NIGHT, AWARD_IMAGE_MAX_BYTES, PILLAR_NAMES, SECTOR_NAMES, awardReturnUrl, certificateAltText, certificateFromDataUrl,
  cleanAwardPatch, defaultAwardTitle, isAwardState, newAwardState, publicWebsite, publicWinners, winnerAdminRow, winnerIdOfState,
  winnerView,
} from "../services/awardWinners.js";
import { PILLARS, SECTORS } from "../services/nominations.js";

const ID = "6ad000b9745957478367e398";
const nom = (over = {}) => ({
  _id: ID, status: "winner", categoryType: "matrix", pillar: "AI & Machine Learning", sector: "Healthcare & Life Sciences",
  nomineeType: "Organisation", nomineeName: "Northwind Health AI", nomineeOrganisation: "Northwind Health AI",
  nomineeEmail: "ceo@northwind.example.com", nomineePhone: "+1 416 555 0100", nominatorName: "Pat Nominator",
  nominatorEmail: "pat@example.com", statementOverview: "Private statement.", nomineeWebsite: "northwind.example.com", ...over,
});

test("every canonical pillar and sector has the website's display name", () => {
  for (const p of PILLARS) assert.ok(PILLAR_NAMES[p], p);
  for (const s of SECTORS) assert.ok(SECTOR_NAMES[s], s);
});

test("award titles match the /awards page's names", () => {
  assert.equal(defaultAwardTitle(nom()), "The Catalyst Award for Artificial Intelligence in Healthcare & Life Sciences");
  assert.equal(defaultAwardTitle(nom({ pillar: "Robotics & Automation", sector: "Manufacturing, Supply Chain & Mobility" })),
    "The Catalyst Award for Robotics in Manufacturing, Supply Chain & Infrastructure");
  assert.equal(defaultAwardTitle(nom({ pillar: "Cybersecurity & Digital Trust", sector: "Financial Services & Banking" })),
    "The Catalyst Award for Cybersecurity in Banking, Financial Services & Insurance");
  assert.equal(defaultAwardTitle(nom({ categoryType: "special", specialAward: "rising" })), "The Catalyst Rising Innovator Award");
  assert.equal(defaultAwardTitle(nom({ categoryType: "special", specialAward: "crossborder" })), "The Catalyst Cross-Border Impact Award");
});

test("defaults: an organisation is presented to itself; an individual by name with their company", () => {
  const org = winnerView(nom());
  assert.equal(org.presentedTo, "Northwind Health AI");
  assert.equal(org.company, "Northwind Health AI");
  assert.equal(org.showCompany, false);
  assert.equal(org.presentedOn, AWARDS_NIGHT);
  const person = winnerView(nom({ nomineeType: "Individual", nomineeName: "Riley Example", nomineeOrganisation: "Example Robotics" }));
  assert.equal(person.presentedTo, "Riley Example");
  assert.equal(person.company, "Example Robotics");
  assert.equal(person.showCompany, true);
  assert.equal(person.individual, true);
});

test("overrides win; empty text and a bad date fall back to the defaults", () => {
  const w = winnerView(nom({ award: { title: "Best in Show", company: "Northwind Inc.", presentedTo: "Dana Example", presentedOn: "2026-10-27", citation: "  For   care that scales. " } }));
  assert.equal(w.award, "Best in Show");
  assert.equal(w.company, "Northwind Inc.");
  assert.equal(w.presentedTo, "Dana Example");
  assert.equal(w.presentedOn, "2026-10-27");
  assert.equal(w.citation, "For care that scales.");
  const d = winnerView(nom({ award: { title: "", company: " ", presentedOn: "2026-02-31" } }));
  assert.equal(d.award, "The Catalyst Award for Artificial Intelligence in Healthcare & Life Sciences");
  assert.equal(d.company, "Northwind Health AI");
  assert.equal(d.presentedOn, AWARDS_NIGHT);
});

test("public: winners only, hidden ones left out, nothing private", () => {
  const list = publicWinners([
    nom(),
    nom({ _id: "6ad000b9745957478367e399", status: "pending" }),
    nom({ _id: "6ad000b9745957478367e39a", award: { hidden: true } }),
  ]);
  assert.equal(list.length, 1);
  const json = JSON.stringify(list);
  for (const secret of ["ceo@northwind", "555 0100", "Pat Nominator", "pat@example.com", "Private statement"]) assert.ok(!json.includes(secret), secret);
  assert.equal(list[0].website, "https://northwind.example.com/");
});

test("order: the admin's order, then category awards before special ones, then by name", () => {
  const list = publicWinners([
    nom({ _id: "a".repeat(24), categoryType: "special", specialAward: "rising", nomineeName: "Zed" }),
    nom({ _id: "b".repeat(24), pillar: "Quantum Computing", nomineeName: "Qubit" }),
    nom({ _id: "c".repeat(24), nomineeName: "Alpha" }),
    nom({ _id: "d".repeat(24), nomineeName: "First", award: { order: -1 } }),
  ]);
  assert.deepEqual(list.map((w) => w.presentedTo), ["First", "Alpha", "Qubit", "Zed"]);
});

test("websites: only http(s) hosts, always https", () => {
  assert.equal(publicWebsite("www.example.com"), "https://www.example.com/");
  assert.equal(publicWebsite("http://example.com/x"), "https://example.com/x");
  assert.equal(publicWebsite("javascript:alert(1)"), "");
  assert.equal(publicWebsite("not a site"), "");
  assert.equal(publicWebsite("https://user:pw@example.com"), "");
});

test("admin patch: text trimmed, \"\" resets, dates and numbers checked, unknown fields ignored", () => {
  assert.deepEqual(cleanAwardPatch({ title: "  New  name ", presentedTo: "", presentedOn: "2026-10-27", order: 3, hidden: true, status: "pending" }),
    { ok: true, set: { title: "New name", presentedTo: "", presentedOn: "2026-10-27", order: 3, hidden: true } });
  assert.equal(cleanAwardPatch({ presentedOn: "27/10/2026" }).ok, false);
  assert.equal(cleanAwardPatch({ order: 1.5 }).ok, false);
  assert.equal(cleanAwardPatch({ hidden: "yes" }).ok, false);
  assert.equal(cleanAwardPatch({ title: 5 }).ok, false);
  assert.equal(cleanAwardPatch({ title: "x".repeat(201) }).ok, false);
  assert.equal(cleanAwardPatch({}).ok, false);
  assert.deepEqual(cleanAwardPatch({ presentedOn: "" }), { ok: true, set: { presentedOn: "" } });
});

test("admin row: what shows, what was set and the defaults", () => {
  const r = winnerAdminRow(nom({ award: { presentedTo: "Dana Example", hidden: true, updatedBy: "Mia" } }));
  assert.equal(r.presentedTo, "Dana Example");
  assert.equal(r.hidden, true);
  assert.equal(r.set.presentedTo, "Dana Example");
  assert.equal(r.set.title, "");
  assert.equal(r.defaults.presentedTo, "Northwind Health AI");
  assert.equal(r.category, "AI & Machine Learning × Healthcare & Life Sciences");
});

test("certificate images: real JPEGs and PNGs only, of a sane size", () => {
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, 1)]);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 1)]);
  assert.ok(certificateFromDataUrl(`data:image/jpeg;base64,${jpeg.toString("base64")}`));
  assert.ok(certificateFromDataUrl(`data:image/png;base64,${png.toString("base64")}`));
  assert.equal(certificateFromDataUrl(`data:image/png;base64,${jpeg.toString("base64")}`), null);
  assert.equal(certificateFromDataUrl(`data:image/gif;base64,${jpeg.toString("base64")}`), null);
  assert.equal(certificateFromDataUrl("data:image/jpeg;base64,/9j/"), null);
  assert.equal(certificateFromDataUrl(null), null);
  // Sized for one certificate (about 0.3 MB): 2 MB at most.
  const big = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(AWARD_IMAGE_MAX_BYTES, 1)]);
  assert.equal(AWARD_IMAGE_MAX_BYTES, 2 * 1024 * 1024);
  assert.equal(certificateFromDataUrl(`data:image/jpeg;base64,${big.toString("base64")}`), null);
});

test("states and the way back from LinkedIn", () => {
  const s = newAwardState();
  assert.ok(isAwardState(s));
  assert.equal(winnerIdOfState(s), "");
  const withId = newAwardState(ID.toUpperCase());
  assert.match(withId, new RegExp(`^ttfc-awd\\.[0-9a-f]{32}\\.${ID}$`));
  assert.ok(isAwardState(withId));
  assert.equal(winnerIdOfState(withId), ID);
  assert.ok(!isAwardState(`${withId}x`));
  assert.equal(newAwardState("../x").split(".").length, 2, "a bad id is left out");
  assert.ok(!isAwardState("ttfc-att.p" + "0".repeat(32)));
  assert.ok(!isAwardState("ttfc-shr." + "0".repeat(32)));
  const post = "https://www.linkedin.com/feed/update/urn:li:share:7123/";
  assert.equal(awardReturnUrl("https://www.thetechfestival.com/", { id: ID.toUpperCase(), post }),
    `https://www.thetechfestival.com/awards/winners/${ID}#posted=1&post=${encodeURIComponent(post)}`);
  assert.equal(awardReturnUrl("https://www.thetechfestival.com", { id: ID, post: "https://evil.example.com" }),
    `https://www.thetechfestival.com/awards/winners/${ID}#posted=1`);
  assert.equal(awardReturnUrl("https://www.thetechfestival.com", { id: "../x", error: "cancelled" }),
    "https://www.thetechfestival.com/awards#post_error=cancelled");
});

test("alt text names the award, who it was presented to and TTFC", () => {
  const w = winnerView(nom({ nomineeType: "Individual", nomineeName: "Riley Example", nomineeOrganisation: "Example Robotics" }));
  assert.equal(certificateAltText(w),
    "The Catalyst Award for Artificial Intelligence in Healthcare & Life Sciences, presented to Riley Example, Example Robotics at The Tech Festival Canada 2026, The Westin Harbour Castle, Toronto");
});
