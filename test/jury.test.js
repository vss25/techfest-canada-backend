/* Catalyst Awards jury: the pure rules (services/jury.js), sign-in helpers (services/juryAuth.js), the email
   wording and builders (services/juryEmailCopy.js, services/juryEmail.js). No database, no network.
   Fictional nominees and jurors only (example.com). */
import { test } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";

process.env.JWT_SECRET ||= "local-test-only";

const J = await import("../services/jury.js");
const A = await import("../services/juryAuth.js");
const Copy = await import("../services/juryEmailCopy.js");
const Mail = await import("../services/juryEmail.js");
const { hashCode } = await import("../services/emailLink.js");
const { allowedWhileOff } = await import("../services/killSwitch.js");

const crit = J.DEFAULT_CRITERIA;

test("the default rubric: five criteria, equal weights, an anchor for 1, 3 and 5, the agreed names", () => {
  assert.deepEqual(crit.map((c) => c.label), ["Innovation", "Impact", "Traction & evidence", "Team & execution", "Fit for the category"]);
  assert.deepEqual(crit.map((c) => c.key), ["innovation", "impact", "traction", "team", "fit"]);
  for (const c of crit) {
    assert.equal(c.weight, 1);
    for (const p of ["1", "3", "5"]) assert.ok(c.anchors[p].length > 5 && c.anchors[p].length <= J.ANCHOR_MAX, `${c.key} ${p}`);
    assert.ok(c.help.length > 5 && c.help.length <= J.HELP_MAX);
  }
  assert.deepEqual(J.RECOMMENDATIONS.map((r) => r.label), ["Strong yes", "Yes", "Maybe", "No"]);
  assert.equal(J.COMMENT_MAX, 500);
  assert.equal(J.MAX_CRITERIA, 6);
  const r = J.plainRubric(null);
  assert.equal(r.version, 1);
  assert.equal(r.builtIn, true);
  assert.deepEqual(Object.values(J.weightShares(r.criteria)), [20, 20, 20, 20, 20]);
});

test("cleanRubric: keys stay with their criterion, new ones never reuse an old key, limits", () => {
  const used = crit.map((c) => c.key).concat(["scalability"]);
  const ok = J.cleanRubric({ criteria: [
    { key: "innovation", label: "  Novelty ", weight: 2, anchors: { 1: "a", 3: "b", 5: "c" } },
    { key: "impact", label: "Impact", weight: 1 },
    { label: "Scalability", weight: 1.25 },
    { key: "made-up", label: "Ethics", weight: 1 },
  ] }, { usedKeys: used });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.criteria.map((c) => c.key), ["innovation", "impact", "scalability-2", "ethics"]);
  assert.equal(ok.criteria[0].label, "Novelty");
  assert.equal(ok.criteria[2].weight, 1.3);
  assert.deepEqual(ok.criteria[1].anchors, { 1: "", 3: "", 5: "" });

  assert.equal(J.cleanRubric({ criteria: [] }).ok, false);
  assert.match(J.cleanRubric({ criteria: Array.from({ length: 7 }, (_, i) => ({ label: `C${i}` })) }).error, /at most 6/);
  assert.match(J.cleanRubric({ criteria: [{ label: "" }] }).error, /needs a name/);
  assert.match(J.cleanRubric({ criteria: [{ label: "A", weight: 0 }] }).error, /weight/);
  assert.match(J.cleanRubric({ criteria: [{ label: "A", weight: 11 }] }).error, /weight/);
  assert.match(J.cleanRubric({ criteria: [{ label: "Same" }, { label: "same" }] }).error, /same name/);
  // The same key twice: the second is a new criterion.
  const twice = J.cleanRubric({ criteria: [{ key: "impact", label: "Impact" }, { key: "impact", label: "Impact 2" }] }, { usedKeys: used });
  assert.deepEqual(twice.criteria.map((c) => c.key), ["impact", "impact-2"]);
  assert.equal(J.sameCriteria(crit, crit.map((c) => ({ ...c }))), true);
  assert.equal(J.sameCriteria(crit, [...crit].reverse()), false);
});

test("weighted total: 0–100 (1 = 0, 3 = 50, 5 = 100), weights, only the criteria scored, removed criteria ignored", () => {
  const all = (v) => Object.fromEntries(crit.map((c) => [c.key, v]));
  assert.equal(J.weightedTotal(all(1), crit), 0);
  assert.equal(J.weightedTotal(all(3), crit), 50);
  assert.equal(J.weightedTotal(all(5), crit), 100);
  assert.equal(J.weightedTotal({ innovation: 5, impact: 1, traction: 3, team: 4, fit: 2 }, crit), 50);
  assert.equal(J.weightedTotal({}, crit), null);
  assert.equal(J.weightedTotal({ innovation: 5 }, crit), 100); // one scored so far: the live total so far
  const weighted = [{ key: "a", weight: 3 }, { key: "b", weight: 1 }];
  assert.equal(J.weightedTotal({ a: 5, b: 1 }, weighted), 75);
  assert.equal(J.weightedTotal({ a: 5, b: 1, gone: 1 }, weighted), 75);
  assert.equal(J.weightedTotal({ a: 6, b: 0 }, weighted), null);
  assert.equal(J.weightedTotal(new Map([["a", 4], ["b", 4]]), weighted), 75);
});

test("cleanScores / recommendation / comment: only the rubric's keys, whole numbers 1–5, 500 characters", () => {
  assert.deepEqual(J.cleanScores({ innovation: 5, impact: "3", traction: 3.5, team: 0, fit: 9, extra: 4 }, crit), { innovation: 5, impact: 3 });
  assert.deepEqual(J.cleanScores(null, crit), {});
  assert.equal(J.cleanRecommendation("strong_yes"), "strong_yes");
  assert.equal(J.cleanRecommendation("definitely"), "");
  assert.equal(J.cleanComment("x".repeat(900)).length, 500);
  assert.equal(J.cleanComment(" a \r\n\r\n\r\n b "), "a\n\nb");
  assert.deepEqual(J.missingCriteria({ innovation: 4 }, crit), ["impact", "traction", "team", "fit"]);
});

test("states: not started → draft → submitted → editing; a conflict wins; cleared conflicts don't count", () => {
  const at = new Date("2026-10-21T12:00:00Z");
  assert.equal(J.assessmentState(null), "not_started");
  assert.equal(J.assessmentState({}), "not_started");
  assert.equal(J.assessmentState({ draft: { scores: {}, savedAt: at } }), "not_started");
  assert.equal(J.assessmentState({ draft: { scores: { innovation: 3 }, savedAt: at } }), "draft");
  assert.equal(J.assessmentState({ draft: { comment: "Strong team" } }), "draft");
  assert.equal(J.assessmentState({ submission: { submittedAt: at } }), "submitted");
  assert.equal(J.assessmentState({ submission: { submittedAt: at }, editing: true }), "editing");
  assert.equal(J.assessmentState({ submission: { submittedAt: at }, conflict: { at } }), "conflict");
  assert.equal(J.assessmentState({ submission: { submittedAt: at }, conflict: { at, clearedAt: at } }), "submitted");
  const p = J.progressOf(["submitted", "editing", "draft", "not_started", "conflict", "submitted"]);
  assert.deepEqual(p, { assigned: 5, submitted: 3, editing: 1, drafts: 1, notStarted: 1, conflicts: 1, remaining: 2 });
});

test("what a juror sees: no emails, phones or nominator name; 'Self-nominated' / 'Nominated by {organisation}'", () => {
  const n = {
    _id: "64b000000000000000000001", categoryType: "matrix", pillar: "Artificial Intelligence", sector: "Healthcare & Life Sciences",
    nomineeType: "Organisation", nomineeName: "Example Health AI", nomineeTitle: "", nomineeOrganisation: "Example Health AI Inc.",
    nomineeLocation: "Toronto, ON", nomineeWebsite: "examplehealth.example.com", nomineeLinkedIn: "javascript:alert(1)",
    nomineeEmail: "founder@examplehealth.example.com", nomineePhone: "+1 416 555 0199",
    selfNomination: false, nominatorName: "Pat Nominator", nominatorTitle: "CEO", nominatorOrganisation: "Example Ventures",
    nominatorEmail: "pat@example.com", nominatorPhone: "416-555-0100", nominatorRelationship: "Investor", signatureName: "Pat Nominator",
    statementOverview: "We triage scans.\n\nContact founder@examplehealth.example.com or call +1 (416) 555-0199.",
    statementImpact: "Cut wait times by 40% across 12 hospitals; raised $2,500,000 in 2025.",
    statementAchievements: "", statementEvidence: "https://evidence.example.com/report",
    adminNotes: "Staff only", status: "shortlisted",
  };
  const v = J.nomineeForJury(n);
  const text = JSON.stringify(v);
  for (const secret of ["founder@", "pat@example.com", "555 0199", "555-0100", "Pat Nominator", "Investor", "Staff only", "shortlisted", "CEO"]) {
    assert.ok(!text.includes(secret), secret);
  }
  assert.equal(v.nominatedBy, "Nominated by Example Ventures");
  assert.equal(J.nominatedByLine({ selfNomination: true, nominatorOrganisation: "X" }), "Self-nominated");
  assert.equal(J.nominatedByLine({}), "Nominated by a third party");
  assert.equal(v.website, "https://examplehealth.example.com/");
  assert.equal(v.linkedin, "");
  assert.deepEqual(v.statements.map((s) => s.title), ["Overview", "Innovation & impact", "Supporting evidence"]);
  assert.match(v.statements[0].text, /^We triage scans\.\n\nContact \[email removed\] or call \[phone removed\]\.$/);
  assert.match(v.statements[1].text, /\$2,500,000/); // money and percentages are left alone
  assert.equal(v.category, "Artificial Intelligence × Healthcare & Life Sciences");
  assert.equal(v.categoryKey, "matrix:Artificial Intelligence|Healthcare & Life Sciences");
  const sp = J.nomineeForJury({ categoryType: "special", specialAward: "rising", nomineeName: "Sam Example" });
  assert.equal(sp.specialAward, "Rising Innovator Award");
  assert.equal(sp.category, "Rising Innovator");
  assert.equal(J.visibleToJury({ status: "rejected" }), false);
  assert.equal(J.visibleToJury({ status: "pending" }), true);
  assert.equal(J.visibleToJury(null), false);
  for (const bad of ["mailto:a@b.co", "tel:+14165550100", "jane@example.com", "not a link", "ftp://x.example.com"]) assert.equal(J.safeLink(bad), "", bad);
  assert.equal(J.safeLink("https://www.linkedin.com/in/example"), "https://www.linkedin.com/in/example");
});

test("balanced allocation: each nomination gets N jurors, least-loaded first, never a juror who declared a conflict", () => {
  const noms = ["n1", "n2", "n3", "n4", "n5", "n6"];
  const jurors = ["ja", "jb", "jc"];
  const plan = J.planBalanced({ nominationIds: noms, jurorIds: jurors, perNomination: 2 });
  assert.equal(plan.add.length, 12);
  assert.deepEqual(plan.short, []);
  const load = Object.fromEntries(jurors.map((j) => [j, plan.add.filter((p) => p.juror === j).length]));
  assert.deepEqual(Object.values(load).sort(), [4, 4, 4]);
  for (const n of noms) assert.equal(new Set(plan.add.filter((p) => p.nomination === n).map((p) => p.juror)).size, 2);

  // n1 has ja already, jb declared a conflict on n2; jc is busy elsewhere.
  const plan2 = J.planBalanced({
    nominationIds: ["n1", "n2"], jurorIds: jurors, perNomination: 2,
    existing: [{ juror: "ja", nomination: "n1", active: true }, { juror: "jb", nomination: "n2", active: true, conflict: true }],
    load: { ja: 1, jb: 0, jc: 5 },
  });
  assert.ok(!plan2.add.some((p) => p.nomination === "n1" && p.juror === "ja"));
  assert.ok(!plan2.add.some((p) => p.nomination === "n2" && p.juror === "jb"));
  assert.equal(plan2.add.filter((p) => p.nomination === "n1").length, 1);
  assert.equal(plan2.add.filter((p) => p.nomination === "n2").length, 2);
  // Not enough jurors: reported as short.
  const plan3 = J.planBalanced({ nominationIds: ["n1"], jurorIds: ["ja"], perNomination: 3 });
  assert.deepEqual(plan3.short, [{ nomination: "n1", have: 1, need: 3 }]);
  // An unassigned (inactive) earlier pair can be given back.
  const plan4 = J.planBalanced({ nominationIds: ["n1"], jurorIds: ["ja"], perNomination: 1, existing: [{ juror: "ja", nomination: "n1", active: false }] });
  assert.deepEqual(plan4.add, [{ juror: "ja", nomination: "n1" }]);
});

test("results maths: averages per criterion, mean of jurors' totals, the tally, drafts and conflicts left out, ranks", () => {
  const at = new Date();
  const sub = (scores, recommendation = "") => ({ scores, recommendation, comment: "", submittedAt: at, rubricVersion: 1 });
  const items = [
    { state: "submitted", submission: sub({ innovation: 5, impact: 5, traction: 5, team: 5, fit: 5 }, "strong_yes") },
    { state: "editing", submission: sub({ innovation: 3, impact: 3, traction: 3, team: 3, fit: 3 }, "maybe") },
    { state: "draft", submission: null },
    { state: "conflict", submission: sub({ innovation: 1, impact: 1, traction: 1, team: 1, fit: 1 }, "no") },
  ];
  const r = J.nominationResult(items, crit);
  assert.equal(r.assigned, 3);
  assert.equal(r.submitted, 2);
  assert.equal(r.conflicts, 1);
  assert.equal(r.drafts, 1);
  assert.equal(r.editing, 1);
  assert.deepEqual(r.perCriterion.innovation, { avg: 4, n: 2 });
  assert.equal(r.total, 75);
  assert.equal(r.min, 50);
  assert.equal(r.max, 100);
  assert.deepEqual(r.tally, { strong_yes: 1, yes: 0, maybe: 1, no: 0, none: 0 });
  assert.equal(r.olderRubric, 0);
  // A criterion added later: older assessments have no score for it; it's reported, totals use what's there.
  const withNew = [...crit, { key: "ethics", label: "Ethics", weight: 1 }];
  const r2 = J.nominationResult(items, withNew);
  assert.deepEqual(r2.perCriterion.ethics, { avg: null, n: 0 });
  assert.equal(r2.total, 75);
  assert.equal(r2.olderRubric, 2);

  const rows = [{ total: 80 }, { total: 91.5 }, { total: 80 }, { total: null }, { total: 12 }];
  const ranks = J.rankBy(rows);
  assert.deepEqual(rows.map((x) => ranks.get(x) ?? null), [2, 1, 2, null, 4]);
});

test("settings: the default deadline is Oct 25, 11:59 PM Toronto; rejected never allocatable; the automatic pool", () => {
  const s = J.plainSettings(undefined);
  assert.equal(s.deadline, "2026-10-26T03:59:00.000Z");
  assert.equal(J.formatDeadline(s.deadline), "Sunday, October 25, 11:59 PM ET");
  assert.equal(J.plainSettings({ deadline: null }).deadline, null);
  assert.equal(J.isLocked({ deadline: null }), false);
  assert.equal(J.isLocked({}, Date.parse("2026-10-26T03:58:59Z")), false);
  assert.equal(J.isLocked({}, Date.parse("2026-10-26T04:00:00Z")), true);
  assert.deepEqual(J.poolStatusesFor({}, { shortlisted: 3, pending: 10 }), { statuses: ["shortlisted"], automatic: true });
  assert.deepEqual(J.poolStatusesFor({}, { shortlisted: 0, pending: 10 }), { statuses: ["pending"], automatic: true });
  assert.deepEqual(J.poolStatusesFor({ poolStatuses: ["pending", "shortlisted", "rejected"] }, {}), { statuses: ["pending", "shortlisted"], automatic: false });
  assert.match(J.cleanSettings({ poolStatuses: ["rejected"] }).error, /aren't progressing/);
  assert.equal(J.cleanSettings({ poolStatuses: ["nope"] }).ok, false);
  assert.deepEqual(J.cleanSettings({ deadline: "" }).set, { deadline: null });
  assert.equal(J.cleanSettings({ deadline: "soon" }).ok, false);
  assert.deepEqual(J.cleanSettings({ deadline: "2026-10-25T23:59:00-04:00" }, Date.parse("2026-10-20")).set, { deadline: "2026-10-26T03:59:00.000Z" });
});

test("juror form, CSV guard", () => {
  assert.deepEqual(J.cleanJuror({ name: " Jo  Example ", email: " JO@Example.COM " }).set, { name: "Jo Example", email: "jo@example.com", organisation: "", title: "", active: true });
  assert.equal(J.cleanJuror({ name: "", email: "jo@example.com" }).ok, false);
  assert.equal(J.cleanJuror({ name: "Jo", email: "nope" }).ok, false);
  assert.deepEqual(J.cleanJuror({ active: false }, { partial: true }).set, { active: false });
  assert.equal(J.cleanJuror({ active: "no" }, { partial: true }).ok, false);
  const csv = J.resultsCsv([{ rank: 1, category: "AI × Health", nomineeName: "=HYPERLINK(\"x\")", nomineeOrganisation: "Org, Inc.", status: "shortlisted",
    assigned: 2, submitted: 2, conflicts: 0, total: 75, min: 50, max: 100, perCriterion: { innovation: { avg: 4 } }, tally: { strong_yes: 1, maybe: 1 },
    comments: [{ juror: "Jo Example", comment: "Strong \"evidence\"" }] }], [crit[0]]);
  const [head, row] = csv.split("\r\n");
  assert.match(head, /^Rank in category,Category,Nominee,/);
  assert.match(head, /Innovation \(avg 1-5\)/);
  assert.ok(row.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(row.includes(`"Org, Inc."`));
  assert.ok(row.includes(`"Jo Example: Strong ""evidence"""`));
});

test("jury tokens: their own key and audience; a staff token never opens the portal, a jury token never opens anything else", () => {
  const juror = { _id: "64b0000000000000000000aa", tokenVersion: 3 };
  const t = A.signJuryToken(juror, { via: A.VIA_CODE });
  const d = A.verifyJuryToken(t);
  assert.equal(d.sub, juror._id);
  assert.equal(d.tv, 3);
  assert.equal(d.via, "code");
  assert.equal(d.aud, "ttfc-jury");
  assert.throws(() => jwt.verify(t, process.env.JWT_SECRET)); // every other route's check
  assert.notEqual(A.jurySecret(), process.env.JWT_SECRET);
  assert.equal(A.jurySecret({ JURY_JWT_SECRET: "own" }), "own");
  // A staff / app token (JWT_SECRET, an `id`), even one claiming the jury audience, is refused.
  assert.equal(A.verifyJuryToken(jwt.sign({ id: juror._id }, process.env.JWT_SECRET)), null);
  assert.equal(A.verifyJuryToken(jwt.sign({ typ: "jury", tv: 3 }, process.env.JWT_SECRET, { subject: juror._id, audience: "ttfc-jury", issuer: "ttfc-jury-portal" })), null);
  assert.equal(A.verifyJuryToken(jwt.sign({ typ: "jury", tv: 3 }, A.jurySecret(), { subject: juror._id, audience: "ttfc-app" })), null);
  assert.equal(A.verifyJuryToken(jwt.sign({ typ: "user", tv: 3 }, A.jurySecret(), { subject: juror._id, audience: "ttfc-jury", issuer: "ttfc-jury-portal" })), null);
  assert.equal(A.verifyJuryToken(jwt.sign({ typ: "jury" }, A.jurySecret(), { subject: juror._id, audience: "ttfc-jury", issuer: "ttfc-jury-portal", expiresIn: -10 })), null);
  assert.equal(A.verifyJuryToken("nonsense"), null);
  // A jury code's hash never equals an app code's.
  assert.notEqual(A.hashJuryCode("jo@example.com", "123456"), hashCode("jo@example.com", "123456"));
  assert.equal(A.passwordProblem("short"), "Use at least 10 characters.");
  assert.equal(A.passwordProblem("jo@example.com", { email: "jo@example.com" }), "Don't use your email address as the password.");
  assert.equal(A.passwordProblem("a long enough passphrase"), "");
  assert.equal(allowedWhileOff("/api/jury/me"), true);
  assert.equal(allowedWhileOff("/api/juryx"), false);
});

test("email wording: placeholders per juror, defaults aren't stored, every field escaped", () => {
  const vars = Copy.varsFor({ name: "Jo Example", email: "jo@example.com" }, { assigned: 12, submitted: 8, remaining: 4 }, "Sunday, October 25, 11:59 PM ET");
  assert.equal(vars.assigned, "12 nominations");
  assert.equal(vars.remaining, "4 nominations");
  assert.equal(Copy.varsFor({}, { assigned: 1, submitted: 0, remaining: 1 }).remaining, "1 nomination");
  assert.equal(Copy.varsFor({}, {}).assigned, "no nominations yet");
  assert.equal(Copy.fill("Hi {firstName}, {remaining} by {deadline}", vars), "Hi Jo, 4 nominations by Sunday, October 25, 11:59 PM ET");
  assert.equal(Copy.fill("Hi {firstName}", {}), "Hi there");
  assert.deepEqual(Copy.wordingToSave("invite", { subject: Copy.DEFAULT_COPY.invite.subject, heading: "Hello jury", unknown: "x" }), { heading: "Hello jury" });
  assert.deepEqual(Copy.changedWording("invite", {}, { heading: "x" }), ["heading"]);

  const e = Mail.buildJuryEmail({ kind: "invite", copy: { heading: "<b>Hi</b>" }, vars });
  assert.equal(e.subject, "You're on the Catalyst Awards jury");
  assert.ok(e.html.includes("&lt;b&gt;Hi&lt;/b&gt;"));
  assert.ok(e.html.includes("https://www.thetechfestival.com/awards/jury-admin"));
  assert.ok(e.text.includes("12 nominations to review"));
  assert.ok(e.text.includes("Please submit your assessments by Sunday, October 25, 11:59 PM ET."));
  assert.ok(e.text.includes("Sign in with jo@example.com."));
  const noDeadline = Mail.buildJuryEmail({ kind: "reminder", vars: Copy.varsFor({ name: "Jo" }, { assigned: 2, submitted: 1, remaining: 1 }, "") });
  assert.equal(noDeadline.subject, "Reminder: 1 nomination left to review");
  assert.ok(!noDeadline.text.includes("closes on"));
  const code = Mail.buildJuryCodeEmail({ code: "042917", name: "Jo Example" });
  assert.ok(code.text.includes("042 917"));
  assert.ok(code.html.includes("042 917"));
  assert.equal(Mail.FROM, "The Tech Festival Canada <enquire@thetechfestival.com>");
});
