/* Changing a Catalyst Awards nomination's category and the nominee's focus (Admin → Catalyst Awards → Nominations,
   Oct 22 2026) through the real routes, against a real (throwaway) MongoDB: management only (staff, app accounts and
   no sign-in refused), names from the canonical lists only (400 otherwise, nothing saved), what was submitted copied
   once at the first change and never overwritten, the changed-by fields, restoring what they submitted, the audit
   (labels only), the admin DTO and CSV, and every consumer following the live values: the list's category filter,
   the apps' category count, jury allocation filters, jury results (rank within the new category) and the juror's
   view (the live category and focus only, never what was submitted or who changed it).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine.
   Fictional nominees, staff and jurors, example.com. */
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
delete process.env.JURY_JWT_SECRET;

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
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
let signJuryToken;
let forgetAwards;
const M = {};
const U = {};
const N = {};
const JR = {};

const AI = "AI & Machine Learning";
const QC = "Quantum Computing";
const ROB = "Robotics & Automation";
const HEALTH = "Healthcare & Life Sciences";
const ENERGY = "Energy & Critical Infrastructure";
const FIN = "Financial Services & Banking";

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-nomov-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_nomov_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ signJuryToken } = await import("../services/juryAuth.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Nomination = await imp("../models/Nomination.js");
  M.Juror = await imp("../models/Juror.js");
  M.JuryAssignment = await imp("../models/JuryAssignment.js");
  Object.assign(M, await import("../models/Admin.js"));
  const awards = await import("../routes/appAwards.js");
  forgetAwards = awards.forgetAwardApplications;
  const { createJuryRouter } = await import("../routes/jury.js");
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app", awards.default);
  app.use("/api/jury", createJuryRouter({ sendCode: async () => {} }));
  app.use("/api/console/jury", await imp("../routes/juryAdmin.js"));
  app.use("/api/console/nominations", await imp("../routes/nominationsAdmin.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const mk = async (k, doc) => { U[k] = await M.User.create(doc); };
  await mk("mia", { name: "Mia Example", email: "mia.example@example.com", role: "admin", staffRole: "management" });
  await mk("sam", { name: "Sam Example", email: "sam.example@example.com", role: "admin", staffRole: "staff" });
  await mk("ana", { name: "Ana Example", email: "ana.example@example.com" });

  const nom = async (k, doc) => {
    N[k] = await M.Nomination.create({
      categoryType: "matrix", nomineeType: "Organisation", selfNomination: false, status: "shortlisted",
      nominatorName: "Pat Nominator", nominatorOrganisation: "Example Ventures", nominatorEmail: "pat.nominator@example.com",
      nomineeEmail: `${k}@nominee.example.com`, statementOverview: "Overview.", ...doc,
    });
  };
  await nom("n1", { pillar: AI, sector: HEALTH, nomineeName: "Northwind Health AI", nomineeOrganisation: "Northwind Health AI Inc.", nomineeSector: "FinTech" });
  await nom("n2", { pillar: AI, sector: HEALTH, nomineeName: "Bluefin Diagnostics", nomineeOrganisation: "Bluefin Diagnostics", nomineeSector: "Health" });
  await nom("n3", { categoryType: "special", specialAward: "rising", nomineeName: "Riley Example", nomineeType: "Individual", selfNomination: true });
  await nom("n4", { pillar: QC, sector: ENERGY, nomineeName: "Qubit Grid Labs", nomineeOrganisation: "Qubit Grid Labs" });

  // Two jurors scored n1 and n2 (same category): n1 ranks above n2.
  JR.ava = await M.Juror.create({ name: "Ava Juror", email: "ava.juror@example.com" });
  JR.ben = await M.Juror.create({ name: "Ben Juror", email: "ben.juror@example.com" });
  const scores = (v) => ({ innovation: v, impact: v, traction: v, team: v, fit: v });
  const assign = (j, n, v) => M.JuryAssignment.create({
    juror: j._id, nomination: n._id, active: true, assignedBy: "Mia Example",
    submission: { scores: scores(v), recommendation: "yes", comment: "", rubricVersion: 1, submittedAt: new Date("2026-10-21T15:00:00Z") },
  });
  await assign(JR.ava, N.n1, 5);
  await assign(JR.ava, N.n2, 3);
  await assign(JR.ben, N.n1, 5);
  await assign(JR.ben, N.n2, 3);
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const staffToken = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
const id = (d) => String(d._id);

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
const NOM = "/api/console/nominations";
const mia = (method, url, body) => call(method, `${NOM}${url}`, { as: U.mia, body });
const raw = (d) => M.Nomination.findById(d._id).lean();

test("management only: staff, app accounts and no sign-in can't change a category or focus, or restore", { skip }, async () => {
  const routes = [
    ["PATCH", `/${id(N.n1)}/category`, { categoryType: "matrix", pillar: QC, sector: FIN }],
    ["PATCH", `/${id(N.n1)}/focus`, { nomineePillar: QC }],
    ["POST", `/${id(N.n1)}/restore-submitted`, { what: "both" }],
  ];
  for (const [method, url, body] of routes) {
    assert.equal((await call(method, NOM + url, { as: U.sam, body })).status, 403, `staff ${url}`);
    assert.equal((await call(method, NOM + url, { as: U.sam, body })).body.error, "Management only");
    assert.equal((await call(method, NOM + url, { as: U.ana, body })).status, 403, `app account ${url}`);
    assert.equal((await call(method, NOM + url, { body })).status, 401, `no sign-in ${url}`);
  }
  const n1 = await raw(N.n1);
  assert.equal(n1.pillar, AI);
  assert.equal(n1.submitted, undefined);
  // Staff still read the nomination (with the lists) and keep moving it along.
  const r = await call("GET", `${NOM}/${id(N.n1)}`, { as: U.sam });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.options.pillars, [AI, QC, "Cybersecurity & Digital Trust", ROB, "CleanTech & Sustainability"]);
  assert.equal(r.body.options.sectors.length, 5);
  assert.deepEqual(r.body.options.specialAwards.map((a) => a.key), ["lifetime", "rising", "crossborder"]);
});

test("validation: unknown names, types and ids are refused and nothing is saved", { skip }, async () => {
  const bad = [
    [`/${id(N.n1)}/category`, { categoryType: "matrix", pillar: "Artificial Intelligence", sector: HEALTH }, /Pillar must be one of/],
    [`/${id(N.n1)}/category`, { categoryType: "matrix", pillar: AI, sector: "Healthcare" }, /Sector must be one of/],
    [`/${id(N.n1)}/category`, { categoryType: "matrix", pillar: AI }, /Sector must be one of/],
    [`/${id(N.n1)}/category`, { categoryType: "special", specialAward: "bogus" }, /Special award must be one of/],
    [`/${id(N.n1)}/category`, { categoryType: "special" }, /Special award/],
    [`/${id(N.n1)}/category`, { categoryType: "other", pillar: AI, sector: HEALTH }, /categoryType/],
    [`/${id(N.n1)}/category`, {}, /categoryType/],
    [`/${id(N.n1)}/category`, { categoryType: "matrix", pillar: [AI], sector: HEALTH }, /Pillar/],
    [`/${id(N.n1)}/focus`, { nomineePillar: "Blockchain" }, /Focus pillar must be one of/],
    [`/${id(N.n1)}/focus`, { nomineeSector: "Retail" }, /Focus sector must be one of/],
    [`/${id(N.n1)}/focus`, { nomineeSector: 42 }, /Focus sector/],
    [`/${id(N.n1)}/focus`, {}, /nomineeSector and\/or nomineePillar/],
  ];
  for (const [url, body, msg] of bad) {
    const r = await mia("PATCH", url, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.body.error, msg);
  }
  assert.equal((await mia("POST", `/${id(N.n1)}/restore-submitted`, { what: "everything" })).status, 400);
  assert.equal((await mia("POST", `/${id(N.n1)}/restore-submitted`, {})).status, 400);
  // Nothing changed yet: nothing to restore.
  const none = await mia("POST", `/${id(N.n1)}/restore-submitted`, { what: "both" });
  assert.equal(none.status, 409);
  assert.match(none.body.error, /as it was submitted/);
  assert.equal((await mia("PATCH", "/nope/category", { categoryType: "special", specialAward: "rising" })).status, 404);
  assert.equal((await mia("PATCH", "/64b000000000000000000099/focus", { nomineePillar: QC })).status, 404);
  assert.equal((await mia("POST", "/64b000000000000000000099/restore-submitted", { what: "both" })).status, 404);
  const n1 = await raw(N.n1);
  assert.deepEqual([n1.categoryType, n1.pillar, n1.sector, n1.nomineeSector, n1.nomineePillar], ["matrix", AI, HEALTH, "FinTech", ""]);
  assert.equal(n1.submitted, undefined);
  assert.equal(await M.AdminAudit.countDocuments({ targetType: "nomination" }), 0);
});

test("the admin detail before any change: no snapshot, focus, the jury warning counts", { skip }, async () => {
  const r = await mia("GET", `/${id(N.n2)}`);
  const n = r.body.nomination;
  assert.equal(n.submitted, null);
  assert.equal(n.categoryChanged, false);
  assert.equal(n.focusChanged, false);
  assert.equal(n.focus, "Health");
  assert.equal(n.nomineePillar, "");
  assert.deepEqual(n.jury, { assigned: 2, scored: 2 });
  assert.deepEqual((await mia("GET", `/${id(N.n3)}`)).body.nomination.jury, { assigned: 0, scored: 0 });
});

test("a category change: live fields, snapshot of what was submitted, changed-by, audit with labels only", { skip }, async () => {
  const before = Date.now();
  forgetAwards();
  const count0 = (await call("GET", "/api/app/awards/summary")).body.categoriesCount;
  assert.equal(count0, 3); // AI × Health (n1, n2), Rising, Quantum × Energy

  const r = await mia("PATCH", `/${id(N.n2)}/category`, { categoryType: "matrix", pillar: " robotics & automation ", sector: FIN, note: "Robotics fits better (call with Sam)" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  const n = r.body.nomination;
  assert.deepEqual([n.categoryType, n.pillar, n.sector, n.specialAward], ["matrix", ROB, FIN, ""]); // the canonical spelling
  assert.equal(n.category, `${ROB} × ${FIN}`);
  assert.equal(n.categoryLabel, `The Catalyst Award for ${ROB} in ${FIN}`);
  assert.equal(n.categoryChanged, true);
  assert.equal(n.focusChanged, false);
  assert.equal(n.categoryChangedBy, "Mia Example");
  assert.ok(new Date(n.categoryChangedAt).getTime() >= before);
  assert.equal(n.categoryNote, "Robotics fits better (call with Sam)");
  assert.deepEqual(n.submitted, {
    categoryType: "matrix", pillar: AI, sector: HEALTH, specialAward: "", nomineeSector: "Health", nomineePillar: "",
    category: `${AI} × ${HEALTH}`, categoryLabel: `The Catalyst Award for ${AI} in ${HEALTH}`, focus: "Health",
  });

  const audits = await M.AdminAudit.find({ action: "nomination_category" }).lean();
  assert.equal(audits.length, 1);
  assert.equal(audits[0].targetId, id(N.n2));
  assert.equal(audits[0].adminName, "Mia Example");
  assert.equal(audits[0].detail, `category: ${AI} × ${HEALTH} → ${ROB} × ${FIN} (with a note)`);
  for (const personal of ["Bluefin", "Pat", "nominee.example.com", "Sam"]) assert.ok(!audits[0].detail.includes(personal), personal);

  // The list (category filter values), the apps' category count, the jury allocation filters follow at once.
  const list = (await mia("GET", "")).body.rows;
  const row = list.find((x) => x.id === id(N.n2));
  assert.equal(row.category, `${ROB} × ${FIN}`);
  assert.equal(row.categoryChanged, true);
  assert.deepEqual([...new Set(list.map((x) => x.category))].sort(), [`${AI} × ${HEALTH}`, `${QC} × ${ENERGY}`, "Rising Innovator", `${ROB} × ${FIN}`]);
  assert.equal((await call("GET", "/api/app/awards/summary")).body.categoriesCount, 4);
  const alloc = (await call("GET", "/api/console/jury/nominations", { as: U.mia })).body;
  assert.ok(alloc.filters.pillars.includes(ROB));
  assert.ok(alloc.filters.sectors.includes(FIN));
  assert.equal(alloc.rows.find((x) => x.id === id(N.n2)).pillar, ROB);
});

test("jury results rank it in its new category; scores are kept", { skip }, async () => {
  const rows = (await call("GET", "/api/console/jury/results", { as: U.mia })).body.rows;
  const n1 = rows.find((x) => x.id === id(N.n1));
  const n2 = rows.find((x) => x.id === id(N.n2));
  assert.equal(n1.categoryKey, `matrix:${AI}|${HEALTH}`);
  assert.equal(n2.categoryKey, `matrix:${ROB}|${FIN}`);
  assert.deepEqual([n1.rank, n1.inCategory], [1, 1]);
  assert.deepEqual([n2.rank, n2.inCategory], [1, 1]); // was 2 of 2 in AI × Health
  assert.equal(n2.submitted, 2);
  assert.equal(n2.total, 50);
  const csv = await call("GET", "/api/console/jury/results.csv", { as: U.mia });
  assert.ok(csv.text.includes(`${ROB} × ${FIN}`));
});

test("snapshot once: a focus change and a second category change never overwrite what was submitted", { skip }, async () => {
  const f = await mia("PATCH", `/${id(N.n2)}/focus`, { nomineePillar: AI, nomineeSector: HEALTH });
  assert.equal(f.status, 200);
  let n = f.body.nomination;
  assert.equal(n.focus, `${AI} · ${HEALTH}`);
  assert.deepEqual([n.nomineePillar, n.nomineeSector], [AI, HEALTH]);
  assert.equal(n.focusChanged, true);
  assert.equal(n.focusChangedBy, "Mia Example");
  assert.equal(n.focusNote, "");
  assert.equal(n.submitted.nomineeSector, "Health");
  assert.equal(n.submitted.pillar, AI);

  const c = await mia("PATCH", `/${id(N.n2)}/category`, { categoryType: "special", specialAward: "crossborder" });
  n = c.body.nomination;
  assert.deepEqual([n.categoryType, n.pillar, n.sector, n.specialAward, n.category], ["special", "", "", "crossborder", "Cross-Border Impact"]);
  assert.equal(n.categoryNote, ""); // a change without a note clears the last one
  const stored = await raw(N.n2);
  assert.deepEqual(stored.submitted, { categoryType: "matrix", pillar: AI, sector: HEALTH, specialAward: "", nomineeSector: "Health", nomineePillar: "" });

  // The same values again: nothing changes, nothing is audited.
  const audits = await M.AdminAudit.countDocuments({ targetType: "nomination" });
  const same = await mia("PATCH", `/${id(N.n2)}/category`, { categoryType: "special", specialAward: "crossborder" });
  assert.equal(same.status, 200);
  assert.equal(same.body.changed, false);
  assert.equal(await M.AdminAudit.countDocuments({ targetType: "nomination" }), audits);

  const fa = await M.AdminAudit.findOne({ action: "nomination_focus" }).lean();
  assert.equal(fa.detail, `focus: Health → ${AI} · ${HEALTH}`);
});

test("focus: the free-text sector can stay as typed while the pillar changes; none clears", { skip }, async () => {
  let r = await mia("PATCH", `/${id(N.n1)}/focus`, { nomineePillar: QC, nomineeSector: "FinTech" });
  assert.equal(r.status, 200);
  assert.equal(r.body.nomination.focus, `${QC} · FinTech`);
  assert.equal(r.body.nomination.categoryChanged, false);
  assert.equal(r.body.nomination.submitted.focus, "FinTech");
  r = await mia("PATCH", `/${id(N.n1)}/focus`, { nomineePillar: "" });
  assert.equal(r.body.nomination.focus, "FinTech");
  assert.equal(r.body.nomination.focusChanged, false); // back to what was submitted
  // Once replaced by a list sector, the old free text isn't accepted any more.
  r = await mia("PATCH", `/${id(N.n1)}/focus`, { nomineeSector: FIN });
  assert.equal(r.body.nomination.nomineeSector, FIN);
  assert.equal((await mia("PATCH", `/${id(N.n1)}/focus`, { nomineeSector: "FinTech" })).status, 400);
});

test("the juror sees the live category and focus only, never what was submitted or who changed it", { skip }, async () => {
  const token = signJuryToken(JR.ava);
  const r = await call("GET", `/api/jury/nominations/${id(N.n2)}`, { token });
  assert.equal(r.status, 200);
  const v = r.body.nominee;
  assert.deepEqual([v.categoryType, v.category, v.specialAward, v.pillar, v.sector], ["special", "Cross-Border Impact", "Cross-Border Impact Award", "", ""]);
  assert.deepEqual([v.nomineePillar, v.nomineeSector, v.focus], [AI, HEALTH, `${AI} · ${HEALTH}`]);
  for (const k of ["submitted", "categoryChangedBy", "categoryChangedAt", "categoryNote", "focusChangedBy", "focusNote", "categoryChanged"]) {
    assert.ok(!(k in v), k);
  }
  assert.ok(!r.text.includes("Mia Example"));
  assert.ok(!r.text.includes('"Health"'));
  const list = (await call("GET", "/api/jury/assignments", { token })).body.rows;
  assert.equal(list.find((x) => x.id === id(N.n2)).category, "Cross-Border Impact");
  assert.ok(!JSON.stringify(list).includes("Mia Example"));
});

test("CSV: Submitted category and Submitted focus next to the live ones (management)", { skip }, async () => {
  assert.equal((await call("GET", `${NOM}/export`, { as: U.sam })).status, 403);
  const csv = (await mia("GET", "/export")).text;
  const lines = csv.split("\r\n");
  const head = lines[0].split(",");
  assert.deepEqual(head.slice(2, 6), ["Category", "Submitted category", "Focus", "Submitted focus"]);
  const n2 = lines.find((l) => l.includes("Bluefin Diagnostics"));
  assert.ok(n2.includes(`,Cross-Border Impact Award,The Catalyst Award for ${AI} in ${HEALTH},${AI} · ${HEALTH},Health,Bluefin Diagnostics,`), n2);
  const n4 = lines.find((l) => l.includes("Qubit Grid Labs"));
  assert.ok(n4.includes(`,The Catalyst Award for ${QC} in ${ENERGY},The Catalyst Award for ${QC} in ${ENERGY},,,`), n4); // unchanged: the same
});

test("restore what they submitted: category, focus or both; changed-by cleared, the snapshot kept, audited", { skip }, async () => {
  forgetAwards();
  assert.equal((await call("GET", "/api/app/awards/summary")).body.categoriesCount, 4); // Cross-Border now, not Robotics × Finance

  let r = await mia("POST", `/${id(N.n2)}/restore-submitted`, { what: "category" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed, true);
  let n = r.body.nomination;
  assert.deepEqual([n.categoryType, n.pillar, n.sector, n.specialAward], ["matrix", AI, HEALTH, ""]);
  assert.equal(n.categoryChanged, false);
  assert.deepEqual([n.categoryChangedBy, n.categoryChangedAt, n.categoryNote], ["", null, ""]);
  assert.equal(n.focusChanged, true); // the focus is still staff's
  assert.equal(n.focus, `${AI} · ${HEALTH}`);
  assert.equal((await call("GET", "/api/app/awards/summary")).body.categoriesCount, 3);
  const results = (await call("GET", "/api/console/jury/results", { as: U.mia })).body.rows;
  assert.deepEqual([results.find((x) => x.id === id(N.n2)).rank, results.find((x) => x.id === id(N.n2)).inCategory], [2, 2]);

  r = await mia("POST", `/${id(N.n2)}/restore-submitted`, { what: "both" });
  n = r.body.nomination;
  assert.deepEqual([n.nomineeSector, n.nomineePillar, n.focus, n.focusChanged, n.focusChangedBy], ["Health", "", "Health", false, ""]);
  assert.ok(n.submitted, "the snapshot stays (it's what came in)");
  const restores = await M.AdminAudit.find({ action: "nomination_restore_submitted" }).sort({ _id: 1 }).lean();
  assert.equal(restores.length, 2);
  assert.equal(restores[0].detail, `restored as submitted, category: Cross-Border Impact → ${AI} × ${HEALTH}`);
  assert.equal(restores[1].detail, `restored as submitted, focus: ${AI} · ${HEALTH} → Health`);
  assert.ok(restores.every((a) => a.targetType === "nomination" && !/Bluefin|Pat|example\.com/.test(a.detail)));

  // A later change still keeps the first snapshot.
  await mia("PATCH", `/${id(N.n2)}/category`, { categoryType: "special", specialAward: "lifetime" });
  assert.equal((await raw(N.n2)).submitted.pillar, AI);
});
