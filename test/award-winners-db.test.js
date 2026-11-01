/* The Catalyst Awards winners through the real routes (Oct 31 2026), against a real (throwaway) MongoDB: the public list
   and one winner (winners only, hidden ones and private fields left out, the switch), Admin › Winners (staff read,
   management edit, winners only, audited, the website follows at once), and "Post to LinkedIn" up to LinkedIn's door
   (the draft, the sign-in redirect with its state cookie, and the way back for a cancelled or forged callback).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Nothing leaves the machine.
   Fictional nominees and staff, example.com. */
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
process.env.FRONTEND_URL = "https://www.thetechfestival.com";
process.env.LINKEDIN_CLIENT_ID = "test-client";
process.env.LINKEDIN_CLIENT_SECRET = "test-secret";
process.env.LINKEDIN_REDIRECT_URI = "https://backend.example.com/api/auth/linkedin/callback";

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
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
let forgetSwitches;
let forgetWinners;
const M = {};
const U = {};
const N = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-winners-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_winners_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await sleep(250); }
  }
  ({ default: jwt } = await import("jsonwebtoken"));
  ({ forgetSwitches } = await import("../services/liveSwitches.js"));
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Nomination = await imp("../models/Nomination.js");
  M.AwardPost = await imp("../models/AwardPost.js");
  Object.assign(M, await import("../models/Admin.js"));
  const awards = await import("../routes/awards.js");
  forgetWinners = awards.forgetWinners;
  const { default: express } = await import("express");
  const app = express();
  app.post("/api/awards/post", express.json({ limit: "9mb" }), awards.awardPostDraft);
  app.get("/api/auth/linkedin/callback", awards.awardLinkedinCallback, (req, res) => res.status(299).send("next"));
  app.use(express.json());
  app.use("/api/awards", awards.default);
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
      categoryType: "matrix", pillar: "AI & Machine Learning", sector: "Healthcare & Life Sciences", nomineeType: "Organisation",
      selfNomination: true, status: "winner", nominatorName: "Pat Nominator", nominatorEmail: "pat.nominator@example.com",
      nomineeEmail: `${k}@nominee.example.com`, nomineePhone: "+1 416 555 0100", statementOverview: "Private statement.", ...doc,
    });
  };
  await nom("w1", { nomineeName: "Northwind Health AI", nomineeOrganisation: "Northwind Health AI", nomineeWebsite: "northwind.example.com" });
  await nom("w2", { pillar: "Robotics & Automation", nomineeType: "Individual", nomineeName: "Riley Example", nomineeOrganisation: "Example Robotics" });
  await nom("w3", { categoryType: "special", pillar: "", sector: "", specialAward: "rising", nomineeName: "Bluefin Labs", nomineeOrganisation: "Bluefin Labs" });
  await nom("p1", { status: "pending", nomineeName: "Pending Co", nomineeOrganisation: "Pending Co" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const staffToken = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
const id = (d) => String(d._id);

async function call(method, url, { as, body, headers = {}, redirect = "follow" } = {}) {
  const r = await realFetch(base + url, {
    method, redirect,
    headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${staffToken(as)}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = text;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, headers: r.headers };
}
const NOM = "/api/console/nominations";
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(400, 7)]).toString("base64")}`;
const fresh = () => { forgetWinners(); forgetSwitches(); };

test("public list: winners only, in order, nothing private", { skip }, async () => {
  fresh();
  const r = await call("GET", "/api/awards/winners");
  assert.equal(r.status, 200);
  assert.equal(r.body.live, true);
  assert.equal(r.body.awardsNight, "2026-10-26");
  assert.equal(r.body.page, "The Tech Festival Canada");
  assert.deepEqual(r.body.winners.map((w) => w.presentedTo), ["Northwind Health AI", "Riley Example", "Bluefin Labs"]);
  const riley = r.body.winners[1];
  assert.equal(riley.award, "The Catalyst Award for Robotics in Healthcare & Life Sciences");
  assert.equal(riley.company, "Example Robotics");
  assert.equal(riley.showCompany, true);
  const json = JSON.stringify(r.body);
  for (const secret of ["nominee.example.com", "555 0100", "Pat Nominator", "pat.nominator", "Private statement", "Pending Co"]) {
    assert.ok(!json.includes(secret), secret);
  }
  const one = await call("GET", `/api/awards/winners/${id(N.w1)}`);
  assert.equal(one.status, 200);
  assert.equal(one.body.winner.website, "https://northwind.example.com/");
  assert.equal((await call("GET", `/api/awards/winners/${id(N.p1)}`)).status, 404, "not a winner");
  assert.equal((await call("GET", "/api/awards/winners/nope")).status, 404);
});

test("the switch: off = no winners anywhere", { skip }, async () => {
  await M.AppContent.create({ key: "site.award_winners", value: false });
  fresh();
  const r = await call("GET", "/api/awards/winners");
  assert.equal(r.body.live, false);
  assert.deepEqual(r.body.winners, []);
  assert.equal((await call("GET", `/api/awards/winners/${id(N.w1)}`)).status, 404);
  assert.equal((await call("POST", "/api/awards/post", { body: { id: id(N.w1), image: JPEG, text: "Proud!" } })).status, 404);
  const admin = await call("GET", `${NOM}/winners`, { as: U.sam });
  assert.equal(admin.body.live, false);
  assert.equal(admin.body.rows.length, 3, "staff still see them");
  await M.AppContent.deleteOne({ key: "site.award_winners" });
  fresh();
});

test("Admin › Winners: staff read, management edits, winners only, audited, the website follows", { skip }, async () => {
  fresh();
  const list = await call("GET", `${NOM}/winners`, { as: U.sam });
  assert.equal(list.status, 200);
  assert.equal(list.body.rows[0].defaults.presentedTo, "Northwind Health AI");
  assert.equal((await call("GET", `${NOM}/winners`, { as: U.ana })).status, 403);

  const body = { presentedTo: "Dana Example", title: "Best in Health", presentedOn: "2026-10-27", citation: "For care that scales.", order: 5 };
  assert.equal((await call("PATCH", `${NOM}/${id(N.w1)}/award`, { as: U.sam, body })).status, 403, "staff");
  assert.equal((await call("PATCH", `${NOM}/${id(N.w1)}/award`, { body })).status, 401, "no sign-in");
  assert.equal((await call("PATCH", `${NOM}/${id(N.p1)}/award`, { as: U.mia, body })).status, 409, "not a winner");
  assert.equal((await call("PATCH", `${NOM}/${id(N.w1)}/award`, { as: U.mia, body: { presentedOn: "soon" } })).status, 400);

  await call("GET", "/api/awards/winners"); // cached before the change
  const r = await call("PATCH", `${NOM}/${id(N.w1)}/award`, { as: U.mia, body });
  assert.equal(r.status, 200);
  assert.equal(r.body.row.presentedTo, "Dana Example");
  assert.equal(r.body.row.updatedBy, "Mia Example");
  const pub = await call("GET", "/api/awards/winners");
  const w1 = pub.body.winners.find((w) => w.id === id(N.w1));
  assert.equal(w1.award, "Best in Health");
  assert.equal(w1.presentedTo, "Dana Example");
  assert.equal(w1.showCompany, true);
  assert.equal(w1.presentedOn, "2026-10-27");
  assert.equal(pub.body.winners.at(-1).id, id(N.w1), "order 5 goes last");
  const audit = await M.AdminAudit.findOne({ action: "award_winner_edit" }).lean();
  assert.match(audit.detail, /Northwind Health AI: .*presentedTo "Dana Example"/);

  // Hidden, then back; "" puts a default back.
  await call("PATCH", `${NOM}/${id(N.w1)}/award`, { as: U.mia, body: { hidden: true } });
  assert.ok(!(await call("GET", "/api/awards/winners")).body.winners.some((w) => w.id === id(N.w1)));
  await call("PATCH", `${NOM}/${id(N.w1)}/award`, { as: U.mia, body: { hidden: false, presentedTo: "", title: "", order: 0 } });
  const back = (await call("GET", `/api/awards/winners/${id(N.w1)}`)).body.winner;
  assert.equal(back.presentedTo, "Northwind Health AI");
  assert.equal(back.award, "The Catalyst Award for Artificial Intelligence in Healthcare & Life Sciences");

  // A status change moves the website's list at once.
  await call("PATCH", `${NOM}/${id(N.p1)}`, { as: U.sam, body: { status: "winner" } });
  assert.ok((await call("GET", "/api/awards/winners")).body.winners.some((w) => w.id === id(N.p1)));
  await call("PATCH", `${NOM}/${id(N.p1)}`, { as: U.sam, body: { status: "pending" } });
  assert.ok(!(await call("GET", "/api/awards/winners")).body.winners.some((w) => w.id === id(N.p1)));
});

test("Post to LinkedIn: the draft, the sign-in with its state cookie, and the way back", { skip }, async () => {
  fresh();
  assert.equal((await call("POST", "/api/awards/post", { body: { id: id(N.w2), image: "data:image/gif;base64,R0lGOD", text: "Hi" } })).body.code, "image");
  assert.equal((await call("POST", "/api/awards/post", { body: { id: id(N.w2), image: JPEG, text: "  " } })).body.code, "text");
  assert.equal((await call("POST", "/api/awards/post", { body: { id: id(N.p1), image: JPEG, text: "Hi" } })).status, 404);
  const d = await call("POST", "/api/awards/post", { body: { id: id(N.w2), image: JPEG, text: "Honoured to receive this at The Tech Festival Canada 2026." } });
  assert.equal(d.status, 200);
  assert.match(d.body.id, /^[0-9a-f]{32}$/);

  const go = await call("GET", `/api/awards/linkedin/post?d=${d.body.id}&w=${id(N.w2)}`, { redirect: "manual" });
  assert.equal(go.status, 302);
  const to = new URL(go.headers.get("location"));
  assert.equal(to.origin + to.pathname, "https://www.linkedin.com/oauth/v2/authorization");
  assert.equal(to.searchParams.get("scope"), "openid profile w_member_social");
  const state = to.searchParams.get("state");
  assert.match(state, new RegExp(`^ttfc-awd\\.[0-9a-f]{32}\\.${id(N.w2)}$`), "the state names the winner");
  assert.match(go.headers.get("set-cookie"), new RegExp(`ttfc_awd_li=${state.replaceAll(".", "\\.")}; Path=/api/auth/linkedin`));

  // Not ours: on to the next handler. Forged (no cookie): back with "expired". Cancelled: back with "cancelled".
  assert.equal((await call("GET", "/api/auth/linkedin/callback?state=ttfc-att.x&code=1", { redirect: "manual" })).status, 299);
  const forged = await call("GET", `/api/auth/linkedin/callback?state=${state}&code=abc`, { redirect: "manual" });
  assert.equal(forged.headers.get("location"), `https://www.thetechfestival.com/awards/winners/${id(N.w2)}#post_error=expired`);
  const cancelled = await call("GET", `/api/auth/linkedin/callback?state=${state}&error=user_cancelled_authorize`, {
    redirect: "manual", headers: { cookie: `ttfc_awd_li=${state}` },
  });
  assert.equal(cancelled.headers.get("location"), `https://www.thetechfestival.com/awards/winners/${id(N.w2)}#post_error=cancelled`);
  assert.ok(await M.AwardPost.findOne({ state }), "the draft stays for another try");
  assert.equal((await call("GET", "/api/awards/linkedin/post?d=nope", { redirect: "manual" })).headers.get("location"),
    "https://www.thetechfestival.com/awards#post_error=expired");
  // A lost draft still goes back to the winner's page: from `w`, or from the state.
  assert.equal((await call("GET", `/api/awards/linkedin/post?d=${"0".repeat(32)}&w=${id(N.w2).toUpperCase()}`, { redirect: "manual" })).headers.get("location"),
    `https://www.thetechfestival.com/awards/winners/${id(N.w2)}#post_error=expired`);
  const lost = `ttfc-awd.${"a".repeat(32)}.${id(N.w2)}`;
  assert.equal((await call("GET", `/api/auth/linkedin/callback?state=${lost}&code=abc`, { redirect: "manual", headers: { cookie: `ttfc_awd_li=${lost}` } })).headers.get("location"),
    `https://www.thetechfestival.com/awards/winners/${id(N.w2)}#post_error=expired`);
});

test("Post to LinkedIn: nothing is posted for a winner hidden since the draft, and the draft goes", { skip }, async () => {
  fresh();
  const d = await call("POST", "/api/awards/post", { body: { id: id(N.w3), image: JPEG, text: "Proud of Bluefin Labs at The Tech Festival Canada 2026." } });
  const go = await call("GET", `/api/awards/linkedin/post?d=${d.body.id}`, { redirect: "manual" });
  const state = new URL(go.headers.get("location")).searchParams.get("state");
  await call("PATCH", `${NOM}/${id(N.w3)}/award`, { as: U.mia, body: { hidden: true } });
  // LinkedIn would be called next (blocked in this test): the check comes first, so no request leaves.
  const r = await call("GET", `/api/auth/linkedin/callback?state=${state}&code=abc`, { redirect: "manual", headers: { cookie: `ttfc_awd_li=${state}` } });
  assert.equal(r.headers.get("location"), `https://www.thetechfestival.com/awards/winners/${id(N.w3)}#post_error=withdrawn`);
  assert.equal(await M.AwardPost.countDocuments({ winnerId: id(N.w3) }), 0);
  await call("PATCH", `${NOM}/${id(N.w3)}/award`, { as: U.mia, body: { hidden: false } });
});

test("Post to LinkedIn: at most AWARD_DRAFTS_MAX drafts wait at once", { skip }, async () => {
  fresh();
  const { AWARD_DRAFTS_MAX } = await import("../services/awardWinners.js");
  await M.AwardPost.deleteMany({});
  await M.AwardPost.insertMany(Array.from({ length: AWARD_DRAFTS_MAX }, (_, i) => ({ draftId: i.toString(16).padStart(32, "0"), winnerId: id(N.w1), image: Buffer.alloc(8), text: "x" })));
  const r = await call("POST", "/api/awards/post", { body: { id: id(N.w1), image: JPEG, text: "Hi" } });
  assert.equal(r.status, 503);
  assert.equal(r.body.code, "busy");
  await M.AwardPost.deleteMany({});
});
