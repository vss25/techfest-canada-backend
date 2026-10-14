import test from "node:test";
import assert from "node:assert/strict";
import {
  categoryLabel, categoryShort, cleanNominationPatch, nominationFromForm, nominationsCsv, parseNominationEmail, isNominationEmail,
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
