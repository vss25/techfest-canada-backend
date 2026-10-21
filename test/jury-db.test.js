/* The Catalyst Awards jury through the real routes, against a real (throwaway) MongoDB: jurors (management adds,
   staff look), allocation (per juror, in bulk, balanced; pending / rejected skipped; unassign and give back),
   signing in (password, emailed code, forgot password) with generic answers and rate limits, the isolation of jury
   tokens from everything else (and of staff / app tokens from the jury API), what a juror sees (no contact details,
   only their own allocations and scores), draft → submit → edit → resubmit with the audit, conflicts of interest,
   the deadline lock, rubric changes that keep earlier scores, the results maths and CSV, removing a juror, and the
   invite / reminder emails (only on a management click, from enquire@).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine: Resend
   and Sanity are answered by a stubbed fetch (nothing is delivered). Fictional nominees and jurors, example.com. */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";

const BIN = process.env.TTFC_TEST_MONGOD || path.join(os.homedir(), ".cache/mongodb-binaries/mongod-arm64-darwin-8.2.6");
const HAVE = fs.existsSync(BIN);
const skip = HAVE ? false : `no local mongod at ${BIN}`;

process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
delete process.env.STRIPE_SECRET_KEY;
delete process.env.JURY_JWT_SECRET;

// Resend: every email is captured here and never delivered.
const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.startsWith("https://api.resend.com/")) {
    sent.push(JSON.parse(opts?.body || "{}"));
    return new Response(JSON.stringify({ id: `re_${sent.length}` }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.includes(".sanity.io/")) return new Response(JSON.stringify({ result: [] }), { status: 200, headers: { "content-type": "application/json" } });
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let jwt;
const M = {};
const U = {};      // staff and app accounts
const N = {};      // nominations
const JR = {};     // jurors: { id, email }
const TOK = {};    // jury tokens
const codes = [];  // sign-in codes "sent" by the test router: { to, code }

const PW_AVA = "correct horse battery";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-jury-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_jury_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Nomination = await imp("../models/Nomination.js");
  M.Juror = await imp("../models/Juror.js");
  M.JuryAssignment = await imp("../models/JuryAssignment.js");
  M.JuryRubric = await imp("../models/JuryRubric.js");
  M.JurySignInRequest = await imp("../models/JurySignInRequest.js");
  Object.assign(M, await import("../models/Admin.js"));
  const { createJuryRouter } = await import("../routes/jury.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  const capture = async ({ to, code }) => { codes.push({ to, code }); };
  app.use("/api/jury", createJuryRouter({ sendCode: capture, limits: { loginPerIp: 1000, loginPerEmail: 1000, codePerIp: 1000, codePerEmail: 1000, verifyPerIp: 1000, passwordPerJuror: 1000 } }));
  app.use("/api/jury-limits", createJuryRouter({ sendCode: capture }));
  app.use("/api/jury-mail", (await import("../routes/jury.js")).default); // the real code email (through the stubbed Resend)
  app.use("/api/auth", (await import("../routes/auth.js")).default);
  app.use("/api/auth", (await import("../routes/emailLink.js")).createEmailLinkRouter({ send: async () => {} }));
  app.use("/api/profile", (await import("../routes/profile.js")).default);
  app.use("/api/console/jury", (await import("../routes/juryAdmin.js")).default);
  app.use("/api/console/nominations", (await import("../routes/nominationsAdmin.js")).default);
  app.use("/api/console/people", (await import("../routes/people.js")).default);
  app.use("/api/console", (await import("../routes/console.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Example", email: "sam.example@example.com", role: "admin", staffRole: "staff" });
  await mk("ana", { name: "Ana Example", email: "ana.example@example.com" });
  // An attendee account with the same email as a juror: a jury code must never sign them in to the app.
  await mk("cyApp", { name: "Cy Juror", email: "cy.juror@example.com" });

  const nom = (k, doc) => M.Nomination.create({
    categoryType: "matrix", nomineeType: "Organisation", nomineeLocation: "Toronto, ON", selfNomination: false,
    nominatorName: "Pat Nominator", nominatorOrganisation: "Example Ventures", nominatorEmail: "pat.nominator@example.com", nominatorPhone: "416-555-0100",
    nomineeEmail: `${k}@nominee.example.com`, nomineePhone: "+1 416 555 0199", adminNotes: "Staff-only note",
    statementOverview: `Overview of ${doc.nomineeName}.\n\nSecond paragraph with https://www.example.com/report.`,
    statementImpact: "Measured impact.", statementAchievements: "Achievements.", ...doc,
  }).then((d) => { N[k] = d; });
  await nom("n1", { pillar: "Artificial Intelligence", sector: "Healthcare & Life Sciences", nomineeName: "Northwind Health AI", nomineeOrganisation: "Northwind Health AI Inc.", status: "shortlisted" });
  await nom("n2", { pillar: "Artificial Intelligence", sector: "Healthcare & Life Sciences", nomineeName: "Bluefin Diagnostics", nomineeOrganisation: "Bluefin Diagnostics", status: "shortlisted" });
  await nom("n3", { pillar: "Quantum Computing", sector: "Energy & Utilities", nomineeName: "Qubit Grid Labs", nomineeOrganisation: "Qubit Grid Labs", status: "shortlisted" });
  await nom("n4", { categoryType: "special", specialAward: "rising", nomineeType: "Individual", nomineeName: "Riley Example", nomineeOrganisation: "Riley Labs", selfNomination: true, status: "shortlisted" });
  await nom("n5", { pillar: "Robotics", sector: "Energy & Utilities", nomineeName: "Pending Example", status: "pending" });
  await nom("n6", { pillar: "Robotics", sector: "Energy & Utilities", nomineeName: "Rejected Example", status: "rejected" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const staffToken = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });

async function call(method, url, { as, token, body } = {}) {
  const auth = token !== undefined ? token : as ? staffToken(as) : "";
  const r = await realFetch(base + url, {
    method,
    headers: { "content-type": "application/json", ...(auth ? { authorization: `Bearer ${auth}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}
const admin = (method, url, body) => call(method, `/api/console/jury${url}`, { as: U.mia, body });
const jury = (who, method, url, body) => call(method, `/api/jury${url}`, { token: TOK[who], body });
const id = (d) => String(d._id);
const allFours = { innovation: 4, impact: 4, traction: 4, team: 4, fit: 4 };
const all = (v) => ({ innovation: v, impact: v, traction: v, team: v, fit: v });
const assignment = (who, n) => M.JuryAssignment.findOne({ juror: JR[who].id, nomination: N[n]._id }).lean();

test("jurors: management adds them (a password optional), staff can look but not change, duplicates refused", { skip }, async () => {
  const a = await admin("POST", "/jurors", { name: "Ava Juror", email: "Ava.Juror@Example.com", organisation: "Example University", title: "Professor", password: PW_AVA });
  assert.equal(a.status, 201, JSON.stringify(a.body));
  assert.equal(a.body.juror.email, "ava.juror@example.com");
  assert.equal(a.body.juror.hasPassword, true);
  JR.ava = { id: a.body.juror.id, email: "ava.juror@example.com" };
  const b = await admin("POST", "/jurors", { name: "Ben Juror", email: "ben.juror@example.com" });
  assert.equal(b.status, 201);
  assert.equal(b.body.juror.hasPassword, false);
  JR.ben = { id: b.body.juror.id, email: "ben.juror@example.com" };
  const c = await admin("POST", "/jurors", { name: "Cy Juror", email: "cy.juror@example.com", organisation: "Cy Capital" });
  JR.cy = { id: c.body.juror.id, email: "cy.juror@example.com" };

  assert.equal((await admin("POST", "/jurors", { name: "Ava Again", email: "ava.juror@example.com" })).status, 409);
  assert.equal((await admin("POST", "/jurors", { name: "No Email", email: "nope" })).status, 400);
  assert.match((await admin("POST", "/jurors", { name: "Short Pw", email: "short.pw@example.com", password: "short" })).body.error, /at least 10/);
  assert.equal((await call("POST", "/api/console/jury/jurors", { as: U.sam, body: { name: "Staff Try", email: "staff.try@example.com" } })).status, 403);
  assert.equal((await call("PATCH", `/api/console/jury/jurors/${JR.ben.id}`, { as: U.sam, body: { name: "x" } })).status, 403);
  assert.equal((await call("DELETE", `/api/console/jury/jurors/${JR.ben.id}`, { as: U.sam })).status, 403);

  const o = await call("GET", "/api/console/jury/overview", { as: U.sam });
  assert.equal(o.status, 200);
  assert.equal(o.body.canManage, false);
  assert.deepEqual(o.body.jurors.map((j) => j.name), ["Ava Juror", "Ben Juror", "Cy Juror"]);
  assert.equal(o.body.settings.deadline, "2026-10-26T03:59:00.000Z");
  assert.equal(o.body.settings.deadlineText, "Sunday, October 25, 11:59 PM ET");
  assert.equal(o.body.portalUrl, "https://www.thetechfestival.com/awards/jury-admin");
  assert.ok(!JSON.stringify(o.body).includes("passwordHash"));
  assert.equal((await M.AdminAudit.find({ action: "jury_juror_add" }).lean()).length, 3);
  // An app attendee or a juror's own token can't reach the jury admin.
  assert.equal((await call("GET", "/api/console/jury/overview", { as: U.ana })).status, 403);
});

test("allocation: shortlisted by default, pending and rejected skipped, per juror and balanced, load and coverage", { skip }, async () => {
  const list = await call("GET", "/api/console/jury/nominations", { as: U.sam });
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.pool.statuses, ["shortlisted"]);
  assert.equal(list.body.pool.automatic, true);
  assert.deepEqual(list.body.rows.map((r) => r.nomineeName).sort(), ["Bluefin Diagnostics", "Northwind Health AI", "Qubit Grid Labs", "Riley Example"]);
  assert.ok(!JSON.stringify(list.body).includes("nominee.example.com"));

  const r = await admin("POST", "/assign", { jurorIds: [JR.ava.id, JR.ben.id], nominationIds: [id(N.n1), id(N.n2), id(N.n5), id(N.n6)] });
  assert.equal(r.status, 200);
  assert.equal(r.body.added, 4);
  assert.deepEqual(r.body.skipped.map((s) => s.reason).sort(), ["status", "status"]);
  assert.ok(r.body.skipped.some((s) => /Not progressing/.test(s.label)));
  const again = await admin("POST", "/assign", { jurorIds: [JR.ava.id], nominationIds: [id(N.n1)] });
  assert.equal(again.body.added, 0);
  assert.equal(again.body.skipped[0].reason, "already");
  assert.equal((await call("POST", "/api/console/jury/assign", { as: U.sam, body: { jurorIds: [JR.cy.id], nominationIds: [id(N.n1)] } })).status, 403);

  const dry = await admin("POST", "/assign-balanced", { jurorIds: [JR.ava.id, JR.ben.id, JR.cy.id], nominationIds: [id(N.n3), id(N.n4)], perNomination: 2, dryRun: true });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.add.length, 4);
  assert.equal(dry.body.add.filter((p) => p.jurorId === JR.cy.id).length, 2); // the least-loaded juror gets both
  assert.equal(await M.JuryAssignment.countDocuments({}), 4); // a dry run writes nothing
  const real = await admin("POST", "/assign-balanced", { jurorIds: [JR.ava.id, JR.ben.id, JR.cy.id], nominationIds: [id(N.n3), id(N.n4)], perNomination: 2 });
  assert.equal(real.body.added, 4);
  assert.deepEqual(real.body.short, []);
  const loads = Object.values(real.body.loadAfter).sort();
  assert.deepEqual(loads, [2, 3, 3]);

  const cov = await admin("GET", "/nominations");
  for (const row of cov.body.rows) assert.equal(row.assigned, 2, row.nomineeName);
  assert.equal(cov.body.jurors.reduce((s, j) => s + j.load, 0), 8);

  // The admin can widen what's allocatable; rejected never.
  assert.equal((await admin("PUT", "/settings", { poolStatuses: ["rejected"] })).status, 400);
  const wide = await admin("PUT", "/settings", { poolStatuses: ["pending", "shortlisted"] });
  assert.deepEqual(wide.body.pool.statuses, ["pending", "shortlisted"]);
  assert.ok((await admin("GET", "/nominations")).body.rows.some((x) => x.nomineeName === "Pending Example"));
  await admin("PUT", "/settings", { poolStatuses: [] });
  assert.ok(!(await admin("GET", "/nominations")).body.rows.some((x) => x.nomineeName === "Pending Example"));
});

test("password sign-in: one answer for every failure; the jury token opens only the jury API, staff and app tokens never open it", { skip }, async () => {
  const refused = "That email and password don't match. Try again, or sign in with a code instead.";
  for (const body of [
    { email: JR.ava.email, password: "wrong password!!" },
    { email: "nobody@example.com", password: PW_AVA },
    { email: JR.ben.email, password: PW_AVA }, // a juror without a password
  ]) {
    const r = await call("POST", "/api/jury/auth/login", { body });
    assert.equal(r.status, 401);
    assert.equal(r.body.error, refused);
  }
  assert.equal((await call("POST", "/api/jury/auth/login", { body: { email: JR.ava.email } })).status, 400);
  const ok = await call("POST", "/api/jury/auth/login", { body: { email: "AVA.JUROR@example.com", password: PW_AVA } });
  assert.equal(ok.status, 200);
  TOK.ava = ok.body.token;
  assert.equal(ok.body.juror.name, "Ava Juror");
  const me = await jury("ava", "GET", "/me");
  assert.equal(me.status, 200);
  assert.equal(me.body.progress.assigned, 3);
  assert.equal(me.body.rubric.criteria.length, 5);
  assert.equal(me.body.signedInWith, "password");

  // The juror's token is refused everywhere else.
  for (const url of ["/api/console/jury/overview", "/api/console/jury/results", "/api/console/nominations", `/api/console/nominations/${id(N.n1)}`,
    "/api/console/people", "/api/console/me", "/api/console/users", "/api/auth/me", "/api/profile"]) {
    const r = await call("GET", url, { token: TOK.ava });
    assert.equal(r.status, 401, url);
    assert.ok(!r.text.includes("Northwind"), url);
  }
  // Staff, app and forged tokens are refused by the jury API.
  const forged = jwt.sign({ typ: "jury", tv: 0 }, process.env.JWT_SECRET, { subject: JR.ava.id, audience: "ttfc-jury", issuer: "ttfc-jury-portal" });
  const asId = jwt.sign({ id: JR.ava.id }, process.env.JWT_SECRET);
  for (const token of [staffToken(U.mia), staffToken(U.ana), forged, asId, "", "garbage"]) {
    for (const url of ["/me", "/assignments", `/nominations/${id(N.n1)}`]) {
      const r = await call("GET", `/api/jury${url}`, { token });
      assert.equal(r.status, 401, `${url} ${token.slice(0, 12)}`);
      assert.equal(r.body.code, "jury_signin");
    }
  }
  assert.equal((await call("PUT", `/api/jury/nominations/${id(N.n1)}/draft`, { as: U.mia, body: { scores: allFours } })).status, 401);
});

test("code sign-in: emailed only to active jurors, the same answers for anyone, single use, five tries, separate from the app's codes", { skip }, async () => {
  const refused = "That code isn't right, or it has expired. Check the latest email, or ask for a new code.";
  codes.length = 0;
  assert.deepEqual((await call("POST", "/api/jury/auth/code", { body: { email: "Ben.Juror@example.com" } })).body, { sent: true });
  assert.deepEqual((await call("POST", "/api/jury/auth/code", { body: { email: "nobody@example.com" } })).body, { sent: true });
  await sleep(30);
  assert.equal(codes.length, 1);
  assert.equal(codes[0].to, JR.ben.email);
  const code = codes[0].code;
  assert.match(code, /^\d{6}$/);
  const wrong = code === "000000" ? "111111" : "000000";
  for (const body of [{ email: JR.ben.email, code: wrong }, { email: "nobody@example.com", code }]) {
    const r = await call("POST", "/api/jury/auth/code/verify", { body });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, refused);
  }
  const ok = await call("POST", "/api/jury/auth/code/verify", { body: { email: JR.ben.email, code: `${code.slice(0, 3)} ${code.slice(3)}` } });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  TOK.ben = ok.body.token;
  assert.equal((await jury("ben", "GET", "/me")).body.signedInWith, "code");
  assert.equal((await call("POST", "/api/jury/auth/code/verify", { body: { email: JR.ben.email, code } })).body.error, refused); // used

  // Five wrong tries lock it, even for the right code after.
  codes.length = 0;
  await call("POST", "/api/jury/auth/code", { body: { email: JR.ben.email } });
  await sleep(30);
  const c2 = codes[0].code;
  const bad = c2 === "000000" ? "111111" : "000000";
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/jury/auth/code/verify", { body: { email: JR.ben.email, code: bad } })).status, 400);
  assert.equal((await call("POST", "/api/jury/auth/code/verify", { body: { email: JR.ben.email, code: c2 } })).body.error, refused);
  assert.equal((await M.JurySignInRequest.findOne({ email: JR.ben.email }).sort({ createdAt: -1 }).lean()).status, "locked");

  // A juror switched off gets nothing; a jury code never signs anyone in to the app (same email, different codes).
  await admin("PATCH", `/jurors/${JR.cy.id}`, { active: false });
  codes.length = 0;
  await call("POST", "/api/jury/auth/code", { body: { email: JR.cy.email } });
  await sleep(30);
  assert.equal(codes.length, 0);
  await admin("PATCH", `/jurors/${JR.cy.id}`, { active: true });
  await call("POST", "/api/jury/auth/code", { body: { email: JR.cy.email } });
  await sleep(30);
  const cyCode = codes[0].code;
  const app = await call("POST", "/api/auth/email-link/verify", { body: { email: JR.cy.email, code: cyCode } });
  assert.equal(app.status, 400);
  assert.ok(!app.body.token);
  const cy = await call("POST", "/api/jury/auth/code/verify", { body: { email: JR.cy.email, code: cyCode } });
  assert.equal(cy.status, 200);
  TOK.cy = cy.body.token;
});

test("forgot password: a code session sets one without the old password; other sessions end; a password session needs the current one", { skip }, async () => {
  const old = TOK.ben;
  assert.match((await jury("ben", "POST", "/password", { password: "short" })).body.error, /at least 10/);
  assert.match((await jury("ben", "POST", "/password", { password: "ben.juror@example.com" })).body.error, /email address/);
  const set = await jury("ben", "POST", "/password", { password: "bens new passphrase" });
  assert.equal(set.status, 200);
  assert.equal(set.body.juror.hasPassword, true);
  TOK.ben = set.body.token;
  assert.equal((await call("GET", "/api/jury/me", { token: old })).status, 401);
  assert.equal((await jury("ben", "GET", "/me")).status, 200);
  assert.equal((await call("POST", "/api/jury/auth/login", { body: { email: JR.ben.email, password: "bens new passphrase" } })).status, 200);

  assert.match((await jury("ava", "POST", "/password", { password: "another long passphrase" })).body.error, /current password/);
  const ava = await jury("ava", "POST", "/password", { password: "another long passphrase", currentPassword: PW_AVA });
  assert.equal(ava.status, 200);
  TOK.ava = ava.body.token;
});

test("the juror's list and a nominee: only their own allocations, no contact details, prev / next", { skip }, async () => {
  const list = await jury("ava", "GET", "/assignments");
  assert.equal(list.status, 200);
  const names = list.body.rows.map((r) => r.nomineeName);
  assert.equal(names[0], "Bluefin Diagnostics"); // AI × Healthcare first, by name
  assert.equal(names[1], "Northwind Health AI");
  assert.equal(list.body.rows.length, 3);
  assert.ok(list.body.rows.every((r) => r.state === "not_started" && r.stateLabel === "Not started"));
  assert.equal(list.body.nextId, list.body.rows[0].id);
  assert.equal(list.body.progress.submitted, 0);

  const n = await jury("ava", "GET", `/nominations/${id(N.n1)}`);
  assert.equal(n.status, 200);
  assert.equal(n.body.nominee.nomineeName, "Northwind Health AI");
  assert.equal(n.body.nominee.nominatedBy, "Nominated by Example Ventures");
  assert.equal(n.body.nominee.statements[0].text, "Overview of Northwind Health AI.\n\nSecond paragraph with https://www.example.com/report.");
  assert.equal(n.body.prevId, list.body.rows[0].id);
  assert.equal(n.body.position, 2);
  assert.equal(n.body.count, 3);
  for (const secret of ["nominee.example.com", "pat.nominator", "Pat Nominator", "555", "Staff-only note", "shortlisted", "adminNotes"]) {
    assert.ok(!n.text.includes(secret), secret);
  }
  // Not theirs → 404, whatever the reason.
  const notAva = [N.n3, N.n4].find((x) => !list.body.rows.some((r) => r.id === id(x)));
  for (const nid of [id(notAva), id(N.n5), id(N.n6), "64b000000000000000000999", "nope"]) {
    assert.equal((await jury("ava", "GET", `/nominations/${nid}`)).status, 404, nid);
    assert.equal((await jury("ava", "PUT", `/nominations/${nid}/draft`, { scores: allFours })).status, 404, nid);
  }
});

test("draft → submit → edit → resubmit: autosaved drafts, all criteria needed to submit, every submitted version kept", { skip }, async () => {
  const url = `/nominations/${id(N.n1)}`;
  const d = await jury("ava", "PUT", `${url}/draft`, { scores: { innovation: 4, impact: "x", extra: 5 }, recommendation: "yes", comment: "Promising" });
  assert.equal(d.status, 200);
  assert.equal(d.body.state, "draft");
  assert.equal(d.body.total, 75);
  assert.deepEqual(d.body.missing, ["impact", "traction", "team", "fit"]);
  const g = await jury("ava", "GET", url);
  assert.deepEqual(g.body.assessment.draft.scores, { innovation: 4 });
  assert.equal(g.body.assessment.draft.comment, "Promising");
  assert.equal((await jury("ava", "GET", "/assignments")).body.progress.drafts, 1);

  const inc = await jury("ava", "POST", `${url}/submit`, { scores: { innovation: 4 } });
  assert.equal(inc.status, 400);
  assert.equal(inc.body.code, "incomplete");
  assert.match(inc.body.error, /Still to score: Impact, Traction & evidence, Team & execution, Fit for the category/);

  const s = await jury("ava", "POST", `${url}/submit`, { scores: allFours, recommendation: "yes", comment: "Promising" });
  assert.equal(s.status, 200);
  assert.equal(s.body.state, "submitted");
  assert.equal(s.body.total, 75);
  assert.equal((await jury("ava", "PUT", `${url}/draft`, { scores: all(5) })).body.code, "submitted");
  assert.equal((await jury("ava", "POST", `${url}/submit`, { scores: all(5) })).status, 409);
  assert.equal((await jury("ava", "POST", `${url}/discard`)).status, 409);

  const e = await jury("ava", "POST", `${url}/edit`);
  assert.equal(e.body.state, "editing");
  assert.deepEqual(e.body.draft.scores, allFours);
  assert.equal((await jury("ava", "PUT", `${url}/draft`, { scores: { ...allFours, innovation: 5 }, recommendation: "strong_yes" })).body.state, "editing");
  // While editing, the last submitted one still counts.
  const mid = (await admin("GET", "/results")).body.rows.find((r) => r.id === id(N.n1));
  assert.equal(mid.submitted, 1);
  assert.equal(mid.editing, 1);
  assert.equal(mid.total, 75);
  const again = await jury("ava", "POST", `${url}/submit`, { scores: { ...allFours, innovation: 5 }, recommendation: "strong_yes", comment: "Even better" });
  assert.equal(again.body.resubmitted, true);
  assert.equal(again.body.total, 80);
  const row = await assignment("ava", "n1");
  assert.equal(row.history.length, 1);
  assert.equal(row.history[0].scores.innovation, 4);
  assert.equal(row.history[0].comment, "Promising");
  assert.ok(row.history[0].submittedAt && row.history[0].replacedAt);
  assert.equal(row.submission.rubricVersion, 1);
  assert.equal(row.draft, undefined);

  await jury("ava", "POST", `${url}/edit`);
  const discard = await jury("ava", "POST", `${url}/discard`);
  assert.equal(discard.body.state, "submitted");
  assert.equal((await jury("ava", "GET", url)).body.assessment.submission.scores.innovation, 5);
  assert.equal((await jury("ava", "GET", "/me")).body.progress.submitted, 1);
});

test("conflict of interest: off the juror's list, the admin sees it, allocation skips them, management can clear it", { skip }, async () => {
  const url = `/nominations/${id(N.n2)}`;
  await jury("ava", "PUT", `${url}/draft`, { scores: { innovation: 2 } });
  const c = await jury("ava", "POST", `${url}/conflict`, { reason: "I advise Bluefin" });
  assert.equal(c.body.state, "conflict");
  const list = await jury("ava", "GET", "/assignments");
  assert.ok(!list.body.rows.some((r) => r.id === id(N.n2)));
  assert.deepEqual(list.body.conflicts.map((r) => r.nomineeName), ["Bluefin Diagnostics"]);
  assert.equal(list.body.progress.conflicts, 1);
  assert.equal(list.body.progress.assigned, 2);
  assert.equal((await jury("ava", "GET", url)).status, 404);
  assert.equal((await jury("ava", "POST", `${url}/submit`, { scores: allFours })).status, 404);

  const view = (await admin("GET", "/nominations")).body.rows.find((r) => r.id === id(N.n2));
  assert.equal(view.assigned, 1);
  assert.equal(view.conflicts, 1);
  const avaRow = view.jurors.find((j) => j.id === JR.ava.id);
  assert.equal(avaRow.state, "conflict");
  assert.equal(avaRow.conflictReason, "I advise Bluefin");
  assert.equal((await admin("POST", "/assign", { jurorIds: [JR.ava.id], nominationIds: [id(N.n2)] })).body.skipped[0].reason, "conflict");
  const re = await admin("POST", "/assign-balanced", { jurorIds: [JR.ava.id, JR.ben.id, JR.cy.id], nominationIds: [id(N.n2)], perNomination: 2 });
  assert.deepEqual(re.body.add.map((p) => p.jurorName), ["Cy Juror"]);
  assert.equal((await call("POST", "/api/console/jury/conflicts/clear", { as: U.sam, body: { jurorId: JR.ava.id, nominationId: id(N.n2) } })).status, 403);
  assert.equal((await admin("POST", "/conflicts/clear", { jurorId: JR.ava.id, nominationId: id(N.n2) })).body.cleared, true);
  const back = await jury("ava", "GET", url);
  assert.equal(back.status, 200);
  assert.equal(back.body.assessment.state, "draft"); // the draft was kept
  assert.equal((await admin("POST", "/conflicts/clear", { jurorId: JR.ava.id, nominationId: id(N.n2) })).status, 404);
});

test("deadline: after it nothing can change (423), reading still works; moving it reopens", { skip }, async () => {
  const past = new Date(Date.now() - 3600e3).toISOString();
  assert.equal((await call("PUT", "/api/console/jury/settings", { as: U.sam, body: { deadline: past } })).status, 403);
  const s = await admin("PUT", "/settings", { deadline: past });
  assert.equal(s.body.settings.locked, true);
  const url = `/nominations/${id(N.n1)}`;
  for (const [method, path, body] of [["PUT", `${url}/draft`, { scores: allFours }], ["POST", `${url}/submit`, { scores: allFours }], ["POST", `${url}/edit`],
    ["POST", `/nominations/${id(N.n2)}/conflict`, {}]]) {
    const r = await jury("ava", method, path, body);
    assert.equal(r.status, 423, path);
    assert.equal(r.body.code, "locked");
  }
  const l = await jury("ava", "GET", "/assignments");
  assert.equal(l.status, 200);
  assert.equal(l.body.locked, true);
  assert.equal((await jury("ava", "GET", url)).body.locked, true);
  const future = new Date(Date.now() + 7 * 864e5).toISOString();
  assert.equal((await admin("PUT", "/settings", { deadline: future })).body.settings.locked, false);
  assert.equal((await jury("ava", "GET", "/assignments")).body.locked, false);
});

test("rubric changes keep earlier scores: a new version, keys kept on rename, totals use what's there", { skip }, async () => {
  const r0 = await call("GET", "/api/console/jury/rubric", { as: U.sam });
  assert.equal(r0.body.rubric.version, 1);
  assert.equal(r0.body.rubric.builtIn, true);
  assert.equal(r0.body.canManage, false);
  const same = await admin("PUT", "/rubric", { criteria: r0.body.rubric.criteria });
  assert.equal(same.body.created, false);
  assert.equal(await M.JuryRubric.countDocuments({}), 0);

  const crit = r0.body.rubric.criteria.map((x) => ({ ...x }));
  crit[0].label = "Novelty";
  const next = [crit[0], crit[1], crit[2], crit[4], { label: "Scalability", weight: 2, anchors: { 1: "Hard to grow", 3: "Can grow", 5: "Built to scale" } }];
  assert.equal((await call("PUT", "/api/console/jury/rubric", { as: U.sam, body: { criteria: next } })).status, 403);
  assert.equal((await admin("PUT", "/rubric", { criteria: Array.from({ length: 7 }, (_, i) => ({ label: `C${i}` })) })).status, 400);
  const v2 = await admin("PUT", "/rubric", { criteria: next });
  assert.equal(v2.body.created, true);
  assert.equal(v2.body.rubric.version, 2);
  assert.deepEqual(v2.body.rubric.criteria.map((x) => x.key), ["innovation", "impact", "traction", "fit", "scalability"]);
  assert.equal(v2.body.rubric.shares.scalability, 33.3);
  assert.equal(v2.body.usage["1"], 1);

  // Ava's submitted assessment is untouched (still on version 1, with its Team score).
  const row = await assignment("ava", "n1");
  assert.equal(row.submission.rubricVersion, 1);
  assert.equal(row.submission.scores.team, 4);
  const res = (await admin("GET", "/results")).body;
  const n1 = res.rows.find((r) => r.id === id(N.n1));
  assert.deepEqual(n1.perCriterion.scalability, { avg: null, n: 0 });
  assert.equal(n1.olderRubric, 1);
  assert.equal(n1.total, 81.3); // innovation 5, impact 4, traction 4, fit 4 on equal weights: (1 + .75 × 3) / 4
  assert.equal(res.rubricVersion, 2);

  // The juror sees the new rubric; reopening keeps the old scores in the draft until they save.
  const g = await jury("ava", "GET", `/nominations/${id(N.n1)}`);
  assert.equal(g.body.rubric.version, 2);
  assert.deepEqual(g.body.rubric.criteria.map((x) => x.label), ["Novelty", "Impact", "Traction & evidence", "Fit for the category", "Scalability"]);
  await jury("ava", "POST", `/nominations/${id(N.n1)}/edit`);
  const saved = await jury("ava", "PUT", `/nominations/${id(N.n1)}/draft`, { scores: { innovation: 5, impact: 4, traction: 4, fit: 4, team: 4, scalability: 3 } });
  assert.deepEqual(saved.body.missing, []);
  const afterSave = await assignment("ava", "n1");
  assert.equal(afterSave.draft.scores.team, undefined); // not on this rubric
  assert.equal(afterSave.draft.rubricVersion, 2);
  assert.equal(afterSave.submission.scores.team, 4);    // the submitted one is still as it was
  await jury("ava", "POST", `/nominations/${id(N.n1)}/discard`);

  // Back to the built-in five: "team" is an old key, so its earlier scores count again.
  const v3 = await admin("PUT", "/rubric", { criteria: r0.body.rubric.criteria });
  assert.equal(v3.body.rubric.version, 3);
  assert.deepEqual(v3.body.rubric.criteria.map((x) => x.key), ["innovation", "impact", "traction", "team", "fit"]);
  assert.equal((await admin("GET", "/results")).body.rows.find((r) => r.id === id(N.n1)).total, 80);
  assert.equal((await M.AdminAudit.find({ action: "jury_rubric" }).lean()).length, 2);
});

test("results: averages, weighted totals, the tally, comments by juror, rank in category, CSV; management only", { skip }, async () => {
  const u1 = `/nominations/${id(N.n1)}`;
  const u2 = `/nominations/${id(N.n2)}`;
  await jury("ava", "POST", `${u1}/edit`);
  assert.equal((await jury("ava", "POST", `${u1}/submit`, { scores: allFours, recommendation: "yes", comment: "" })).status, 200);
  assert.equal((await jury("ben", "POST", `${u1}/submit`, { scores: all(5), recommendation: "strong_yes", comment: "Outstanding evidence." })).status, 200);
  assert.equal((await jury("ben", "POST", `${u2}/submit`, { scores: all(3), recommendation: "maybe" })).status, 200);
  assert.equal((await jury("ava", "POST", `${u2}/submit`, { scores: all(2), recommendation: "no", comment: "Early." })).status, 200);
  await jury("cy", "PUT", `${u2}/draft`, { scores: { innovation: 1 } });

  assert.equal((await call("GET", "/api/console/jury/results", { as: U.sam })).status, 403);
  assert.equal((await call("GET", "/api/console/jury/results.csv", { as: U.sam })).status, 403);
  const r = await admin("GET", "/results");
  assert.equal(r.status, 200);
  const n1 = r.body.rows.find((x) => x.id === id(N.n1));
  const n2 = r.body.rows.find((x) => x.id === id(N.n2));
  assert.equal(n1.total, 87.5);
  assert.deepEqual(n1.perCriterion.innovation, { avg: 4.5, n: 2 });
  assert.deepEqual(n1.tally, { strong_yes: 1, yes: 1, maybe: 0, no: 0, none: 0 });
  assert.deepEqual(n1.comments.map((c) => [c.juror, c.comment]), [["Ben Juror", "Outstanding evidence."]]);
  assert.equal(n1.rank, 1);
  assert.equal(n2.total, 37.5);
  assert.equal(n2.assigned, 3);
  assert.equal(n2.submitted, 2);
  assert.equal(n2.drafts, 1);
  assert.equal(n2.rank, 2);
  assert.equal(n1.inCategory, 2);
  assert.deepEqual(n1.jurors.map((j) => [j.name, j.total]), [["Ava Juror", 75], ["Ben Juror", 100]]);
  const n3 = r.body.rows.find((x) => x.id === id(N.n3));
  assert.equal(n3.total, null);
  assert.equal(n3.rank, null);
  assert.ok(r.body.jurors.find((j) => j.name === "Ben Juror").progress.submitted >= 2);
  assert.equal(r.body.criteria.length, 5);

  const csv = await call("GET", "/api/console/jury/results.csv", { as: U.mia });
  assert.equal(csv.status, 200);
  const lines = csv.text.split("\r\n");
  assert.match(lines[0], /^Rank in category,Category,Nominee,Organisation,Status/);
  assert.ok(lines.some((l) => l.startsWith("1,") && l.includes("Northwind Health AI") && l.includes(",87.5,") && l.includes("Ben Juror: Outstanding evidence.")));

  // Another juror's scores never reach a juror.
  const avaView = await jury("ava", "GET", u1);
  assert.ok(!avaView.text.includes("Outstanding evidence"));
  assert.ok(!avaView.text.includes("strong_yes\",\"comment\":\"Outstanding"));
});

test("unassign and give back: the scores stay but don't count, then count again", { skip }, async () => {
  const off = await admin("POST", "/unassign", { pairs: [{ jurorId: JR.ben.id, nominationId: id(N.n1) }] });
  assert.equal(off.body.removed, 1);
  assert.equal((await jury("ben", "GET", `/nominations/${id(N.n1)}`)).status, 404);
  assert.ok(!(await jury("ben", "GET", "/assignments")).body.rows.some((r) => r.id === id(N.n1)));
  let n1 = (await admin("GET", "/results")).body.rows.find((x) => x.id === id(N.n1));
  assert.equal(n1.submitted, 1);
  assert.equal(n1.total, 75);
  const back = await admin("POST", "/assign", { jurorIds: [JR.ben.id], nominationIds: [id(N.n1)] });
  assert.equal(back.body.reactivated, 1);
  n1 = (await admin("GET", "/results")).body.rows.find((x) => x.id === id(N.n1));
  assert.equal(n1.total, 87.5);
  assert.equal((await jury("ben", "GET", `/nominations/${id(N.n1)}`)).body.assessment.state, "submitted");
});

test("a nomination that stops progressing leaves every juror's list and the results", { skip }, async () => {
  const holders = (await M.JuryAssignment.find({ nomination: N.n3._id, active: true }).lean()).map((a) => String(a.juror));
  const who = Object.keys(JR).find((k) => holders.includes(JR[k].id) && TOK[k]);
  assert.ok(who);
  assert.equal((await call("PATCH", `/api/console/nominations/${id(N.n3)}`, { as: U.mia, body: { status: "rejected" } })).status, 200);
  assert.ok(!(await jury(who, "GET", "/assignments")).body.rows.some((r) => r.id === id(N.n3)));
  assert.equal((await jury(who, "GET", `/nominations/${id(N.n3)}`)).status, 404);
  const row = (await admin("GET", "/nominations")).body.rows.find((r) => r.id === id(N.n3));
  assert.equal(row.hidden, true);
  assert.ok(!(await admin("GET", "/results")).body.rows.some((r) => r.id === id(N.n3)));
  await call("PATCH", `/api/console/nominations/${id(N.n3)}`, { as: U.mia, body: { status: "shortlisted" } });
  assert.ok((await jury(who, "GET", "/assignments")).body.rows.some((r) => r.id === id(N.n3)));
});

test("emails: invite and reminder only on a management click, from enquire@, wording editable, a test to yourself", { skip }, async () => {
  sent.length = 0;
  assert.equal((await call("POST", `/api/console/jury/jurors/${JR.ava.id}/invite`, { as: U.sam })).status, 403);
  assert.equal(sent.length, 0);
  const inv = await admin("POST", `/jurors/${JR.ava.id}/invite`);
  assert.equal(inv.status, 200, JSON.stringify(inv.body));
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.from, "The Tech Festival Canada <enquire@thetechfestival.com>");
  assert.equal(m.reply_to, "enquire@thetechfestival.com");
  assert.deepEqual([].concat(m.to), [JR.ava.email]);
  assert.equal(m.subject, "You're on the Catalyst Awards jury");
  assert.ok(m.html.includes("https://www.thetechfestival.com/awards/jury-admin"));
  assert.ok(m.text.includes("3 nominations to review"));
  assert.ok(m.text.includes("Sign in with ava.juror@example.com."));
  const ava = await M.Juror.findById(JR.ava.id).lean();
  assert.equal(ava.inviteCount, 1);
  assert.ok(ava.invitedAt);

  // Wording: staff read and preview, management save.
  assert.equal((await call("PUT", "/api/console/jury/email/invite", { as: U.sam, body: { subject: "x" } })).status, 403);
  const saved = await admin("PUT", "/email/invite", { subject: "Join the Catalyst jury, {firstName}", heading: "Welcome to the jury" });
  assert.deepEqual(saved.body.copy, { subject: "Join the Catalyst jury, {firstName}" });
  const pv = await call("POST", "/api/console/jury/email/invite/preview", { as: U.sam, body: {} });
  assert.equal(pv.body.subject, "Join the Catalyst jury, Jordan");
  const pv2 = await admin("POST", "/email/invite/preview", { jurorId: JR.ben.id, heading: "Draft heading" });
  assert.equal(pv2.body.subject, "Join the Catalyst jury, Ben");
  assert.ok(pv2.body.html.includes("Draft heading"));
  assert.equal(pv2.body.to, JR.ben.email);
  assert.equal(sent.length, 1); // previews never send
  const test1 = await call("POST", "/api/console/jury/email/reminder/send-test", { as: U.sam, body: {} });
  assert.equal(test1.status, 200);
  assert.deepEqual([].concat(sent.at(-1).to), ["sam.example@example.com"]);
  assert.match(sent.at(-1).subject, /^\[Test\] Reminder: 4 nominations left to review$/);
  assert.equal((await M.Juror.findById(JR.ava.id).lean()).reminderCount, 0); // a test isn't a send

  // Reminders: only someone with work left; everyone with work left.
  const avaLeft = (await jury("ava", "GET", "/me")).body.progress.remaining;
  const rem = await admin("POST", `/jurors/${JR.ava.id}/remind`);
  if (avaLeft > 0) assert.equal(rem.status, 200);
  else assert.equal(rem.body.code, "done");
  assert.equal((await admin("POST", "/remind-all", {})).status, 400);
  const before = sent.length;
  const allR = await admin("POST", "/remind-all", { confirm: "SEND" });
  assert.equal(allR.status, 200);
  assert.equal(sent.length - before, allR.body.sent);
  assert.ok(sent.slice(before).every((x) => x.from === "The Tech Festival Canada <enquire@thetechfestival.com>" && /left to review/.test(x.subject)));

  await admin("PATCH", `/jurors/${JR.cy.id}`, { active: false });
  assert.equal((await admin("POST", `/jurors/${JR.cy.id}/invite`)).body.code, "inactive");
  await admin("PATCH", `/jurors/${JR.cy.id}`, { active: true });

  // The real code email (the default router), through the stubbed Resend.
  const n = sent.length;
  await call("POST", "/api/jury-mail/auth/code", { body: { email: JR.ava.email } });
  for (let i = 0; i < 40 && sent.length === n; i++) await sleep(25);
  const codeMail = sent.at(-1);
  assert.equal(codeMail.subject, "Your Catalyst Awards jury sign-in code");
  assert.equal(codeMail.from, "The Tech Festival Canada <enquire@thetechfestival.com>");
  const code = (codeMail.text.match(/(\d{3}) (\d{3})/) || []).slice(1).join("");
  assert.match(code, /^\d{6}$/);
  assert.equal((await call("POST", "/api/jury-mail/auth/code/verify", { body: { email: JR.ava.email, code } })).status, 200);
});

test("rate limits: wrong passwords, code requests and code checks are capped", { skip }, async () => {
  let last;
  for (let i = 0; i < 9; i++) last = await call("POST", "/api/jury-limits/auth/login", { body: { email: JR.cy.email, password: "not the password" } });
  assert.equal(last.status, 429);
  for (let i = 0; i < 6; i++) last = await call("POST", "/api/jury-limits/auth/code", { body: { email: "limits@example.com" } });
  assert.equal(last.status, 429);
  for (let i = 0; i < 41; i++) last = await call("POST", "/api/jury-limits/auth/code/verify", { body: { email: "limits@example.com", code: "123456" } });
  assert.equal(last.status, 429);
});

test("removing a juror ends their sessions, takes their allocations off and their scores out; adding them again restores the record", { skip }, async () => {
  const del = await admin("DELETE", `/jurors/${JR.ben.id}`);
  assert.equal(del.body.removed, true);
  assert.equal((await jury("ben", "GET", "/me")).status, 401);
  assert.equal((await call("POST", "/api/jury/auth/login", { body: { email: JR.ben.email, password: "bens new passphrase" } })).status, 401);
  assert.ok(!(await admin("GET", "/overview")).body.jurors.some((j) => j.name === "Ben Juror"));
  const n1 = (await admin("GET", "/results")).body.rows.find((x) => x.id === id(N.n1));
  assert.equal(n1.submitted, 1);
  assert.equal(await M.JuryAssignment.countDocuments({ juror: JR.ben.id, active: true }), 0);
  assert.equal((await M.JuryAssignment.findOne({ juror: JR.ben.id, nomination: N.n1._id }).lean()).submission.scores.team, 5); // kept

  const back = await admin("POST", "/jurors", { name: "Ben Juror", email: JR.ben.email });
  assert.equal(back.status, 201);
  assert.equal(back.body.juror.id, JR.ben.id);
  assert.equal(back.body.juror.progress.assigned, 0);
  await admin("POST", "/assign", { jurorIds: [JR.ben.id], nominationIds: [id(N.n1)] });
  assert.equal((await admin("GET", "/results")).body.rows.find((x) => x.id === id(N.n1)).submitted, 2);
  assert.equal((await jury("ben", "GET", "/me")).status, 401); // the old session stays ended
  const audits = await M.AdminAudit.find({ targetType: "jury" }).lean();
  for (const a of ["jury_juror_remove", "jury_juror_restore", "jury_assign", "jury_unassign", "jury_settings", "jury_invite", "jury_results_view"]) {
    assert.ok(audits.some((x) => x.action === a), a);
  }
});
