import test from "node:test";
import assert from "node:assert/strict";
import {
  buildExhibitors, cleanBoothNo, boothNumber, zoneOf, showableName, EXHIBITOR_FIELDS, PUBLIC_ZONES, ZONES, PASS_SELECT,
} from "../services/exhibitors.js";
import { BUILTIN_ALIASES } from "../services/organisations.js";

/* The public exhibitor list (Oct 24 2026, the website's /programme page): one entry per organisation with a booth on
   an exhibitor pass, its booths, zone, logo and website, and nothing about the people. Pure parts; the route is in
   exhibitors-db. Fictional companies and people (example.com / .test addresses). */

let n = 0;
const pass = (company, booth, extra = {}) => ({
  _id: `a${++n}`, name: `Person ${n}`, email: `person${n}@example.com`, promoCode: "EXHIBITOR",
  issuedPass: { booth: { booth, zone: extra.zone ?? "", passes: "4" } }, details: { organisation: company, phone: "+1 416 555 0100", jobTitle: "Head of Sales" },
  ...extra,
});
const org = (key, extra = {}) => ({ key, name: key, logo: "", website: "", hidden: false, hiddenBy: "", ...extra });

test("booth numbers: as staff type them, one form; zones from the text, else the number", () => {
  assert.deepEqual(["07", "7", " 12 ", "Booth 3", "booth no. 4", "#5", "12a", "012 b", "Lounge", "", null, "  "].map(cleanBoothNo), ["7", "7", "12", "3", "4", "5", "12A", "12B", "Lounge", "", "", ""]);
  assert.deepEqual(["12A", "7", "x", ""].map(boothNumber), [12, 7, NaN, NaN]);
  assert.equal(zoneOf("Zone A - Harbour Ballroom Foyer", "20"), "A");   // what staff typed wins
  assert.equal(zoneOf("Zone B - Pier 4 & 5 Foyer", "3"), "B");
  assert.equal(zoneOf("zone b", ""), "B");
  assert.equal(zoneOf("", "1"), "A");
  assert.equal(zoneOf("", "15"), "A");
  assert.equal(zoneOf("", "16"), "B");
  assert.equal(zoneOf("", "25"), "B");
  assert.equal(zoneOf("", "26"), "");
  assert.equal(zoneOf("Lobby", "Lounge"), "");
  assert.deepEqual(PUBLIC_ZONES, [
    { key: "A", name: "Zone A", area: "Harbour Ballroom Foyer", booths: "1–15" },
    { key: "B", name: "Zone B", area: "Pier 4 & 5 Foyer", booths: "16–25" },
  ]);
  assert.equal(ZONES.length, 2);
});

test("company names that never go on the public page", () => {
  for (const bad of ["", "n/a", "Student", "jane@acme.example", "https://acme.example", "www.acme.example", "acme.example/about",
    "Call 416 555 0100", "a1b2c3d4e5f6", "BOOTH-DOUBLE-1", "Person 9"]) {
    assert.equal(showableName(bad, "Person 9"), false, bad);
  }
  for (const ok of ["Acme Robotics", "3M", "1Password", "AT&T", "Northwind Quantum Ltd.", "acme.io"]) assert.equal(showableName(ok, "Pat"), true, ok);
});

test("one entry per organisation: booths merged, zone, name, logo and website from the organisations list", () => {
  const passes = [
    pass("Acme Robotics", "07", { zone: "Zone A - Harbour Ballroom Foyer" }),
    pass("Acme Robotics Inc.", "7"),                                  // the same booth, the same organisation
    pass("acme robotics", "8"),                                       // a double booth
    pass("Fabrikam AI", "18"),
    pass("Litware", "2", { companyLogoUrl: "https://res.cloudinary.com/demo/image/upload/litware.png" }),
    pass("Dell", "12"),                                               // a built-in alias: Dell Technologies
    pass("Contoso", "Lounge"),                                        // no number: no zone, after the numbered ones
  ];
  const orgs = [
    org("acme robotics", { name: "Acme Robotics", logo: "https://cdn.sanity.io/images/021qtoci/production/acme.png", website: "https://acme.example/" }),
    org("dell technologies", { name: "Dell Technologies", logo: "https://cdn.sanity.io/images/021qtoci/production/dell.png", website: "https://www.dell.com/" }),
    org("fabrikam ai", { name: "Fabrikam AI", logo: "http://insecure.example/logo.png", website: "javascript:alert(1)" }),
  ];
  const list = buildExhibitors({ passes, orgs, aliases: { ...BUILTIN_ALIASES, dell: "dell technologies" } });
  assert.deepEqual(list.map((x) => [x.name, x.booth, x.booths, x.zone]), [
    ["Litware", "2", ["2"], "A"],
    ["Acme Robotics", "7 & 8", ["7", "8"], "A"],
    ["Dell Technologies", "12", ["12"], "A"],
    ["Fabrikam AI", "18", ["18"], "B"],
    ["Contoso", "Lounge", ["Lounge"], ""],
  ]);
  const by = Object.fromEntries(list.map((x) => [x.key, x]));
  assert.equal(by["acme robotics"].logo, "https://cdn.sanity.io/images/021qtoci/production/acme.png");
  assert.equal(by["acme robotics"].website, "https://acme.example/");
  assert.equal(by.litware.logo, "https://res.cloudinary.com/demo/image/upload/litware.png");   // the logo staff set on the pass
  assert.equal(by.litware.website, "");
  assert.deepEqual([by["fabrikam ai"].logo, by["fabrikam ai"].website], ["", ""]);              // https logos, http(s) sites only
  for (const x of list) assert.deepEqual(Object.keys(x), EXHIBITOR_FIELDS);
});

test("left out: not an exhibitor pass, no booth, hidden by staff, duplicates, hidden from the app, junk names, hidden organisations", () => {
  const hiddenPass = pass("Shadow Co", "3");
  const claimed = pass("Claimed Hidden Co", "4", { claimedBy: "u-hidden" });
  const passes = [
    pass("Plain Pass Co", "5", { promoCode: "ISSUED" }),                    // an issued pass that isn't an exhibitor's
    pass("Switched Off Co", "6", { exhibitor: false }),                     // staff's Exhibitor = No
    pass("Switched On Co", "9", { promoCode: "", exhibitor: true }),        // staff's Exhibitor = Yes on another pass
    pass("No Booth Co", ""),
    pass("Test Ticket Co", "10", { hiddenByStaff: true }),
    pass("Dupe Co", "11", { syncDuplicate: true }),
    hiddenPass, claimed,
    pass("jane@acme.example", "13"),
    pass("Person 999", "14", { name: "Person 999" }),                      // their own name
    pass("Hidden Org", "17"),
    pass("Partner Off Org", "19"),
  ];
  const hidden = { ids: new Set(["u-hidden"]), emails: new Set(), passes: new Set([hiddenPass._id]), tickets: new Set() };
  const orgs = [org("hidden org", { hidden: true, hiddenBy: "staff" }), org("partner off org", { name: "Partner Off Org", hidden: true, hiddenBy: "partner" })];
  const list = buildExhibitors({ passes, orgs, hidden });
  assert.deepEqual(list.map((x) => x.name), ["Switched On Co", "Partner Off Org"]);
});

test("nothing about the people, passes or orders leaves: a deep scan of the payload", () => {
  const passes = [pass("Acme Robotics", "7", { name: "Jordan Secretname", email: "jordan.secret@acme.example", ticketId: "abc123def456", manualValue: 999 })];
  const out = JSON.stringify(buildExhibitors({ passes }));
  for (const secret of ["Jordan", "Secretname", "jordan.secret", "@", "555", "Head of Sales", "abc123def456", "999", "passes", "EXHIBITOR"]) {
    assert.equal(out.includes(secret), false, secret);
  }
  // The database read never asks for phones, job titles, prices, orders or Stripe fields.
  for (const f of ["phone", "jobTitle", "stripe", "manualValue", "ticketId", "purchaseDate", "passes"]) assert.equal(PASS_SELECT.includes(f), false, f);
});
