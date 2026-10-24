/* The volunteer panel and the removed kill switch, through the REAL app (server.js imported with TTFC_IMPORT_ONLY=1:
   every router exactly as production mounts them, without .env, the database connection, the jobs or listening)
   against a throwaway local mongod. Starts mongod in a temp folder on a free port and stops
   it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6).
   Nothing leaves the machine: Sanity is answered here, every other outside call is refused, Stripe gets a dummy key
   only while server.js loads (then none), Resend a dummy key, and nothing here sends email. Fictional people,
   example.com addresses.

   1. The route sweep: walks the app's router stack (mount paths recorded as server.js mounts them) and calls every
      admin route (under /api/console, /api/cms, /api/admin, /api/leads, /api/campaigns, or behind requireAdmin
      anywhere) with a volunteer's token: all but the allow-list answer 403 volunteer_forbidden, so a route added
      later is covered without touching this file. Nothing named kill or maintenance answers data or changes state.
   2. What a volunteer gets back: no forbidden key anywhere, none of the seeded emails, phone, ticket IDs, code,
      Stripe session, amounts or notes anywhere (deep scan of the list, the profiles, the search).
   3. No writes. 4. Staff and management unchanged. 5. A volunteer's emailed-code token is refused.
   6. An attendee's account with the volunteer type is refused. 7. The read limit. 8. The kill switch is gone.
   9. (Third round) A hyphen in an email, a booth order or a hyphenated ticket ID never breaks the list, a profile or
      the search; LinkedIn addresses, Stripe IDs, coupon codes and written-out emails in free text are hidden; a
      volunteer's Google or LinkedIn sign-in (answered here by a stand-in for Google and LinkedIn, axios never reaches
      the network) gets 403 password_required, staff's works as before. */
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

process.env.TTFC_IMPORT_ONLY = "1";
process.env.JWT_SECRET ||= "local-test-only";
process.env.RESEND_API_KEY ||= "re_dummy";
process.env.APIFY_API_TOKEN ||= "apify_dummy_test";
delete process.env.GEMINI_API_KEY;
delete process.env.KILL_SWITCH_PASSWORD;
process.env.INTEL_AUTOREFRESH = "false";
// Google and LinkedIn sign-in, answered by the axios stand-in below (never the network).
process.env.GOOGLE_CLIENT_IDS = "ttfc-test-google-client";
process.env.LINKEDIN_CLIENT_ID = "ttfc-test-linkedin-client";
process.env.LINKEDIN_CLIENT_SECRET = "ttfc-test-linkedin-secret";
process.env.LINKEDIN_REDIRECT_URI = "https://api.example.test/api/auth/linkedin/callback";
process.env.FRONTEND_URL = "https://site.example.test";

const d = (s) => new Date(`2026-${s}T12:00:00Z`);
const SECRETS = {
  email: "mara.secret@example.com", guestEmail: "omar.guest@example.com", rsvpEmail: "walkin.rsvp@example.com",
  ticket: "beefcafe0001", guestTicket: "c0ffee000002", speakerTicket: "5bea4e000003",
  code: "SECRETCODE20", stripe: "cs_test_secretsession", phone: "4165550199", linkedin: "linkedin.com/in/mara-secret",
  manualNote: "Invoice SECRET-NOTE-77", hideReason: "SECRET-HIDE-REASON", accessibility: "Wheelchair SECRET-ACCESS",
  contactPhone: "6475550142", killMessage: "OFFLINE-SECRET-MESSAGE",
  // Contact details typed into free text (the second round of testing): a buyer who typed their email as their name,
  // a staff account added without a name (POST /staff names it after the email), an email and a phone number in the
  // company, job title and dietary note.
  yaraEmail: "yara.leak@example.com", yaraLocal: "yara.leak", yaraTicket: "acac56565656",
  staffEmail: "noname.staffer@example.org", staffLocal: "noname.staffer",
  leeEmail: "lee@leakmail.example.com", leeDomain: "leakmail.example.com", leePhone: "555-0188", dietPhone: "416 555 0177",
  // The third round: a hyphen in an email's local part, a booth order and a hyphenated ticket ID (they once crashed the
  // list for every volunteer), a LinkedIn address, a Stripe session, a coupon code and a written-out email in free text.
  maryEmail: "mary-jane@example.com", maryLocal: "mary-jane", maryTicket: "f00d00000123", booth: "BOOTH-GOLD",
  annEmail: "ann-marie.d'arcy@example.com", annTicket: "dead-beef-0042",
  olgaSlug: "olga-secret-li", priyaLocal: "priya.secret", priyaDomain: "priyamail.example.com", piaTicket: "abcd12340042",
};
const AMOUNTS = ["1234.56"];

// The public Sanity CDN: the website speakers and the agenda (who speaks where). Never the network.
const SPEAKERS = [{ _id: "spk-kai", name: "Kai Speaker", title: "Chief Scientist", company: "Quantum Example" }];
const SESSIONS = [
  { day: 1, time: "10:00", endTime: "10:30", title: "Quantum Computing in Finance", format: "panel", speakers: [{ name: "Kai Speaker" }, { name: "Ann Other" }] },
  { day: 2, time: "11:00", endTime: "11:30", title: "Somebody Else's Talk", format: "keynote", speakers: [{ name: "Ann Other" }] },
];
const realFetch = globalThis.fetch;
const outside = [];
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    const q = decodeURIComponent(url.split("query=")[1] || "");
    const result = /moderator, speakers/.test(q) ? SESSIONS : /_type=="speaker"/.test(q) ? SPEAKERS : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  outside.push(url);
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let app = null;
let mongoose;
let adminAuth;
const M = {};
const T = {};   // tokens
const ID = {};  // ids

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-volpanel-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 60; i++) {
    try { await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_volunteer_panel_test`, { serverSelectionTimeoutMS: 500 }); break; }
    catch { await new Promise((r) => setTimeout(r, 250)); }
  }

  // Record each mount path as server.js mounts it (Express 5 layers don't keep it), before server.js loads.
  const { default: express } = await import("express");
  const proto = express.Router.prototype;
  const use = proto.use;
  proto.use = function recordMount(...args) {
    const from = this.stack.length;
    const out = use.apply(this, args);
    const first = args[0];
    const mount = typeof first === "string" || first instanceof RegExp || Array.isArray(first) ? first : "/";
    for (let i = from; i < this.stack.length; i++) this.stack[i].__mount = mount;
    return out;
  };
  // axios (Google's token check, LinkedIn's sign-in, anything else) never reaches the network: Google and LinkedIn are
  // answered here for the sign-in tests, everything else is refused and recorded.
  const { default: axios } = await import("axios");
  axios.defaults.adapter = async (config) => {
    const url = String(config.url || "");
    const answer = (data) => ({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
    if (url.startsWith("https://oauth2.googleapis.com/tokeninfo?id_token=")) {
      const email = decodeURIComponent(url.split("id_token=")[1]).replace(/^google:/, "");
      return answer({ email, name: "From Google", aud: process.env.GOOGLE_CLIENT_IDS, email_verified: "true" });
    }
    if (url === "https://www.linkedin.com/oauth/v2/accessToken") return answer({ access_token: `li:${new URLSearchParams(String(config.data)).get("code")}` });
    if (url === "https://api.linkedin.com/v2/userinfo") {
      const auth = String(config.headers?.Authorization || config.headers?.get?.("Authorization") || "");
      return answer({ name: "From LinkedIn", email: auth.replace(/^Bearer li:/, "") });
    }
    outside.push(url);
    throw new Error(`blocked in the test: ${url}`);
  };
  // webhook.js makes its Stripe client when it loads: a dummy key for that, then none (nothing here calls Stripe).
  process.env.STRIPE_SECRET_KEY = "sk_test_dummy_volunteer_panel";
  ({ default: app } = await import("../server.js"));
  delete process.env.STRIPE_SECRET_KEY;
  proto.use = use;
  adminAuth = await import("../middleware/adminAuth.js");

  const imp = async (p) => (await import(p)).default;
  for (const m of ["User", "Attendee", "Rsvp", "Promo", "CampaignSend", "EmailEngagement"]) M[m] = await imp(`../models/${m}.js`);
  ({ AppContent: M.AppContent, AdminAudit: M.AdminAudit } = await import("../models/Admin.js"));

  const bcrypt = (await import("bcryptjs")).default;
  const pw = await bcrypt.hash("a long enough passphrase", 4);
  // Third round: volunteers who sign in with Google or LinkedIn (one with a password on the account, one without), and
  // one for the odd-data checks (its own read budget).
  const [gina, nell, ivy] = await M.User.create([
    { name: "Gina Volunteer", email: "gina.volunteer@example.com", role: "volunteer", password: pw },
    { name: "Nell Nopass", email: "nell.nopass@example.com", role: "volunteer", provider: "google" },
    { name: "Ivy Volunteer", email: "ivy.volunteer@example.com", role: "volunteer", password: pw },
  ]);
  Object.assign(ID, { gina: gina._id, nell: nell._id, ivy: ivy._id });
  const [mia, sam, val, vic, rae, ban, mara] = await M.User.create([
    { name: "Mia Manager", email: "mia.manager@example.com", role: "admin", staffRole: "management", password: pw },
    { name: "Sam Staff", email: "sam.staff@example.com", role: "admin", staffRole: "staff", password: pw },
    { name: "Val Volunteer", email: "val.volunteer@example.com", role: "volunteer", password: pw },
    // An attendee whose account carries the volunteer person type: the apps' staff sign-in, never the panel.
    { name: "Vic Typed", email: "vic.typed@example.com", role: "user", types: ["volunteer"], password: pw },
    { name: "Rae Rate", email: "rae.rate@example.com", role: "volunteer", password: pw },
    { name: "Ben Banned", email: "ben.banned@example.com", role: "volunteer", banned: true, password: pw },
    { name: "Mara Delegate", email: SECRETS.email, role: "user", organization: "Example Bank", jobTitle: "Head of Digital",
      linkedinUrl: `https://${SECRETS.linkedin}`, vip: true, avatarVersion: 3,
      contactCardSavedAt: d("10-15"), contactItems: [{ id: "c1", kind: "phone", label: "Mobile", value: `+1 ${SECRETS.contactPhone}`, shareByDefault: true }],
      appHidden: { at: d("10-20"), by: "64b0000000000000000000ee", byName: "Sam Staff", reason: SECRETS.hideReason },
      tickets: [{ ticketId: SECRETS.ticket, type: "power", purchaseDate: d("10-01"), stripeSessionId: SECRETS.stripe, promoCode: SECRETS.code,
        checkedIn: true, checkedInAt: d("10-26"), details: { phone: `+1 ${SECRETS.phone}`, linkedin: SECRETS.linkedin } }] },
  ]);
  Object.assign(ID, { mia: mia._id, sam: sam._id, val: val._id, mara: mara._id });
  const [omar, kai] = await M.Attendee.create([
    { name: "Omar Guest", email: SECRETS.guestEmail, ticketId: SECRETS.guestTicket, ticketType: "connect", purchaseDate: d("10-02"),
      manualValue: 1234.56, manualValueNote: SECRETS.manualNote, details: { firstName: "Omar", lastName: "Guest", organisation: "Robotics Example", phone: SECRETS.phone } },
    { name: "Kai Speaker", ticketId: SECRETS.speakerTicket, ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-kai", purchaseDate: d("10-03"),
      issuedPass: { booth: { booth: "B7" } }, details: { jobTitle: "Chief Scientist", organisation: "Quantum Example" } },
  ]);
  Object.assign(ID, { omar: omar._id, kai: kai._id });
  await M.Attendee.create({ name: SECRETS.yaraEmail, email: SECRETS.yaraEmail, ticketId: SECRETS.yaraTicket, ticketType: "connect", purchaseDate: d("10-05"), details: {} });
  await M.User.create({ name: "Lee Leaky", email: "lee.account@example.com", role: "user", organization: `Contact ${SECRETS.leeEmail}`,
    jobTitle: `CTO, +1 (647) ${SECRETS.leePhone}`, password: pw });
  // Third round: odd characters in emails and ticket IDs, a booth order, and free text with a LinkedIn address, a
  // Stripe session, a coupon code (also in an issued pass's printed name) and a written-out email.
  await M.User.create([
    { name: "Mary Jane (mary-jane)", email: SECRETS.maryEmail, role: "user", organization: "Ask for mary-jane at the desk", password: pw,
      tickets: [{ ticketId: SECRETS.maryTicket, type: "connect", purchaseDate: d("10-06") }, { ticketId: SECRETS.booth, type: "booth-single", purchaseDate: d("10-06") }] },
    { name: "Olga Linked", email: "olga.linked@example.com", role: "user", organization: `linkedin.com/in/${SECRETS.olgaSlug}`,
      jobTitle: `https://www.linkedin.com/in/${SECRETS.olgaSlug}/`, linkedinUrl: `https://www.linkedin.com/in/${SECRETS.olgaSlug}/`, password: pw },
    { name: "Tia Tester", email: "tia.t@example.com", role: "user", jobTitle: `Order ${SECRETS.stripe}`, password: pw },
    { name: `Priya ${SECRETS.priyaLocal} [at] ${SECRETS.priyaDomain}`, email: `${SECRETS.priyaLocal}@${SECRETS.priyaDomain}`, role: "user", password: pw },
  ]);
  await M.Attendee.create([
    { name: "Ann-Marie D'Arcy", email: SECRETS.annEmail, ticketId: SECRETS.annTicket, ticketType: "connect", purchaseDate: d("10-06"),
      issuedPass: { label: `Guest ${SECRETS.annTicket}` }, details: {} },
    { name: "Pia Partner", email: "pia.partner@example.com", ticketId: SECRETS.piaTicket, ticketType: "connect", promoCode: "ISSUED", purchaseDate: d("10-06"),
      issuedPass: { label: `Partner ${SECRETS.ticket} ${SECRETS.code}` }, details: { jobTitle: "Speaker, Exhibitor lead" } },
  ]);
  await M.Rsvp.create([
    { key: `t:${SECRETS.piaTicket}`, nameKey: "pia partner", firstName: "Pia", lastName: "Partner", name: "Pia Partner", email: "pia.partner@example.com",
      ticketId: SECRETS.piaTicket, ticketVerified: true, tier: "connect", days: ["day1"], options: [], dietary: ["other"],
      dietaryOther: `No nuts. Code ${SECRETS.code.toLowerCase()} · lnkd.in/x9secret`, source: "attendee", spam: false },
  ]);
  await M.Rsvp.create([
    { key: `t:${SECRETS.yaraTicket}`, nameKey: "", email: SECRETS.yaraEmail, ticketId: SECRETS.yaraTicket, ticketVerified: true, tier: "connect",
      days: ["day1"], options: [], dietary: ["other"], dietaryOther: `Nut allergy, call ${SECRETS.dietPhone} or ${SECRETS.yaraEmail}`, source: "attendee", spam: false },
    { key: `t:${SECRETS.ticket}`, nameKey: "mara delegate", firstName: "Mara", lastName: "Delegate", name: "Mara Delegate", email: SECRETS.email,
      ticketId: SECRETS.ticket, ticketVerified: true, tier: "power", days: ["day1", "day2"], options: ["sessions_d1", "lunch_d1", "gala", "awards"],
      dietary: ["vegan"], dietaryOther: "No mushrooms", accessibility: SECRETS.accessibility, source: "attendee", spam: false, attendeeSubmittedAt: d("10-10") },
    { key: "n:walk in", nameKey: "walk in", firstName: "Walk", lastName: "In", name: "Walk In", email: SECRETS.rsvpEmail, tier: "connect", days: ["day1"],
      options: [], source: "attendee", spam: false },
  ]);
  await M.Promo.create({ code: SECRETS.code, discount: 20 }).catch(() => {});
  await M.CampaignSend.create({ campaign: "rsvp-reminder-2026", email: SECRETS.email, status: "sent", sentAt: d("10-12"), sends: 1 });
  await M.EmailEngagement.create({ campaign: "attending-2026", email: SECRETS.email, opens: 3, firstOpenAt: d("10-12"), lastOpenAt: d("10-13") });
  // An old kill switch row, switched ON: nothing may read it any more.
  await M.AppContent.create({ key: "site.kill", value: { enabled: true, message: SECRETS.killMessage, by: "Old Manager", since: d("10-01") }, updatedBy: "Old Manager" });

  const { default: jwt } = await import("jsonwebtoken");
  const tok = (u, via) => jwt.sign({ id: String(u._id), role: u.role, ...(via ? { via } : {}) }, process.env.JWT_SECRET, { expiresIn: "1h" });
  Object.assign(T, {
    mia: tok(mia), sam: tok(sam), val: tok(val), vic: tok(vic), rae: tok(rae), ban: tok(ban), mara: tok(mara),
    valEmail: tok(val, "email"), valTicket: tok(val, "ticket"),
    ivy: tok(ivy), nellOld: tok(nell), ginaOld: tok(gina),
  });

  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  // Management adds a staff account without a name, the real way (before anything reads the directory).
  const added = await call("POST", "/api/console/staff", { token: T.mia, body: { email: SECRETS.staffEmail, password: "another long passphrase", role: "admin" } });
  assert.equal(added.status, 201, added.text);
  ID.noname = added.body.id;
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function call(method, url, { token, body } = {}) {
  const r = await realFetch(base + url, {
    method, headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined || method === "GET" || method === "HEAD" ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text, headers: r.headers };
}
const isForbidden = (r) => r.status === 403 && r.body?.code === "volunteer_forbidden" && r.body?.error === "Volunteer accounts can only look up people.";

/* ---------- the router stack ---------- */

const ADMIN_PREFIXES = [/^\/api\/console(\/|$)/, /^\/api\/cms(\/|$)/, /^\/api\/admin(\/|$)/, /^\/api\/leads(\/|$)/, /^\/api\/campaigns(\/|$)/];
/** Under an admin prefix but not the panel: the public ticket inventory (the website's Tickets page). */
const PUBLIC_UNDER_ADMIN = new Set(["get /api/admin/inventory/public"]);
/** Under /api/console but an in-app feature (app rights, any sign-in): Help & SOS responders. A volunteer without the
    moderate right (the default) is refused there too, by that router's own check. */
const IN_APP_UNDER_CONSOLE = [/^\/api\/console\/sos(\/|$)/];
/** The volunteer panel: the only admin routes a volunteer's token opens. */
const ALLOW = new Set(["get /api/console/me", "get /api/console/search", "post /api/console/search", "get /api/console/people/", "get /api/console/people/:id"]);

function guardOf(fn) {
  if (typeof fn !== "function") return false;
  if ([adminAuth.requireAdmin, adminAuth.requireManagementAdmin, adminAuth.requireManagement].includes(fn)) return true;
  return /\brequire(Admin|ManagementAdmin)\s*\(/.test(Function.prototype.toString.call(fn));
}
const joinPath = (a, b) => (`${a}/${b}`).replace(/\/+/g, "/");

/** Every route of the app: { method, path, guarded, chain }. And every middleware layer's name (for the kill switch check). */
function routesOf(appInstance) {
  const routes = [];
  const middleware = [];
  const walk = (stack, prefix, guards) => {
    const mine = [...guards];
    for (const layer of stack) {
      const mount = layer.__mount && layer.__mount !== "/" ? String(layer.__mount) : "";
      if (layer.route) {
        const handlers = layer.route.stack.map((l) => l.handle);
        const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
        const methods = Object.keys(layer.route.methods);
        for (const p of paths) {
          const full = joinPath(prefix, p) || "/";
          const guarded = mine.some((g) => full.startsWith(g.prefix) && g.guard) || handlers.some(guardOf);
          for (const m of methods.includes("_all") ? ["get", "post", "put", "patch", "delete"] : methods) {
            if (m === "head" && methods.includes("get")) continue;
            routes.push({ method: m, path: full, guarded });
          }
        }
      } else if (layer.handle?.stack) {
        walk(layer.handle.stack, joinPath(prefix, mount), mine);
      } else {
        middleware.push({ name: layer.name, path: joinPath(prefix, mount) });
        mine.push({ prefix: joinPath(prefix, mount), guard: guardOf(layer.handle) });
      }
    }
  };
  walk(appInstance.router.stack, "", []);
  return { routes, middleware };
}
const SAMPLE_ID = "64b000000000000000000001";
const concrete = (p) => p.replace(/\{[^}]*\}/g, "").replace(/:[A-Za-z_][A-Za-z0-9_]*/g, SAMPLE_ID).replace(/\*[A-Za-z_][A-Za-z0-9_]*/g, "x") || "/";
const key = (r) => `${r.method} ${r.path}`;
const adminSurface = (r) => ADMIN_PREFIXES.some((rx) => rx.test(r.path)) || r.guarded;

test("the route sweep: every admin route but the volunteer panel's answers a volunteer 403 volunteer_forbidden", { skip }, async () => {
  const { routes, middleware } = routesOf(app);
  const admin = routes.filter(adminSurface);
  // The walk saw the whole app (not a broken walk that passes by finding nothing).
  assert.ok(routes.length > 400, `routes found: ${routes.length}`);
  assert.ok(admin.length > 250, `admin routes found: ${admin.length}`);
  const keys = new Set(admin.map(key));
  // What the organiser named: financials, tickets sold, website permissions, campaigns, inventory, coupon codes, staff,
  // content, settings, audit, leads, the kill switch.
  for (const k of [
    "get /api/console/sales", "get /api/admin/analytics", "get /api/console/tickets", "get /api/console/tickets/export",
    "get /api/console/app-rights", "put /api/console/app-rights", "get /api/campaigns/", "post /api/campaigns/:id/launch",
    "post /api/console/attending-campaign/send-all", "get /api/admin/inventory", "put /api/admin/inventory/:tier", "post /api/console/inventory/recount",
    "get /api/admin/promos", "post /api/admin/promos", "get /api/console/staff", "post /api/console/staff", "get /api/console/audit",
    "get /api/console/app-content", "put /api/console/app-content/:key", "get /api/cms/:type", "post /api/cms/upload-file",
    "get /api/leads/", "get /api/kyc/", "post /api/intel/refresh", "get /api/subscriptions/stats", "get /api/console/kill-switch", "post /api/console/kill-switch",
    "get /api/console/people/export", "post /api/console/people/reminder", "post /api/console/people/nudge", "patch /api/console/people/:id",
    "delete /api/console/people/:id", "post /api/console/companies/logo", "get /api/console/digest/", "get /api/console/waitlist/",
  ]) assert.ok(keys.has(k), `missing from the sweep: ${k}`);
  for (const k of ALLOW) assert.ok(keys.has(k), `allow-list route missing: ${k}`);

  const failures = [];
  let swept = 0;
  for (const r of admin) {
    if (ALLOW.has(key(r)) || PUBLIC_UNDER_ADMIN.has(key(r))) continue;
    const res = await call(r.method.toUpperCase(), concrete(r.path), { token: T.val, body: {} });
    swept += 1;
    if (IN_APP_UNDER_CONSOLE.some((rx) => rx.test(r.path))) {
      if (res.status !== 403) failures.push(`${key(r)} → ${res.status} (in-app, expected 403)`);
      continue;
    }
    // Outside the admin paths, a route behind requireAdmin may have an in-app guard first (an app feature with one
    // staff-only action): 403 whichever refuses. Under the admin paths: always the volunteer's own answer.
    const prefixed = ADMIN_PREFIXES.some((rx) => rx.test(r.path));
    if (prefixed ? !isForbidden(res) : res.status !== 403) failures.push(`${key(r)} → ${res.status} ${res.text.slice(0, 80)}`);
  }
  assert.deepEqual(failures, []);
  assert.ok(swept > 250, `swept ${swept}`);
  // The public inventory stays public (and is the same for a volunteer as for nobody).
  for (const k of PUBLIC_UNDER_ADMIN) {
    const [m, p] = k.split(" ");
    const [anon, vol] = [await call(m.toUpperCase(), p), await call(m.toUpperCase(), p, { token: T.val })];
    assert.equal(anon.status, 200, k);
    assert.deepEqual(vol.body, anon.body, k);
  }
  // An address no route has under the console: still the volunteer's 403, not a 404 that says what exists.
  assert.ok(isForbidden(await call("GET", "/api/console/no-such-page", { token: T.val })));
  assert.ok(isForbidden(await call("POST", "/api/console/maintenance", { token: T.val, body: { enabled: true } })));

  // Nothing named kill or maintenance answers data or changes anything: the only such route is the gone kill switch.
  const killish = routes.filter((r) => /kill|maintenance/i.test(r.path));
  assert.deepEqual([...new Set(killish.map((r) => r.path))], ["/api/console/kill-switch"]);
  assert.deepEqual(middleware.filter((m) => /kill|maintenance/i.test(m.name)), [], "no kill switch middleware");
  const before = await M.AppContent.findOne({ key: "site.kill" }).lean();
  for (const r of killish) {
    for (const [who, token] of [["volunteer", T.val], ["staff", T.sam], ["management", T.mia], ["nobody", null]]) {
      const res = await call(r.method.toUpperCase(), r.path, { token, body: { enabled: r.method === "post" ? false : undefined, password: "a long enough passphrase", message: "x" } });
      if (who === "volunteer") assert.ok(isForbidden(res), `${key(r)} ${who}`);
      else if (who === "nobody") assert.equal(res.status, 401, `${key(r)} ${who}`);
      else {
        assert.equal(res.status, 410, `${key(r)} ${who}`);
        assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"], `${key(r)} ${who}`);
        assert.equal(res.body.code, "kill_switch_removed");
      }
    }
  }
  const after_ = await M.AppContent.findOne({ key: "site.kill" }).lean();
  assert.deepEqual(after_.value, before.value, "the old row is untouched");
  assert.equal(await M.AdminAudit.countDocuments({ action: /^kill_switch/ }), 0, "nothing switched on or off");
  assert.deepEqual(outside, []);
});

/* ---------- what a volunteer sees ---------- */

function keysOf(v, out = new Set()) {
  if (Array.isArray(v)) for (const x of v) keysOf(x, out);
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.add(k); keysOf(x, out); }
  return out;
}
const FORBIDDEN_KEY = /email|phone|linkedin|ticketid|stripe|promo|coupon|^code$|value|price|engagement|attending|rsvpemail|note|audit|manual|hidden|contact|outreach|qr|userid|account|refund|paid|source|^edit$|apphide|reminder|nudge|catalog|stripe|staffrole|ismanagement/i;
function assertSafe(json, label) {
  const bad = [...keysOf(json)].filter((k) => FORBIDDEN_KEY.test(k) && k !== "dietaryOther");
  assert.deepEqual(bad, [], `${label}: forbidden keys`);
  const text = JSON.stringify(json).toLowerCase();
  for (const [name, secret] of Object.entries(SECRETS)) assert.ok(!text.includes(String(secret).toLowerCase()), `${label}: ${name} leaked`);
  for (const amount of AMOUNTS) assert.ok(!text.includes(amount), `${label}: ${amount}`);
}

test("a volunteer's People list, profiles and search: only the safe fields, nothing financial, no contact details, no ticket IDs", { skip }, async () => {
  const me = await call("GET", "/api/console/me", { token: T.val });
  assert.equal(me.status, 200);
  assert.deepEqual([me.body.staffRole, me.body.panelRole, me.body.isManagement], ["volunteer", "volunteer", false]);
  const authMe = await call("GET", "/api/auth/me", { token: T.val });
  assert.equal(authMe.status, 200);
  assert.equal(authMe.body.role, "volunteer");

  const list = await call("GET", "/api/console/people", { token: T.val });
  assert.equal(list.status, 200);
  assert.equal(list.body.volunteer, true);
  assert.equal(list.body.banner, "Volunteer view: look-up only");
  assert.equal(list.body.size, 50);
  assert.ok(list.body.total >= 10, `total ${list.body.total}`);
  assert.equal(list.headers.get("cache-control"), "no-store");
  assertSafe(list.body, "list");
  const mara = list.body.rows.find((r) => r.name === "Mara Delegate");
  assert.deepEqual([mara.company, mara.jobTitle, mara.vip, mara.pass.label, mara.pass.pending, mara.checkedIn], ["Example Bank", "Head of Digital", true, "Power Pass", false, true]);
  assert.deepEqual(mara.pass.extras, { cxo: true, lunch: true, gala: true, awards: true });
  assert.deepEqual(mara.rsvp.days, ["day1", "day2"]);

  // Every profile in the directory, and by the ticket-ID link (t-…): safe.
  for (const row of list.body.rows) {
    const prof = await call("GET", `/api/console/people/${encodeURIComponent(row.id)}`, { token: T.val });
    assert.equal(prof.status, 200, row.id);
    assertSafe(prof.body, `profile ${row.name}`);
  }
  const byTicket = await call("GET", `/api/console/people/t-${SECRETS.ticket}`, { token: T.val });
  assert.equal(byTicket.status, 200);
  assert.equal(byTicket.body.person.name, "Mara Delegate");
  assertSafe(byTicket.body, "profile by ticket");
  const p = byTicket.body.person;
  assert.deepEqual(p.rsvp.events.map((e) => e.key), ["lunch_d1", "awards", "gala"]);
  assert.deepEqual(p.rsvp.dietary, [{ key: "vegan", label: "Vegan" }]);
  assert.equal(p.rsvp.dietaryOther, "No mushrooms");
  assert.equal(p.rsvp.accessibility, true);
  assert.equal(p.checkedIn, true);
  const kai = await call("GET", `/api/console/people/a-${ID.kai}`, { token: T.val });
  assert.equal(kai.status, 200);
  assert.equal(kai.body.person.booth, "B7");
  assert.equal(kai.body.person.pass.pending, true);
  assert.deepEqual(kai.body.person.sessions.map((s) => s.title), ["Quantum Computing in Finance"]);
  assert.equal((await call("GET", "/api/console/people/u-64b0000000000000000000aa", { token: T.val })).status, 404);

  // Search the list: exact email or ticket ID finds them, the answer never repeats it; part of an email finds nobody.
  for (const q of [SECRETS.email, SECRETS.email.toUpperCase(), SECRETS.ticket, `TECHFEST:${SECRETS.ticket.toUpperCase()}`]) {
    const r = await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.val });
    assert.deepEqual(r.body.rows.map((x) => x.name), ["Mara Delegate"], q);
    assertSafe(r.body, `list q=${q}`);
  }
  for (const q of ["mara.secret", "example.com", "beefcafe", SECRETS.code, "4165550199", "cs_test"]) {
    const r = await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.val });
    assert.equal(r.body.total, 0, q);
  }
  assert.deepEqual((await call("GET", "/api/console/people?q=example%20bank", { token: T.val })).body.rows.map((x) => x.name), ["Mara Delegate"]);

  // The search box: People only, safe; an exact email / ticket ID never echoed.
  for (const q of ["mara", SECRETS.email, SECRETS.ticket, SECRETS.guestEmail]) {
    for (const method of ["POST", "GET"]) {
      const r = method === "POST" ? await call("POST", "/api/console/search", { token: T.val, body: { q } })
        : await call("GET", `/api/console/search?q=${encodeURIComponent(q)}`, { token: T.val });
      assert.equal(r.status, 200, `${method} ${q}`);
      assert.deepEqual(r.body.groups.map((g) => g.key), ["people"], `${method} ${q}`);
      assertSafe(r.body, `search ${method} ${q}`);
    }
  }
  const staffSearch = await call("POST", "/api/console/search", { token: T.sam, body: { q: SECRETS.ticket } });
  assert.ok(staffSearch.body.groups.some((g) => g.key === "tickets"), "staff keep the Tickets group");
});

test("a volunteer can't filter or sort by money, codes, RSVP emails or engagement, and can't force a rebuild", { skip }, async () => {
  const get = async (qs) => (await call("GET", `/api/console/people${qs}`, { token: T.val })).body;
  const all = await get("");
  for (const qs of ["?value=above", "?value=below", "?status=paid", "?status=complimentary", "?rsvpEmail=yes", "?rsvpEmail=opened", "?attending=yes",
    "?attending=opened", "?appHidden=yes", "?rsvp=form", "?refresh=1"]) {
    const r = await get(qs);
    assert.equal(r.total, all.total, qs);
  }
  for (const qs of ["?sort=value", "?sort=code", "?sort=status", "?sort=rsvpEmail", "?sort=attending"]) {
    assert.deepEqual((await get(qs)).rows.map((x) => x.id), all.rows.map((x) => x.id), qs);
  }
  assert.deepEqual((await get("?type=speaker")).rows.map((x) => x.name), ["Kai Speaker"]);
  assert.deepEqual((await get("?vip=yes")).rows.map((x) => x.name), ["Mara Delegate"]);
  // Normal pages only: there's no "all" size.
  const big = await get("?size=all&limit=100000&page=0");
  assert.equal(big.size, 50);
});

test("a volunteer can't write anything: every change, send, export, delete and logo upload is refused and nothing changes", { skip }, async () => {
  const id = `u-${ID.mara}`;
  const refused = [
    ["PATCH", `/api/console/people/${id}`, { name: "Changed Name", vip: false }],
    ["PATCH", `/api/console/people/${id}/passes/${SECRETS.ticket}`, { extras: { gala: false } }],
    ["PUT", `/api/console/people/${id}/rsvp`, { days: ["day1"], options: [] }],
    ["DELETE", `/api/console/people/${id}`, { confirmName: "Mara Delegate" }],
    ["POST", `/api/console/people/${id}/reminder`, {}],
    ["POST", `/api/console/people/${id}/nudge`, {}],
    ["POST", `/api/console/people/${id}/app-invite`, {}],
    ["POST", `/api/console/people/${id}/app-hide`, { reason: "x" }],
    ["POST", `/api/console/people/${id}/app-unhide`, {}],
    ["GET", `/api/console/people/${id}/delete-plan`],
    ["POST", "/api/console/people/reminder", { confirm: "SEND", expected: 1 }],
    ["POST", "/api/console/people/nudge", { confirm: "SEND", expected: 1 }],
    ["GET", "/api/console/people/reminder"], ["GET", "/api/console/people/nudge"], ["GET", "/api/console/people/export"],
    ["GET", "/api/console/people/eligible"], ["GET", "/api/console/people/app-hidden"],
    ["GET", "/api/console/companies/candidates?name=Example%20Bank"],
    ["POST", "/api/console/companies/logo", { name: "Example Bank", url: "https://example.com/logo.png" }],
    ["POST", "/api/console/companies/logo/clear", { personId: id }],
    ["HEAD", "/api/console/people"],
    ["POST", "/api/console/people", {}], ["PUT", `/api/console/people/${id}`, {}],
    ["POST", "/api/console/me/password", { current: "a long enough passphrase", next: "another long passphrase" }],
    ["PUT", "/api/console/app-content/home.announcement", { value: "Hello from a volunteer" }],
  ];
  for (const [method, url, body] of refused) {
    const r = await call(method, url, { token: T.val, body });
    if (method === "HEAD") assert.equal(r.status, 403, url);
    else assert.ok(isForbidden(r), `${method} ${url} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  const mara = await M.User.findById(ID.mara).lean();
  assert.equal(mara.name, "Mara Delegate");
  assert.equal(mara.vip, true);
  assert.equal(await M.CampaignSend.countDocuments({}), 1);
  assert.equal(await M.AppContent.countDocuments({ key: "home.announcement" }), 0);
  assert.equal(await M.AdminAudit.countDocuments({ adminName: "Val Volunteer" }), 0);
});

test("who gets the panel: a volunteer's password sign-in only; emailed code / pass ID, the volunteer type on an attendee, suspended: no", { skip }, async () => {
  for (const t of [T.valEmail, T.valTicket]) {
    for (const [m, u, b] of [["GET", "/api/console/people"], ["GET", `/api/console/people/u-${ID.mara}`], ["POST", "/api/console/search", { q: "mara" }], ["GET", "/api/console/me"]]) {
      const r = await call(m, u, { token: t, body: b });
      assert.deepEqual([r.status, r.body.code], [403, "password_required"], `${m} ${u}`);
    }
    // Everything else: a volunteer is refused however they signed in.
    assert.ok(isForbidden(await call("GET", "/api/console/stats", { token: t })));
  }
  for (const [m, u, b] of [["GET", "/api/console/people"], ["GET", `/api/console/people/u-${ID.mara}`], ["POST", "/api/console/search", { q: "mara" }], ["GET", "/api/console/me"]]) {
    const vic = await call(m, u, { token: T.vic, body: b });
    assert.deepEqual([vic.status, vic.body.error], [403, "Admin only"], `type-only volunteer ${m} ${u}`);
    const att = await call(m, u, { token: T.mara, body: b });
    assert.equal(att.status, 403, `attendee ${m} ${u}`);
    const ban = await call(m, u, { token: T.ban, body: b });
    assert.deepEqual([ban.status, ban.body.code], [403, "suspended"], `banned ${m} ${u}`);
    assert.equal((await call(m, u, { body: b })).status, 401, `nobody ${m} ${u}`);
    assert.equal((await call(m, u, { token: "not.a.token", body: b })).status, 401, `bad token ${m} ${u}`);
  }
  assert.deepEqual([(await call("GET", "/api/console/stats", { token: T.vic })).body.error], ["Admin only"]);
  // Staff signed in with an emailed code: unchanged (password_required).
  const { default: jwt } = await import("jsonwebtoken");
  const samEmail = jwt.sign({ id: String(ID.sam), via: "email" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  for (const u of ["/api/console/people", "/api/console/stats"]) {
    const r = await call("GET", u, { token: samEmail });
    assert.deepEqual([r.status, r.body.code], [403, "password_required"], u);
  }
});

test("staff and management: People, the profile and the search exactly as before", { skip }, async () => {
  const id = `u-${ID.mara}`;
  for (const [who, t] of [["staff", T.sam], ["management", T.mia]]) {
    const list = await call("GET", "/api/console/people", { token: t });
    assert.equal(list.status, 200, who);
    assert.equal(list.body.volunteer, undefined);
    const row = list.body.rows.find((r) => r.name === "Mara Delegate");
    assert.equal(row.email, SECRETS.email, who);
    assert.equal(row.pass.ticketId, SECRETS.ticket, who);
    assert.equal(row.pass.code.code, SECRETS.code, who);
    assert.ok("rsvpEmail" in row && "engagement" in row && "attending" in row && "valueBand" in row, who);
    assert.ok("byValue" in list.body.counts && "rsvpEmailSent" in list.body.counts, who);
    assert.equal(list.body.stripe, "off");
    const prof = await call("GET", `/api/console/people/${id}`, { token: t });
    assert.equal(prof.status, 200, who);
    assert.ok(prof.body.contactCard.some((c) => c.value.includes(SECRETS.contactPhone)), who);
    assert.ok(prof.body.outreach && prof.body.appHide && prof.body.person.edit, who);
    assert.equal(prof.body.person.appHidden.reason, SECRETS.hideReason, who);
    const me = await call("GET", "/api/console/me", { token: t });
    assert.deepEqual(Object.keys(me.body).sort(), ["email", "id", "isManagement", "name", "staffRole"], who);
    assert.equal(me.body.staffRole, who);
    assert.equal((await call("GET", "/api/console/stats", { token: t })).status, 200, who);
  }
  const omar = await call("GET", `/api/console/people/a-${ID.omar}`, { token: T.mia });
  assert.equal(omar.body.person.passes[0].manualValue, 1234.56, "management still sees the manual value");
  const omarStaff = await call("GET", `/api/console/people/a-${ID.omar}`, { token: T.sam });
  assert.equal(omarStaff.body.person.passes[0].manualValue, undefined, "staff still don't");
  const csv = await call("GET", "/api/console/people/export", { token: T.mia });
  assert.equal(csv.status, 200);
  assert.match(csv.text, /mara\.secret@example\.com/);
  assert.equal((await call("GET", "/api/console/people/export", { token: T.sam })).status, 403, "the CSV stays management's");
});

test("a volunteer's reads are limited: 120 a minute per account", { skip }, async () => {
  let ok = 0;
  for (let i = 0; i < 120; i++) {
    const r = await call("GET", i % 2 ? "/api/console/people" : `/api/console/people/u-${ID.mara}`, { token: T.rae });
    if (r.status === 200) ok += 1;
  }
  assert.equal(ok, 120);
  const r = await call("GET", "/api/console/people", { token: T.rae });
  assert.deepEqual([r.status, r.body.code], [429, "rate_limited"]);
  // Another volunteer, and staff, aren't held up.
  assert.equal((await call("GET", "/api/console/people", { token: T.val })).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call("GET", "/api/console/people", { token: T.sam })).status, 200);
});

test("the kill switch is gone: the site is always live, whatever the old row says, and its key can't be written", { skip }, async () => {
  const row = await M.AppContent.findOne({ key: "site.kill" }).lean();
  assert.equal(row.value.enabled, true, "the old row says ON");
  const status = await call("GET", "/api/status");
  assert.deepEqual([status.status, status.body], [200, { live: true, message: "" }]);
  for (const t of [T.val, T.sam, T.mara]) assert.deepEqual((await call("GET", "/api/status", { token: t })).body, { live: true, message: "" });
  // The public site and the apps keep working (no 503 maintenance anywhere).
  assert.equal((await call("GET", "/api/rsvp/options")).status, 200);
  assert.equal((await call("GET", "/api/app/content")).status, 200);
  assert.equal((await call("GET", "/api/social/feed", { token: T.mara })).status === 503, false);

  for (const [who, t] of [["management", T.mia], ["staff", T.sam]]) {
    for (const k of ["site.kill", "SITE.KILL"]) {
      const r = await call("PUT", `/api/console/app-content/${k}`, { token: t, body: { value: { enabled: false } } });
      assert.deepEqual([r.status, r.body.code], [410, "kill_switch_removed"], `${who} ${k}`);
    }
    for (const m of ["GET", "POST", "PUT", "DELETE"]) {
      const r = await call(m, "/api/console/kill-switch", { token: t, body: { enabled: true, password: "a long enough passphrase" } });
      assert.deepEqual([r.status, r.body.code], [410, "kill_switch_removed"], `${who} ${m}`);
    }
  }
  assert.ok(isForbidden(await call("PUT", "/api/console/app-content/site.kill", { token: T.val, body: { value: { enabled: true } } })));
  const after_ = await M.AppContent.findOne({ key: "site.kill" }).lean();
  assert.deepEqual(after_.value, row.value);
  // The texts and switches page doesn't list it.
  const content = await call("GET", "/api/console/app-content", { token: T.mia });
  assert.ok(!content.body.some((c) => c.key === "site.kill"));
  // Refusals are audited (who tried), never a switch.
  assert.ok(await M.AdminAudit.countDocuments({ action: "edit_app_text_refused", detail: "kill_switch_removed" }) >= 4);
  assert.equal(await M.AdminAudit.countDocuments({ action: /^kill_switch/ }), 0);
});

test("free text typed with contact details: a name that is an email, a staff account named after its email, an email or phone in the company / title / dietary note", { skip }, async () => {
  // The stored name of the staff account is the email's local part (POST /staff's default): staff still see it.
  assert.equal((await M.User.findById(ID.noname).lean()).name, SECRETS.staffLocal);
  const staffList = await call("GET", "/api/console/people?q=noname", { token: T.sam });
  assert.deepEqual(staffList.body.rows.map((r) => r.name), [SECRETS.staffLocal], "staff unchanged");
  const staffYara = await call("GET", `/api/console/people/t-${SECRETS.yaraTicket}`, { token: T.sam });
  assert.equal(staffYara.body.person.name, SECRETS.yaraEmail, "staff unchanged");

  // The testers' requests, as a volunteer.
  for (const q of ["example.com", "@example.com", "yara", "yara.leak", "noname", "staffer", "leakmail", "647", "555-0188"]) {
    const r = await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.val });
    assert.deepEqual([r.status, r.body.total], [200, 0], `list q=${q}`);
    const s1 = await call("POST", "/api/console/search", { token: T.val, body: { q } });
    assert.deepEqual(s1.body.groups, [], `search q=${q}`);
    const s2 = await call("GET", `/api/console/search?q=${encodeURIComponent(q)}`, { token: T.val });
    assert.deepEqual(s2.body.groups, [], `search GET q=${q}`);
  }
  const yara = await call("GET", `/api/console/people/t-${SECRETS.yaraTicket}`, { token: T.val });
  assert.equal(yara.status, 200);
  assert.equal(yara.body.person.name, "No name");
  assert.equal(yara.body.person.pass.label, "Connect Pass");
  assert.deepEqual(yara.body.person.rsvp.dietary, [{ key: "other", label: "Other" }]);
  assert.equal(yara.body.person.rsvp.dietaryOther, "Nut allergy, call [hidden] or [hidden]");
  assertSafe(yara.body, "profile t-yara");
  const noname = await call("GET", `/api/console/people/u-${ID.noname}`, { token: T.val });
  assert.deepEqual([noname.status, noname.body.person.name, noname.body.person.types], [200, "No name", ["staff"]]);
  assertSafe(noname.body, "profile noname");
  const lee = await call("GET", "/api/console/people?q=lee%20leaky", { token: T.val });
  assert.deepEqual(lee.body.rows.map((r) => [r.name, r.company, r.jobTitle]), [["Lee Leaky", "Contact [hidden]", "CTO, [hidden]"]]);
  assertSafe(lee.body, "list lee");

  // An exact email still finds the person (the help desk), never echoed: not in query.text, not in the title.
  for (const [q, id] of [[SECRETS.yaraEmail, yara.body.canonicalId], [SECRETS.staffEmail, `u-${ID.noname}`], [SECRETS.yaraTicket, yara.body.canonicalId]]) {
    for (const r of [await call("POST", "/api/console/search", { token: T.val, body: { q } }), await call("GET", `/api/console/search?q=${encodeURIComponent(q)}`, { token: T.val })]) {
      assert.equal(r.status, 200, q);
      assert.equal(r.body.query.text, "", q);
      const item = r.body.groups[0].items[0];
      assert.deepEqual([item.id, item.title, item.exact], [id, "No name", true], q);
      assertSafe(r.body, `search ${q}`);
    }
    const l = await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.val });
    assert.deepEqual(l.body.rows.map((r) => [r.id, r.name]), [[id, "No name"]], q);
    assertSafe(l.body, `list ${q}`);
  }
  const staffHit = await call("POST", "/api/console/search", { token: T.val, body: { q: SECRETS.staffEmail } });
  assert.deepEqual([staffHit.body.groups[0].items[0].subtitle, staffHit.body.groups[0].items[0].badges], ["Account, no pass", ["Staff"]]);

  // "No name" sorts with the blanks (last), whatever the hidden name was.
  const all = await call("GET", "/api/console/people?sort=name", { token: T.val });
  const names = all.body.rows.map((r) => r.name);
  const firstNoName = names.indexOf("No name");
  assert.ok(firstNoName > 0 && names.slice(firstNoName).every((n) => n === "No name"), names.join(" | "));
  assertSafe(all.body, "list sorted");
});

test("the profile's shape, as the website reads it (person.rsvp.events / dietary / dietaryOther / accessibility, person.sessions)", { skip }, async () => {
  const mara = (await call("GET", `/api/console/people/t-${SECRETS.ticket}`, { token: T.val })).body;
  assert.deepEqual(Object.keys(mara).sort(), ["banner", "canonicalId", "extras", "filters", "person", "sorts", "volunteer"]);
  assert.deepEqual(Object.keys(mara.person.rsvp).sort(), ["accessibility", "dayLabels", "days", "dietary", "dietaryOther", "events", "label", "status"]);
  assert.deepEqual(mara.person.rsvp.events.map((e) => Object.keys(e).sort()), Array(3).fill(["day", "key", "label", "time"]));
  assert.deepEqual(mara.person.rsvp.dietary, [{ key: "vegan", label: "Vegan" }]);
  assert.deepEqual([mara.person.rsvp.dietaryOther, mara.person.rsvp.accessibility], ["No mushrooms", true]);
  const kai = (await call("GET", `/api/console/people/a-${ID.kai}`, { token: T.val })).body;
  assert.deepEqual(kai.person.sessions, [{ day: 1, start: "10:00", end: "10:30", title: "Quantum Computing in Finance", format: "Panel", role: "Panellist" }]);
});

/* ---------- The third round ---------- */

test("a hyphen in an email, a booth order and a hyphenated ticket ID never break a volunteer's list, profiles or search", { skip }, async () => {
  const list = await call("GET", "/api/console/people?sort=name", { token: T.ivy });
  assert.equal(list.status, 200, list.text.slice(0, 120));
  const mary = list.body.rows.find((r) => r.name === "Mary Jane");
  assert.ok(mary, list.body.rows.map((r) => r.name).join(" | "));
  assert.equal(mary.company, "Ask for [hidden] at the desk");
  assert.ok(list.body.rows.some((r) => r.name === "Ann-Marie D'Arcy"));
  assertSafe(list.body, "list with odd data");
  for (const sort of ["company", "type", "pass"]) assert.equal((await call("GET", `/api/console/people?sort=${sort}&dir=desc`, { token: T.ivy })).status, 200, sort);
  for (const id of [`t-${SECRETS.maryTicket}`, `t-${SECRETS.annTicket}`, mary.id]) {
    const prof = await call("GET", `/api/console/people/${encodeURIComponent(id)}`, { token: T.ivy });
    assert.equal(prof.status, 200, `${id} ${prof.text.slice(0, 120)}`);
    assertSafe(prof.body, `profile ${id}`);
  }
  const ann = await call("GET", `/api/console/people/t-${SECRETS.annTicket}`, { token: T.ivy });
  assert.equal(ann.body.person.pass.printedLabel, "Guest [hidden]");
  // The list's search and the search box answer (the People group used to come back failed).
  assert.deepEqual((await call("GET", "/api/console/people?q=mary", { token: T.ivy })).body.rows.map((r) => r.name), ["Mary Jane"]);
  for (const r of [await call("POST", "/api/console/search", { token: T.ivy, body: { q: "mary" } }), await call("GET", "/api/console/search?q=jane", { token: T.ivy })]) {
    assert.deepEqual([r.status, r.body.failed, r.body.groups.map((g) => g.key)], [200, [], ["people"]]);
    assertSafe(r.body, "search mary");
  }
  // Exact look-ups still find them, never echoed.
  for (const q of [SECRETS.maryEmail, SECRETS.maryTicket, SECRETS.booth, SECRETS.annTicket, SECRETS.annEmail]) {
    const r = await call("POST", "/api/console/search", { token: T.ivy, body: { q } });
    assert.deepEqual([r.status, r.body.failed, r.body.query.text, r.body.groups[0]?.items[0]?.exact], [200, [], "", true], q);
    assertSafe(r.body, `search ${q}`);
    const l = await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.ivy });
    assert.deepEqual([l.status, l.body.total], [200, 1], q);
  }
});

test("LinkedIn addresses, Stripe IDs, coupon codes and written-out emails typed into free text never reach a volunteer", { skip }, async () => {
  const get = async (q) => (await call("GET", `/api/console/people?q=${encodeURIComponent(q)}`, { token: T.ivy })).body;
  const olga = (await get("olga")).rows;
  assert.deepEqual(olga.map((r) => [r.name, r.company, r.jobTitle]), [["Olga Linked", "", ""]]);
  assert.deepEqual((await get("tia")).rows.map((r) => r.jobTitle), ["Order [hidden]"]);
  assert.deepEqual((await get("priya")).rows.map((r) => r.name), ["Priya"]);
  const pia = (await get("pia partner")).rows[0];
  assert.equal(pia.pass.printedLabel, "Partner [hidden]");
  assert.equal(pia.jobTitle, "Speaker, Exhibitor lead", "the internal markers never hide words");
  const piaProf = await call("GET", `/api/console/people/t-${SECRETS.piaTicket}`, { token: T.ivy });
  assert.equal(piaProf.body.person.passes[0].printedLabel, "Partner [hidden]");
  assert.equal(piaProf.body.person.rsvp.dietaryOther, "No nuts. Code [hidden]");
  assertSafe(piaProf.body, "profile pia");
  // None of them finds anybody by the hidden text.
  for (const q of ["linkedin", SECRETS.olgaSlug, "olga-secret", "cs_test_secretsession", "secretsession", SECRETS.code, "secretcode20", "priyamail", SECRETS.priyaLocal, "x9secret"]) {
    assert.equal((await get(q)).total, 0, q);
    const s = await call("POST", "/api/console/search", { token: T.ivy, body: { q } });
    assert.deepEqual(s.body.groups, [], `search ${q}`);
  }
  for (const q of ["olga", "tia", "priya", "pia"]) {
    const s = await call("POST", "/api/console/search", { token: T.ivy, body: { q } });
    assert.equal(s.body.groups[0].items.length, 1, q);
    assertSafe(s.body, `search ${q}`);
  }
  // Staff see what was typed, as before.
  const staffOlga = await call("GET", "/api/console/people?q=olga", { token: T.sam });
  assert.equal(staffOlga.body.rows[0].jobTitle, `https://www.linkedin.com/in/${SECRETS.olgaSlug}/`);
});

const decode = (t) => JSON.parse(Buffer.from(t.split(".")[1], "base64url").toString("utf8"));
const PANEL = [["GET", "/api/console/me"], ["GET", "/api/console/people"], ["GET", "/api/console/people/u-"], ["POST", "/api/console/search", { q: "mara" }], ["GET", "/api/console/search?q=mara"]];
async function linkedinSignIn(email) {
  const r = await realFetch(`${base}/api/auth/linkedin/callback?code=${encodeURIComponent(email)}&state=0123456789abcdef`, { redirect: "manual" });
  const to = r.headers.get("location") || "";
  assert.equal(r.status, 302, to);
  assert.match(to, /^https:\/\/site\.example\.test\/auth-success\?token=/);
  return to.split("token=")[1];
}

test("a volunteer's Google or LinkedIn sign-in doesn't open the panel (403 password_required); their password does; staff's Google works as before", { skip }, async () => {
  const google = await call("POST", "/api/auth/google", { body: { credential: "google:gina.volunteer@example.com" } });
  assert.equal(google.status, 200, google.text);
  assert.equal(decode(google.body.token).via, "google");
  const linkedin = await linkedinSignIn("gina.volunteer@example.com");
  assert.equal(decode(linkedin).via, "linkedin");
  // A refreshed token keeps how they signed in.
  const refreshed = await call("POST", "/api/auth/refresh", { token: google.body.token });
  assert.equal(decode(refreshed.body.token).via, "google");
  const refreshedLi = await call("POST", "/api/auth/refresh", { token: linkedin });
  assert.equal(decode(refreshedLi.body.token).via, "linkedin");
  for (const token of [google.body.token, linkedin, refreshed.body.token, refreshedLi.body.token]) {
    for (const [m, u, b] of PANEL) {
      const r = await call(m, u === "/api/console/people/u-" ? `${u}${ID.mara}` : u, { token, body: b });
      assert.deepEqual([r.status, r.body.code], [403, "password_required"], `${decode(token).via} ${m} ${u}`);
    }
    assert.ok(isForbidden(await call("GET", "/api/console/stats", { token })), "everything else: the volunteer's own refusal");
  }
  // An account without a password: even a token from before the claim existed can't be a password sign-in.
  for (const [m, u, b] of PANEL) {
    const r = await call(m, u === "/api/console/people/u-" ? `${u}${ID.mara}` : u, { token: T.nellOld, body: b });
    assert.deepEqual([r.status, r.body.code], [403, "password_required"], `no password ${m} ${u}`);
  }
  // Their password sign-in, the real way: the panel opens.
  const login = await call("POST", "/api/auth/login", { body: { email: "gina.volunteer@example.com", password: "a long enough passphrase" } });
  assert.equal(login.status, 200, login.text);
  assert.equal(decode(login.body.token).via, undefined);
  for (const [m, u, b] of PANEL) {
    const r = await call(m, u === "/api/console/people/u-" ? `${u}${ID.mara}` : u, { token: login.body.token, body: b });
    assert.equal(r.status, 200, `password ${m} ${u}`);
  }
  assert.equal((await call("GET", "/api/console/people", { token: T.ginaOld })).status, 200, "an older password token");

  // Staff: Google and LinkedIn open the panel and the staff-only pages exactly as before.
  const samGoogle = await call("POST", "/api/auth/google", { body: { credential: "google:sam.staff@example.com" } });
  assert.equal(decode(samGoogle.body.token).via, "google");
  const samLinkedin = await linkedinSignIn("sam.staff@example.com");
  for (const token of [samGoogle.body.token, samLinkedin]) {
    const list = await call("GET", "/api/console/people", { token });
    assert.deepEqual([list.status, list.body.volunteer], [200, undefined]);
    assert.equal((await call("GET", "/api/console/stats", { token })).status, 200);
    assert.equal((await call("GET", "/api/console/me", { token })).body.staffRole, "staff");
  }
  // The emailed code is still refused for staff.
  const { default: jwt } = await import("jsonwebtoken");
  const samEmail = jwt.sign({ id: String(ID.sam), role: "admin", via: "email" }, process.env.JWT_SECRET, { expiresIn: "1h" });
  assert.equal((await call("GET", "/api/console/people", { token: samEmail })).body.code, "password_required");
  assert.deepEqual(outside, [], "nothing left the machine");
});
