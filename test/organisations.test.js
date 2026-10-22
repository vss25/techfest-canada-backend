import test from "node:test";
import assert from "node:assert/strict";
import {
  isJunkOrgName, resolveKey, aliasTable, orgKeyOf, buildOrganisations, attendingPeople, personDomain, domainMatchesOrg,
  pickAutoLogo, isSponsorPartner, partnerShortKey, topicsFor, httpsUrl, BUILTIN_ALIASES, PARTNER_CATEGORIES, DEFAULT_SCALE,
} from "../services/organisations.js";

/* The apps' organisations list (Oct 21 2026): one deduplicated list from the website's partners, the speakers'
   companies and everyone attending, with the logo from the website first, then the Company record, then the
   automatic search, else none. Pure parts; the routes and the background search are in organisations-awards-db.
   Fictional companies and people (example.com where an address is needed). */

const ORG_KEYS = ["key", "name", "logo", "logoSource", "website", "kind", "topics", "description", "scale", "attendeeCount", "speakerCount", "aliases"];
const partner = (extra) => ({ _id: `p-${extra.name}`, category: "corporateEnterprisePartners", order: 10, logo: `https://cdn.sanity.io/images/021qtoci/production/${extra.name}.png`, ...extra });
const person = (id, org, extra = {}) => ({ id, name: `Person ${id}`, org, domain: "", ...extra });

/* ---------- junk names ---------- */

test("junk organisation names: the contract's list, email domains, email addresses and the person's own name", () => {
  for (const n of ["", "  ", "n/a", "N/A", "NA", "None", "-", "—", "Self", "self-employed", "Self Employed", "Independent", "freelance",
    "Student", "Retired", "personal", "Private", "TBD", "Confidential", "gmail", "Gmail.com", "hotmail.co.uk", "yahoo.ca", "outlook.com",
    "jane@acme.com", "Unknown", "null"]) {
    assert.equal(isJunkOrgName(n), true, JSON.stringify(n));
  }
  assert.equal(isJunkOrgName("Jordan Rivers", "Jordan Rivers"), true);    // their own name
  assert.equal(isJunkOrgName("jordan rivers inc.", "Jordan Rivers"), true);
  for (const n of ["IBM", "Acme Robotics", "Northwind Quantum Ltd.", "Rogers", "Bell Canada", "X", "AT&T", "Government of Ontario", "acme.io"]) {
    assert.equal(isJunkOrgName(n, "Pat Person"), false, n);
  }
});

/* ---------- aliases ---------- */

test("aliases: built-in ones are few and safe; IBM Consulting is never IBM; chains and loops stop", () => {
  assert.equal(BUILTIN_ALIASES["ontario government"], "government of ontario");
  assert.equal(orgKeyOf("Ontario Government"), "government of ontario");
  assert.equal(orgKeyOf("Government of Ontario"), "government of ontario");
  assert.equal(orgKeyOf("Royal Bank of Canada", BUILTIN_ALIASES), "rbc");
  assert.notEqual(orgKeyOf("IBM Consulting", BUILTIN_ALIASES), orgKeyOf("IBM", BUILTIN_ALIASES));
  assert.notEqual(orgKeyOf("Dell", BUILTIN_ALIASES), orgKeyOf("Dell Technologies", BUILTIN_ALIASES));
  for (const [from, into] of Object.entries(BUILTIN_ALIASES)) assert.ok(!(into in BUILTIN_ALIASES), `${from} → ${into} is a chain`);
  assert.equal(resolveKey("a", { a: "b", b: "c" }), "c");
  assert.equal(resolveKey("a", { a: "b", b: "a" }), "b");      // a loop stops
  assert.equal(resolveKey("z", { a: "b" }), "z");
  assert.equal(orgKeyOf("Student"), "");
});

test("aliases: a partner's own short CMS name; staff merges win; staff can switch a built-in one off", () => {
  const dell = partner({ _id: "82f1d0a0-0167-479a-94e3-4b9ffeefb24d", name: "dell" });   // displayed "Dell Technologies"
  assert.equal(partnerShortKey(dell), "dell");
  assert.equal(partnerShortKey(partner({ name: "csa" })), "");     // "Canada Startup Association" doesn't start with "csa"
  assert.equal(partnerShortKey(partner({ name: "IBM" })), "");
  const a = aliasTable({ partners: [dell], settings: [{ key: "ibm canada", aliasOf: "ibm" }, { key: "ontario government", aliasOff: true }] });
  assert.equal(a.dell, "dell technologies");
  assert.equal(a["ibm canada"], "ibm");
  assert.equal("ontario government" in a, false);
  assert.equal(orgKeyOf("IBM Canada Ltd.", a), "ibm");
});

/* ---------- the list ---------- */

const sample = () => ({
  partners: [
    partner({ _id: "82f1d0a0-0167-479a-94e3-4b9ffeefb24d", name: "dell", order: 2, description: " Servers and AI factories. ", website: "dell.com", logoScale: 140 }),
    partner({ _id: "pd7BC9mehWAqIUtnYVm0zi", name: "NuPort Robotics", displayName: "NuPort Robotics", order: 1 }),          // built-in sponsor
    partner({ _id: "x1", name: "Northwind Quantum", displayName: "Northwind Quantum", matrixGroup: "featured", order: 5 }),
    partner({ _id: "x2", name: "IBM", displayName: "IBM", matrixGroup: "quantum", category: "corporateEnterprisePartners", order: 1 }),
    partner({ _id: "x3", name: "Lakeview Health", matrixGroup: "health", category: "governmentPartners" }),
    partner({ _id: "x4", name: "Hidden Partner", showInApp: false }),
    partner({ _id: "x5", name: "Gone Partner", active: false }),
  ],
  logos: [{ name: "Contoso Bank", logo: "https://cdn.sanity.io/images/021qtoci/production/contoso.png" }],
  speakers: [{ _id: "s1", name: "Ada Speaker", company: "IBM" }, { _id: "s2", name: "Bo Speaker", company: "Fabrikam AI" }, { _id: "s3", name: "Cy Self", company: "Cy Self" }],
  people: [
    person("u1", "Dell"), person("u2", "Dell Technologies Inc."), person("u3", "IBM Consulting"), person("u4", "ibm"),
    person("u5", "Ontario Government"), person("u6", "Government of Ontario"), person("u7", "government of ontario"),
    person("u8", "Fabrikam AI", { domain: "fabrikam.ai" }), person("u9", "fabrikam ai", { domain: "fabrikam.ai" }),
    person("u10", "Student"), person("u11", ""), person("u12", "Person u12"),
    person("u13", "Contoso Bank"), person("u14", "Hidden Partner"), person("u15", "Tailspin Toys", { domain: "gmail-like.example" }),
    person("u16", "Woodgrove", { domain: "woodgrove.ca" }), person("u17", "Litware", { domain: "unrelated.com" }),
  ],
  companies: [
    { nameKey: "woodgrove", name: "Woodgrove", logoUrl: "https://res.cloudinary.com/demo/woodgrove.png", logoSource: "upload", updatedBy: "Mia Manager" },
    { nameKey: "litware", name: "Litware", logoUrl: "https://res.cloudinary.com/demo/litware.png", logoSource: "auto", updatedBy: "Automatic" },
    { nameKey: "contoso bank", name: "Contoso Bank", logoUrl: "https://res.cloudinary.com/demo/contoso-staff.png", logoSource: "upload", updatedBy: "Mia Manager" },
  ],
  settings: [],
});

test("list: featured = the Featured Partners row in display order; attending = everyone else by people, then name", () => {
  const { featured, attending } = buildOrganisations(sample());
  assert.deepEqual(featured.map((o) => o.name), ["NuPort Robotics", "Dell Technologies", "Northwind Quantum"]);
  for (const o of [...featured, ...attending]) assert.deepEqual(Object.keys(o), ORG_KEYS, o.name);
  const counts = attending.map((o) => o.attendeeCount);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  assert.equal(attending[0].name, "Government of Ontario");          // 3 people under two spellings: one organisation
  assert.equal(attending[0].attendeeCount, 3);
  // Featured never shows again under In attendance.
  assert.equal(attending.some((o) => o.key === "dell technologies"), false);
});

test("list: duplicates merged by key; IBM and IBM Consulting stay apart; junk names and own names count nothing", () => {
  const { featured, attending } = buildOrganisations(sample());
  const all = [...featured, ...attending];
  const by = (name) => all.find((o) => o.name === name);
  assert.equal(new Set(all.map((o) => o.key)).size, all.length);
  // "Dell" (the partner's short name) and "Dell Technologies Inc." are the partner Dell Technologies.
  assert.equal(by("Dell Technologies").attendeeCount, 2);
  assert.deepEqual(by("Dell Technologies").aliases, ["dell"]);
  // Every alias pointing here, used or not, so a client can match people whose organisation was merged in.
  assert.deepEqual(by("Government of Ontario").aliases, ["govt of ontario", "ontario government", "province of ontario"]);
  assert.deepEqual(by("IBM Consulting").aliases, []);
  assert.equal(by("IBM").attendeeCount, 1);
  assert.equal(by("IBM").speakerCount, 1);
  assert.equal(by("IBM Consulting").attendeeCount, 1);
  assert.equal(by("Fabrikam AI").attendeeCount, 2);
  assert.equal(by("Fabrikam AI").speakerCount, 1);
  for (const junk of ["Student", "Person u12", "Cy Self", ""]) assert.equal(all.some((o) => o.name === junk), false, junk);
});

test("list: a partner switched off for the app keeps its organisation out; staff can hide one", () => {
  const { attending, rows } = buildOrganisations(sample());
  assert.equal(attending.some((o) => /hidden partner|gone partner/i.test(o.name)), false);
  assert.equal(rows.find((r) => r.key === "hidden partner").hiddenBy, "partner");
  const s = sample();
  s.settings = [{ key: "fabrikam ai", hidden: true }];
  const after = buildOrganisations(s);
  assert.equal(after.attending.some((o) => o.key === "fabrikam ai"), false);
  assert.deepEqual([after.rows.find((r) => r.key === "fabrikam ai").hidden, after.rows.find((r) => r.key === "fabrikam ai").hiddenBy], [true, "staff"]);
});

test("list: staff's merge (X into Y) moves X's people and speakers under Y", () => {
  const s = sample();
  s.settings = [{ key: "ibm consulting", aliasOf: "ibm" }];
  const { attending, rows } = buildOrganisations(s);
  const ibm = attending.find((o) => o.key === "ibm");
  assert.equal(ibm.attendeeCount, 2);
  assert.equal(attending.some((o) => o.key === "ibm consulting"), false);
  assert.deepEqual(rows.find((r) => r.key === "ibm").mergedKeys, ["ibm consulting"]);
});

test("logo: the website first (partner, then the logo strips), then the Company record, then automatic, else none", () => {
  const { featured, attending, needsLogo } = buildOrganisations(sample());
  const all = [...featured, ...attending];
  const by = (key) => all.find((o) => o.key === key);
  assert.deepEqual([by("dell technologies").logoSource, by("dell technologies").logo], ["website", "https://cdn.sanity.io/images/021qtoci/production/dell.png"]);
  // Contoso Bank: a staff Company logo exists, but the website's strip has one: the website's wins.
  assert.deepEqual([by("contoso bank").logoSource, by("contoso bank").logo], ["website", "https://cdn.sanity.io/images/021qtoci/production/contoso.png"]);
  assert.deepEqual([by("woodgrove").logoSource, by("woodgrove").logo], ["company", "https://res.cloudinary.com/demo/woodgrove.png"]);
  assert.deepEqual([by("litware").logoSource, by("litware").logo], ["auto", "https://res.cloudinary.com/demo/litware.png"]);
  assert.deepEqual([by("ibm consulting").logoSource, by("ibm consulting").logo], ["", ""]);
  // Only Fabrikam AI gets a search: its people's work domain looks like its name. Tailspin's (unrelated) and
  // IBM Consulting's (none) don't; organisations with a logo don't.
  assert.deepEqual(needsLogo, [{ key: "fabrikam ai", name: "Fabrikam AI", domain: "fabrikam.ai" }]);
});

test("logo: never searched again over a logo staff cleared; a staff domain is used as it is", () => {
  const s = sample();
  s.companies.push({ nameKey: "fabrikam ai", name: "Fabrikam AI", logoUrl: "", updatedBy: "Mia Manager" });   // staff cleared it
  assert.deepEqual(buildOrganisations(s).needsLogo, []);
  const t = sample();
  t.companies.push({ nameKey: "ibm consulting", name: "IBM Consulting", domain: "consulting.example-ibm.com", logoUrl: "", updatedBy: "Automatic" });
  assert.deepEqual(buildOrganisations(t).needsLogo.map((n) => n.key).sort(), ["fabrikam ai", "ibm consulting"]);
});

test("fields: kind, topics, description, website (http(s)), scale from the partner; others plain", () => {
  const { featured, attending } = buildOrganisations(sample());
  const all = [...featured, ...attending];
  const by = (key) => all.find((o) => o.key === key);
  const dell = by("dell technologies");
  // kind = the CMS category key; scale = the CMS logoScale percentage.
  assert.deepEqual([dell.kind, dell.description, dell.website, dell.scale], ["corporateEnterprisePartners", "Servers and AI factories.", "https://dell.com/", 140]);
  assert.equal(by("nuport robotics").scale, DEFAULT_SCALE);
  assert.ok(dell.topics.includes("Artificial Intelligence"));
  assert.ok(dell.topics.includes("Robotics & Automation"));
  const ibm = by("ibm");
  assert.ok(ibm.topics.includes("Quantum Computing"));       // its Partners page row and the topic map
  assert.ok(ibm.topics.includes("Cybersecurity"));
  assert.equal(by("lakeview health").kind, "governmentPartners");
  assert.deepEqual(by("lakeview health").topics, ["Healthcare & Lifesciences"]);
  const fab = by("fabrikam ai");
  assert.deepEqual([fab.kind, fab.description, fab.website, fab.scale, fab.topics], ["", "", "", 100, []]);
  assert.ok(PARTNER_CATEGORIES.includes("academicResearchInstitutions"));
  for (const o of all) {
    assert.ok(o.kind === "" || PARTNER_CATEGORIES.includes(o.kind), o.kind);
    assert.ok(o.logo === "" || o.logo.startsWith("https://"), o.logo);
    assert.ok(Number.isInteger(o.scale) && o.scale >= 30 && o.scale <= 250, String(o.scale));
  }
  assert.deepEqual(topicsFor("LCBO"), ["Supply Chain, Manufacturing & Infrastructure"]);
  assert.deepEqual(topicsFor("IBM Canada"), []);              // not a partner: the exact name only
});

test("sponsors: matrixGroup featured, or the built-in four while the row is Automatic", () => {
  assert.equal(isSponsorPartner({ _id: "x", matrixGroup: "featured" }), true);
  assert.equal(isSponsorPartner({ _id: "pd7BC9mehWAqIUtnYVm0zi" }), true);
  assert.equal(isSponsorPartner({ _id: "pd7BC9mehWAqIUtnYVm0zi", matrixGroup: "robotics" }), false);
  assert.equal(isSponsorPartner({ _id: "x", matrixGroup: "nonsense" }), false);
});

/* ---------- who counts as attending ---------- */

test("attending people: any pass; not hidden from the app, out of the directory, suspended, booths or staff-hidden tickets", () => {
  const pass = (id, extra = {}) => ({ ticketId: id, type: "connect", ...extra });
  const users = [
    { _id: "a1", name: "Ann", email: "ann@woodgrove.ca", organization: "Woodgrove", tickets: [pass("c1")] },
    { _id: "a2", name: "Ben", email: "ben@example.com", organization: "Banned Co", banned: true, tickets: [pass("c2")] },
    { _id: "a3", name: "Cal", email: "cal@example.com", organization: "Hidden Dir", directoryHidden: true, tickets: [pass("c3")] },
    { _id: "a4", name: "Dee", email: "dee@example.com", organization: "Shadow Co", tickets: [pass("c4")] },
    { _id: "a5", name: "Eve", email: "eve@example.com", organization: "Booth Only", tickets: [{ ticketId: "BOOTH-STANDARD", type: "booth-standard" }] },
    { _id: "a6", name: "Fay", email: "fay@example.com", organization: "Test Ticket", tickets: [pass("c6", { hiddenByStaff: true })] },
    { _id: "a7", name: "Gus", email: "gus@gmail.com", organization: "", tickets: [pass("c7", { details: { organisation: "From Checkout" } })] },
  ];
  const guests = [
    { _id: "g1", name: "Ann", email: "ann@woodgrove.ca", ticketId: "c8", details: { organisation: "Woodgrove" } },           // Ann again
    { _id: "g2", name: "Ben", email: "ben@example.com", ticketId: "c9", details: { organisation: "Banned Co" } },             // suspended Ben's pass
    { _id: "g3", name: "Hal", email: "hal@litware.com", ticketId: "c10", details: { organisation: "Litware" } },
    { _id: "g4", name: "Hal", email: "hal@litware.com", ticketId: "c11", details: { organisation: "Litware" } },             // two passes, one person
    { _id: "g5", name: "Ivy", email: "ivy@example.com", ticketId: "c12", details: { organisation: "Dup" }, syncDuplicate: true },
    { _id: "g6", name: "Jo", email: "jo@example.com", ticketId: "c13", details: { organisation: "Shadow Pass" } },
    { _id: "g7", name: "Guest", email: "guest@example.com", ticketId: "c14", details: { organisation: "Placeholder" } },
    { _id: "g8", name: "Kim", email: "kim@example.com", ticketId: "BOOTH-1", details: { organisation: "Booth Co" } },
  ];
  const hidden = { ids: new Set(["a4"]), emails: new Set(["dee@example.com"]), passes: new Set(["g6"]), tickets: new Set() };
  const people = attendingPeople({ users, guests, hidden });
  assert.deepEqual(people.map((p) => p.org).sort(), ["From Checkout", "Litware", "Woodgrove"]);
  assert.equal(people.find((p) => p.org === "Woodgrove").domain, "woodgrove.ca");
  assert.equal(people.find((p) => p.org === "From Checkout").domain, "");   // a personal mailbox
  // Never anything but these four fields.
  for (const p of people) assert.deepEqual(Object.keys(p), ["id", "name", "org", "domain"]);
});

test("work domains: never personal mailboxes, pass placeholders, our own or reserved names", () => {
  assert.equal(personDomain("pat@sub.woodgrove.ca"), "woodgrove.ca");
  assert.equal(personDomain("pat@gmail.com"), "");
  assert.equal(personDomain("pat@hotmail.co.uk"), "");
  assert.equal(personDomain("con123@ticket.thetechfestival.com"), "");
  assert.equal(personDomain("lubna@thetechfestival.com"), "");
  assert.equal(personDomain("pat@example.com"), "");
  assert.equal(personDomain(""), "");
});

test("a work domain is only used when it looks like the organisation", () => {
  assert.equal(domainMatchesOrg("woodgrove.ca", ["Woodgrove Bank"]), true);
  assert.equal(domainMatchesOrg("rbc.com", ["Royal Bank of Canada"]), true);      // initials
  assert.equal(domainMatchesOrg("ey.com", ["Ernst & Young"]), true);
  assert.equal(domainMatchesOrg("utoronto.ca", ["University of Toronto"]), true);
  assert.equal(domainMatchesOrg("ontario.ca", ["Government of Ontario"]), true);
  assert.equal(domainMatchesOrg("td.com", ["TD Bank"]), true);
  assert.equal(domainMatchesOrg("deepcovecyber.com", ["Deep Cove Cyber"]), true);
  assert.equal(domainMatchesOrg("bankrate.com", ["Bank of Montreal"]), false);   // a generic word isn't enough
  assert.equal(domainMatchesOrg("unrelated.com", ["Litware"]), false);
  assert.equal(domainMatchesOrg("fb.com", ["Meta"]), false);                      // unsure: no logo
});

test("the automatic pick: the company's own icon, Google, DuckDuckGo; never Wikimedia, a social image or a tiny icon", () => {
  const c = (source, extra = {}) => ({ url: `https://img.example/${source}`, source, width: 180, height: 180, contentType: "image/png", ...extra });
  assert.equal(pickAutoLogo([c("wikimedia"), c("site", { kind: "og:image" }), c("site", { width: 32, height: 32 }), c("google", { width: 256, height: 256 })]).source, "google");
  assert.equal(pickAutoLogo([c("site", { kind: "apple-touch-icon" }), c("google")]).source, "site");
  assert.equal(pickAutoLogo([c("site", { width: 0, height: 0, contentType: "image/svg+xml" })]).contentType, "image/svg+xml");
  assert.equal(pickAutoLogo([c("wikimedia"), c("duckduckgo", { width: 16, height: 16 })]), null);
  assert.equal(pickAutoLogo([]), null);
});

test("formats: logos are absolute https URLs or nothing; scale is the CMS percentage, clamped; unknown categories are \"\"", () => {
  assert.equal(httpsUrl("https://cdn.sanity.io/images/021qtoci/production/a.png"), "https://cdn.sanity.io/images/021qtoci/production/a.png");
  for (const bad of ["http://cdn.example/a.png", "/api/files/company-logo/abc", "javascript:alert(1)", "", null, "https://localhost/x"]) {
    assert.equal(httpsUrl(bad), "", String(bad));
  }
  const { featured, attending } = buildOrganisations({
    partners: [
      partner({ _id: "y1", name: "Tiny", logoScale: 5, category: "nonsense" }),
      partner({ _id: "y2", name: "Huge", logoScale: 900, logo: "http://insecure.example/huge.png" }),
    ],
    companies: [{ nameKey: "plain", name: "Plain", logoUrl: "http://insecure.example/plain.png", updatedBy: "Mia Manager" }],
    people: [person("p1", "Plain")],
  });
  const by = (key) => [...featured, ...attending].find((o) => o.key === key);
  assert.deepEqual([by("tiny").scale, by("tiny").kind], [30, ""]);
  assert.deepEqual([by("huge").scale, by("huge").logo, by("huge").logoSource], [250, "", ""]);
  assert.deepEqual([by("plain").logo, by("plain").logoSource], ["", ""]);
});
