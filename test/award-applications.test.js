import test from "node:test";
import assert from "node:assert/strict";
import {
  applicationsPayload, summaryPayload, applicationItem, categoriesCount, categoryKey, safeWebsite, isEligible,
  ITEM_FIELDS, NOMINATION_SELECT, APPLICATIONS_KEY, MAX_CATEGORIES,
} from "../services/awardApplications.js";
import { CONTENT_KEYS } from "../services/adminHelpers.js";

/* Catalyst Awards applications in the apps (Oct 21 2026): the number of categories that received eligible
   applications (not 28), and the list of nominees with their basics and who applied, never their category or
   anything private. Fictional nominations, example.com addresses. */

const PRIVATE = {
  nomineeEmail: "nia.nominee@example.com", nomineePhone: "+1 416 555 0100", nomineeLinkedIn: "https://www.linkedin.com/in/nia-example",
  nominatorEmail: "pat.nominator@example.com", nominatorPhone: "+1 416 555 0199", nominatorTitle: "CEO", nominatorOrganisation: "Nominator Org",
  nominatorRelationship: "Colleague", statementOverview: "Secret overview", statementImpact: "Secret impact", statementAchievements: "Secret wins",
  statementEvidence: "Secret evidence", declaration1: true, declaration2: true, declaration3: true, declaration4: true, signatureName: "Signed P. N.",
  adminNotes: "Strong candidate", updatedBy: "Mia Manager", nomineeSector: "Healthcare", source: "website", resendId: "re_123",
  juryScore: 9, jurors: ["j1"],
};
let n = 0;
const nom = (extra = {}) => ({
  _id: `n${++n}`, categoryType: "matrix", pillar: "AI & Machine Learning", sector: "Healthcare", specialAward: "",
  nomineeType: "Organisation", nomineeName: "Northwind Health", nomineeTitle: "", nomineeOrganisation: "Northwind Health",
  nomineeLocation: "Toronto, ON", nomineeWebsite: "https://northwind.example", nominatorName: "  Pat Nominator ", selfNomination: false,
  status: "pending", submittedAt: new Date("2026-09-01T12:00:00Z"), ...PRIVATE, ...extra,
});

test("eligible: everything but rejected", () => {
  assert.equal(isEligible(nom()), true);
  for (const s of ["pending", "shortlisted", "winner"]) assert.equal(isEligible(nom({ status: s })), true, s);
  assert.equal(isEligible(nom({ status: "rejected" })), false);
  assert.equal(isEligible(nom({ status: undefined })), true);
});

test("categoriesCount: distinct pillar × sector pairs and special awards among eligible ones, never over 28", () => {
  const list = [
    nom(), nom({ pillar: " ai & machine learning ", sector: "HEALTHCARE" }),                  // the same pair
    nom({ sector: "Energy" }),
    nom({ categoryType: "special", specialAward: "rising", pillar: "", sector: "" }),
    nom({ categoryType: "special", specialAward: "rising", pillar: "", sector: "" }),        // the same award
    nom({ categoryType: "special", specialAward: "lifetime", status: "rejected" }),           // rejected: doesn't count
    nom({ pillar: "Quantum", sector: "Finance", status: "rejected" }),
    nom({ pillar: "", sector: "" }),                                                          // no readable category
    nom({ categoryType: "special", specialAward: "" }),
  ];
  assert.equal(categoriesCount(list), 3);
  assert.equal(categoryKey(nom({ categoryType: "special", specialAward: "crossborder" })), "s:crossborder");
  assert.equal(categoryKey(nom({ pillar: "", sector: "Energy" })), "");
  const many = Array.from({ length: 40 }, (_, i) => nom({ pillar: `P${i}`, sector: "S" }));
  assert.equal(categoriesCount(many), MAX_CATEGORIES);
  assert.equal(categoriesCount([]), 0);
});

test("items: only the nominee's public basics; not who applied, nothing private, no category, no status", () => {
  const item = applicationItem(nom());
  assert.deepEqual(Object.keys(item), [...ITEM_FIELDS]);
  assert.deepEqual(item, {
    id: item.id, nomineeName: "Northwind Health", nomineeType: "Organisation", nomineeTitle: "", nomineeOrganisation: "Northwind Health",
    nomineeLocation: "Toronto, ON", nomineeWebsite: "https://northwind.example/", submittedAt: "2026-09-01T12:00:00.000Z",
  });
  // Oct 22 2026: who nominated them stays private too.
  for (const k of ["applicantName", "selfNominated"]) assert.equal(k in item, false, k);
  assert.equal(JSON.stringify(applicationsPayload([nom()])).includes("Pat Nominator"), false);
  const text = JSON.stringify(applicationsPayload([nom(), nom({ categoryType: "special", specialAward: "rising" })]));
  for (const [k, v] of Object.entries(PRIVATE)) {
    if (typeof v === "string") assert.equal(text.includes(v), false, `${k} leaked`);
    assert.equal(text.includes(`"${k}"`), false, `${k} key leaked`);
  }
  for (const k of ["category", "categoryType", "pillar", "sector", "specialAward", "status", "AI & Machine Learning", "Healthcare", "rising"]) {
    assert.equal(text.includes(k), false, `${k} leaked`);
  }
  // The database read never asks for the private fields either.
  for (const k of ["Email", "Phone", "LinkedIn", "statement", "declaration", "adminNotes", "nominatorName", "selfNomination", "nominatorTitle", "nominatorOrganisation", "nominatorRelationship", "signature"]) {
    assert.equal(NOMINATION_SELECT.includes(k), false, k);
  }
});

test("items: nominee types, sorted by nominee name (self-nominated or not, it doesn't show)", () => {
  const p = applicationsPayload([
    nom({ nomineeName: "zed robotics", nomineeType: "Team / Project" }), nom({ nomineeName: "Ada Lovelace", nomineeType: "Individual", selfNomination: true, nominatorName: "Ada Lovelace" }),
    nom({ nomineeName: "Bea Example", nomineeType: "Something else" }), nom({ nomineeName: "Gone Co", status: "rejected" }), nom({ nomineeName: "  " }),
  ]);
  assert.deepEqual(p.items.map((i) => i.nomineeName), ["Ada Lovelace", "Bea Example", "zed robotics"]);
  assert.deepEqual(p.items.map((i) => i.nomineeType), ["Individual", "Individual", "Team / Project"]);
  assert.deepEqual([p.items[0].selfNominated, p.items[0].applicantName], [undefined, undefined]);
  assert.equal(p.total, 3);
  assert.equal(p.enabled, true);
});

test("links only when http(s)", () => {
  assert.equal(safeWebsite("https://acme.example/about"), "https://acme.example/about");
  assert.equal(safeWebsite("http://acme.example"), "http://acme.example/");
  assert.equal(safeWebsite("www.acme.example"), "https://www.acme.example/");
  assert.equal(safeWebsite("acme.example/team"), "https://acme.example/team");
  for (const bad of ["javascript:alert(1)", "mailto:pat@example.com", "ftp://acme.example", "data:text/html,hi", "acme", "", "https://user:pw@acme.example",
    "https://localhost/", "acme.example:8080", "two words.com"]) {
    assert.equal(safeWebsite(bad), "", bad);
  }
});

test("kill switch: off → no items, total 0, the category count still worked out; the setting is on by default", () => {
  const list = [nom(), nom({ sector: "Energy" })];
  assert.deepEqual(applicationsPayload(list, { enabled: false }), { enabled: false, total: 0, categoriesCount: 2, items: [] });
  assert.deepEqual(summaryPayload(list), { enabled: true, categoriesCount: 2, applicationsCount: 2 });
  assert.deepEqual(summaryPayload(list, { enabled: false }), { enabled: false, categoriesCount: 2, applicationsCount: 0 });
  assert.equal(APPLICATIONS_KEY, "site.award_applications");
  assert.equal(CONTENT_KEYS[APPLICATIONS_KEY], true);
});
