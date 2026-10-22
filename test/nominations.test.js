import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryLabel, categoryShort, cleanNominationPatch, nominationFromForm, nominationsCsv, parseNominationEmail, isNominationEmail,
  PILLARS, SECTORS, CATEGORY_OPTIONS, changedParts, cleanCategoryChange, cleanFocusChange, cleanRestoreWhat, focusLabel, nominationDetail,
  nominationRow, snapshotOf, submittedOf,
} from "../services/nominations.js";

// The admin email exactly as routes/nominations.js builds it (trimmed to what the parser reads).
const EMAIL_HTML = `
<div><div><p>New Nomination Received</p><h1>The Catalyst Awards</h1></div>
<div>
  <h2 style="margin: 0 0 6px;">The Catalyst Award for AI &amp; Machine Learning in Healthcare &amp; Life Sciences</h2>
  <div><p style="x">Nominee</p>
    <h3 style="x">Dr. Jane Roe</h3>
    <table style="x">
      <tr><td style="padding: 3px 0; width: 130px; color: #888;">Title</td><td>Chief Scientist</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>Roe Labs</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Type</td><td>Individual</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Location</td><td>Toronto, ON</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:jane@roe.ca" style="color: #7a3fd1;">Jane@Roe.ca</a></td></tr>
    </table>
  </div>
  <div><p style="x">Nominator (Self-nomination)</p>
    <h3 style="x">Dr. Jane Roe</h3>
    <table style="x">
      <tr><td style="padding: 3px 0; color: #888;">Organisation</td><td>Roe Labs</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Relationship</td><td>Self</td></tr>
      <tr><td style="padding: 3px 0; color: #888;">Email</td><td><a href="mailto:jane@roe.ca">jane@roe.ca</a></td></tr>
    </table>
  </div>
  <div><p>Nomination Statement</p>
    <p style="x">Overview</p>
    <p style="x">Line one<br>Line two &lt;3</p>
    <p style="x">Innovation &amp; Impact</p>
    <p style="x">Big impact.</p>
    <p style="x">Key Achievements</p>
    <p style="x">Many.</p>
  </div>
  <p style="x">Signed by <strong>Jane Roe</strong></p>
</div></div>`;

test("parseNominationEmail: reads a staff email back into a nomination", () => {
  const n = parseNominationEmail({ id: "re_1", html: EMAIL_HTML, created_at: "2026-09-02T14:00:00Z" });
  assert.equal(n.categoryType, "matrix");
  assert.equal(n.pillar, "AI & Machine Learning");
  assert.equal(n.sector, "Healthcare & Life Sciences");
  assert.deepEqual([n.nomineeName, n.nomineeTitle, n.nomineeOrganisation, n.nomineeLocation, n.nomineeEmail], ["Dr. Jane Roe", "Chief Scientist", "Roe Labs", "Toronto, ON", "jane@roe.ca"]);
  assert.equal(n.selfNomination, true);
  assert.equal(n.nominatorRelationship, "Self");
  assert.equal(n.statementOverview, "Line one\nLine two <3");
  assert.equal(n.statementImpact, "Big impact.");
  assert.equal(n.statementEvidence, "");
  assert.equal(n.signatureName, "Jane Roe");
  assert.equal(n.source, "email");
  assert.equal(n.resendId, "re_1");
  assert.equal(n.submittedAt.toISOString(), "2026-09-02T14:00:00.000Z");
});

test("parseNominationEmail: special awards, and non-nomination emails", () => {
  const special = EMAIL_HTML.replace(/<h2[^>]*>[\s\S]*?<\/h2>/, "<h2>Rising Innovator Award</h2>");
  const n = parseNominationEmail({ id: "re_2", html: special });
  assert.equal(n.categoryType, "special");
  assert.equal(n.specialAward, "rising");
  assert.equal(categoryShort(n), "Rising Innovator");
  assert.equal(parseNominationEmail({ html: "<p>hello</p>" }), null);
  assert.equal(isNominationEmail({ subject: "[Catalyst Nomination] Jane — AI" }), true);
  assert.equal(isNominationEmail({ subject: "Your nomination for Jane has been received" }), false);
});

test("nominationFromForm: trims, caps and keeps the category", () => {
  const n = nominationFromForm({ categoryType: "matrix", pillar: " Quantum ", sector: "Energy", nomineeName: "  A  B ", nomineeEmail: "A@B.CA", declaration1: true, specialAward: "bogus" });
  assert.equal(n.pillar, "Quantum");
  assert.equal(n.nomineeName, "A B");
  assert.equal(n.nomineeEmail, "a@b.ca");
  assert.equal(n.specialAward, "");
  assert.equal(n.declaration1, true);
  assert.equal(categoryLabel(n), "The Catalyst Award for Quantum in Energy");
});

test("cleanNominationPatch and CSV", () => {
  assert.equal(cleanNominationPatch({ status: "winner" }).set.status, "winner");
  assert.equal(cleanNominationPatch({ status: "nope" }).ok, false);
  const csv = nominationsCsv([{ nomineeName: "=cmd", statementOverview: 'He said "hi"', categoryType: "special", specialAward: "lifetime" }]);
  assert.match(csv, /"'=cmd"/);
  assert.match(csv, /"He said ""hi"""/);
  assert.match(csv, /Lifetime Achievement Award/);
});

/* ---------- staff changes to the category and the nominee's focus (Oct 22 2026) ---------- */

test("the canonical lists: the website form's 5 pillars × 5 sectors and the 3 special awards", () => {
  assert.deepEqual(PILLARS, ["AI & Machine Learning", "Quantum Computing", "Cybersecurity & Digital Trust", "Robotics & Automation", "CleanTech & Sustainability"]);
  assert.deepEqual(SECTORS, ["Financial Services & Banking", "Healthcare & Life Sciences", "Energy & Critical Infrastructure",
    "Manufacturing, Supply Chain & Mobility", "Public Sector, Defence & Security"]);
  assert.deepEqual(CATEGORY_OPTIONS.specialAwards, [
    { key: "lifetime", label: "Lifetime Achievement Award" }, { key: "rising", label: "Rising Innovator Award" },
    { key: "crossborder", label: "Cross-Border Impact Award" },
  ]);
  assert.ok(Object.isFrozen(PILLARS) && Object.isFrozen(SECTORS));
});

test("cleanCategoryChange: list names only (case and spaces forgiven), the other kind's fields cleared", () => {
  assert.deepEqual(cleanCategoryChange({ categoryType: "matrix", pillar: "quantum  computing", sector: "Energy & Critical Infrastructure", note: " Moved\n after review " }),
    { ok: true, set: { categoryType: "matrix", pillar: "Quantum Computing", sector: "Energy & Critical Infrastructure", specialAward: "" }, note: "Moved after review" });
  assert.deepEqual(cleanCategoryChange({ categoryType: "special", specialAward: "rising", pillar: "Quantum Computing" }).set,
    { categoryType: "special", pillar: "", sector: "", specialAward: "rising" });
  for (const bad of [
    {}, { categoryType: "Matrix", pillar: "Quantum Computing", sector: "Healthcare & Life Sciences" },
    { categoryType: "matrix", pillar: "Quantum", sector: "Healthcare & Life Sciences" },
    { categoryType: "matrix", pillar: "Quantum Computing", sector: "Healthcare" },
    { categoryType: "matrix", pillar: { $ne: "" }, sector: "Healthcare & Life Sciences" },
    { categoryType: "special", specialAward: "toString" }, { categoryType: "special", specialAward: "" },
  ]) assert.equal(cleanCategoryChange(bad).ok, false, JSON.stringify(bad));
  assert.equal(cleanCategoryChange({ categoryType: "special", specialAward: "lifetime", note: "x".repeat(900) }).note.length, 500);
});

test("cleanFocusChange: pillar and sector from the lists or none; the typed sector can stay as it is", () => {
  const cur = { nomineeSector: "FinTech", nomineePillar: "" };
  assert.deepEqual(cleanFocusChange({ nomineePillar: "ai & machine learning" }, cur).set, { nomineeSector: "FinTech", nomineePillar: "AI & Machine Learning" });
  assert.deepEqual(cleanFocusChange({ nomineeSector: "FinTech", nomineePillar: "" }, cur).set, { nomineeSector: "FinTech", nomineePillar: "" });
  assert.deepEqual(cleanFocusChange({ nomineeSector: "Financial Services & Banking" }, cur).set, { nomineeSector: "Financial Services & Banking", nomineePillar: "" });
  assert.deepEqual(cleanFocusChange({ nomineeSector: null }, cur).set, { nomineeSector: "", nomineePillar: "" });
  assert.equal(cleanFocusChange({ nomineeSector: "Retail" }, cur).ok, false);
  assert.equal(cleanFocusChange({ nomineeSector: "fintech" }, cur).ok, false); // only exactly as stored
  assert.equal(cleanFocusChange({ nomineePillar: "Blockchain" }, cur).ok, false);
  assert.equal(cleanFocusChange({}, cur).ok, false);
  assert.equal(cleanFocusChange({ note: "only a note" }, cur).ok, false);
  assert.equal(cleanRestoreWhat("both"), "both");
  assert.equal(cleanRestoreWhat("all"), null);
});

test("focus, the snapshot and what changed; the admin row and detail carry them", () => {
  assert.equal(focusLabel({ nomineePillar: "Quantum Computing", nomineeSector: "FinTech" }), "Quantum Computing · FinTech");
  assert.equal(focusLabel({ nomineeSector: " Health " }), "Health");
  assert.equal(focusLabel({}), "");
  const n = { _id: "n1", categoryType: "special", specialAward: "rising", pillar: "", sector: "", nomineeSector: "Health", nomineePillar: "",
    nomineeName: "Riley Example", categoryChangedBy: "Mia Example", categoryChangedAt: new Date("2026-10-22T14:00:00Z"), categoryNote: "Better fit",
    submitted: { categoryType: "matrix", pillar: "AI & Machine Learning", sector: "Healthcare & Life Sciences", specialAward: "", nomineeSector: "Health", nomineePillar: "" } };
  assert.deepEqual(snapshotOf({ categoryType: "matrix", pillar: "P" }), { categoryType: "matrix", pillar: "P", sector: "", specialAward: "", nomineeSector: "", nomineePillar: "" });
  assert.equal(submittedOf({}), null);
  assert.deepEqual(changedParts(n), { category: true, focus: false });
  assert.deepEqual(changedParts({ ...n, submitted: undefined }), { category: false, focus: false });
  const row = nominationRow(n);
  assert.deepEqual([row.category, row.focus, row.categoryChanged, row.focusChanged], ["Rising Innovator", "Health", true, false]);
  const d = nominationDetail(n, { jury: { assigned: 2, scored: 1 } });
  assert.equal(d.submitted.category, "AI & Machine Learning × Healthcare & Life Sciences");
  assert.equal(d.submitted.categoryLabel, "The Catalyst Award for AI & Machine Learning in Healthcare & Life Sciences");
  assert.equal(d.submitted.focus, "Health");
  assert.deepEqual([d.categoryChangedBy, d.categoryNote, d.focusChangedBy, d.focusChangedAt], ["Mia Example", "Better fit", "", null]);
  assert.deepEqual(d.jury, { assigned: 2, scored: 1 });
  assert.equal(nominationDetail({ _id: "n2", categoryType: "matrix" }).submitted, null);

  const csv = nominationsCsv([n]).split("\r\n");
  assert.deepEqual(csv[0].split(",").slice(2, 6), ["Category", "Submitted category", "Focus", "Submitted focus"]);
  assert.ok(csv[1].includes(",Rising Innovator Award,The Catalyst Award for AI & Machine Learning in Healthcare & Life Sciences,Health,Health,"), csv[1]);
});
