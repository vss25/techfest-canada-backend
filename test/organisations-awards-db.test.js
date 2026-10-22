/* The apps' organisations list and the Catalyst Awards applications (Oct 21 2026), through the real routes, against
   a real (throwaway) MongoDB. The CMS (Sanity) is a stubbed fetch, the automatic logo search a stubbed fetcher that
   answers from a table (never the internet), logos are stored in the database (no Cloudinary or Sanity token).
   Starts a local mongod in a temp folder on a free port and stops it after; skipped when the binary isn't there
   (TTFC_TEST_MONGOD, else ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people and companies;
   their work domains are made up and only ever answered by the stub. */
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
for (const k of ["STRIPE_SECRET_KEY", "FCM_SERVICE_ACCOUNT", "APNS_KEY", "DEEPCLEER_ACCESS_KEY", "CLOUDINARY_CLOUD_NAME", "CLOUDINARY_API_KEY",
  "CLOUDINARY_API_SECRET", "SANITY_WRITE_TOKEN", "API_URL"]) delete process.env[k];

const CDN = "https://cdn.sanity.io/images/021qtoci/production";
const CMS = {
  partners: [
    { _id: "82f1d0a0-0167-479a-94e3-4b9ffeefb24d", name: "dell", category: "corporateEnterprisePartners", order: 2, logo: `${CDN}/dell.png`, website: "https://www.dell.com", logoScale: 120, description: "Servers and AI factories." },
    { _id: "p-ibm", name: "IBM", displayName: "IBM", category: "corporateEnterprisePartners", order: 4, logo: `${CDN}/ibm.png`, matrixGroup: "quantum" },
    { _id: "p-hidden", name: "Quiet Partner", displayName: "Quiet Partner", category: "partnersAndSupporters", logo: `${CDN}/quiet.png`, showInApp: false },
  ],
  logos: [],
  speakers: [{ _id: "s1", name: "Ada Speaker", company: "IBM" }, { _id: "s2", name: "Bo Talker", company: "Fabrikam AI" }],
};
const realFetch = globalThis.fetch;
const sanityCalls = [];
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    sanityCalls.push(url);
    const result = decodeURIComponent(url).includes('"partners"') ? CMS : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked in the test: ${url}`);
};

/* The logo search's internet, as a table. */
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const lookups = [];
let slowMs = 0;
let slowFirstMs = 0;   // only the next call is slow
const WEB = {
  "https://fabrikam-ai.ca/": { contentType: "text/html", body: Buffer.from('<html><head><link rel="apple-touch-icon" sizes="180x180" href="/touch.png"></head></html>') },
  "https://fabrikam-ai.ca/touch.png": { contentType: "image/png", body: png(180, 180) },
};
async function fakeFetcher(url, { kind } = {}) {
  lookups.push(url);
  if (slowFirstMs) { const ms = slowFirstMs; slowFirstMs = 0; await new Promise((r) => setTimeout(r, ms)); }
  if (slowMs) await new Promise((r) => setTimeout(r, slowMs));
  const hit = WEB[url];
  if (!hit) { const e = new Error("The site answered 404"); e.code = "ESTATUS"; throw e; }
  if (kind === "image" && !hit.contentType.startsWith("image/")) { const e = new Error("Not an image"); e.code = "ETYPE"; throw e; }
  return { url, status: 200, contentType: hit.contentType, body: hit.body };
}

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let jwt;
let mongoose;
let ORG;
let forgetAwards;
const M = {};
const U = {};

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-orgs-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_orgs_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  ORG = await import("../services/organisations.js");
  ORG.configureAutoLogo({ enabled: false, fetcher: fakeFetcher, gapMs: 0, reset: true, log: { error() {} } });   // on in its own tests
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Company = await imp("../models/Company.js");
  M.CompanyLogo = await imp("../models/CompanyLogo.js");
  M.OrgSetting = await imp("../models/OrgSetting.js");
  M.Nomination = await imp("../models/Nomination.js");
  Object.assign(M, await import("../models/Admin.js"));
  await Promise.all([M.Company.init(), M.OrgSetting.init(), M.CompanyLogo.init()]);
  const routes = await import("../routes/appOrganisations.js");
  const awards = await import("../routes/appAwards.js");
  forgetAwards = awards.forgetAwardApplications;
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app", routes.appOrganisationsRouter);
  app.use("/api/app", awards.default);
  app.use("/api/console/organisations", routes.consoleOrganisationsRouter);
  app.use("/api/console/companies", (await import("../routes/people.js")).companiesRouter);
  app.use("/api/console", await imp("../routes/console.js"));
  app.use("/api/social", await imp("../routes/social.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const t = (id, extra = {}) => [{ ticketId: id, type: "connect", purchaseDate: new Date("2026-10-01"), ...extra }];
  const onApp = { appOnboarded: true, lastActiveAt: new Date("2026-10-20T12:00:00Z") };
  const mk = (key, doc) => M.User.create({ ...onApp, ...doc }).then((u) => { U[key] = u; });
  await Promise.all([
    mk("mia", { name: "Mia Manager", email: "mia.manager@thetechfestival.com", role: "admin", staffRole: "management" }),
    mk("ann", { name: "Ann Attendee", email: "ann@woodgrove-bank.ca", organization: "Woodgrove Bank", tickets: t("con700000001") }),
    mk("bo", { name: "Bo Builder", email: "bo@fabrikam-ai.ca", organization: "Fabrikam AI", tickets: t("con700000002") }),
    mk("dan", { name: "Dan Dell", email: "dan@gmail.com", organization: "Dell", tickets: t("con700000003") }),
    mk("ian", { name: "Ian Consultant", email: "ian@consulting-ibm.example", organization: "IBM Consulting", tickets: t("con700000004") }),
    mk("ben", { name: "Ben Banned", email: "ben@bannedco.ca", organization: "Banned Co", banned: true, tickets: t("con700000005") }),
    mk("eve", { name: "Eve Hidden", email: "eve@shadowco.ca", organization: "Shadow Co", tickets: t("con700000006"), appHidden: { at: new Date("2026-10-20T10:00:00Z"), byName: "Mia Manager" } }),
    mk("fay", { name: "Fay Quiet", email: "fay@quietco.ca", organization: "Quiet Co", directoryHidden: true, tickets: t("con700000007") }),
    mk("gus", { name: "Gus Student", email: "gus@gmail.com", organization: "Student", tickets: t("con700000008") }),
    mk("hal", { name: "Hal Nopass", email: "hal@nopass.ca", organization: "No Pass Org" }),
    mk("lia", { name: "Lia Litware", email: "lia@litware.ca", organization: "Litware", tickets: t("con700000009") }),
    mk("qui", { name: "Qui Partner", email: "qui@quietpartner.ca", organization: "Quiet Partner", tickets: t("con700000010") }),
    mk("tom", { name: "Tom Test", email: "tom@testco.ca", organization: "Test Ticket Co", tickets: t("con700000011", { hiddenByStaff: true }) }),
  ]);
  (await import("../services/appHide.js")).forgetHidden();
  await M.Attendee.create([
    // Pass-only people: Cy at Fabrikam (two passes, one person), Ann's own unclaimed pass (same email), a booth.
    { name: "Cy Coder", email: "cy@fabrikam-ai.ca", ticketId: "con700000020", ticketType: "connect", details: { organisation: "fabrikam ai" } },
    { name: "Cy Coder", email: "cy@fabrikam-ai.ca", ticketId: "con700000021", ticketType: "influence", details: { organisation: "Fabrikam AI" } },
    { name: "Ann Attendee", email: "ann@woodgrove-bank.ca", ticketId: "con700000022", ticketType: "connect", details: { organisation: "Woodgrove Bank" } },
    { name: "Booth Person", email: "booth@boothco.ca", ticketId: "BOOTH-STANDARD-1", ticketType: "booth-standard", details: { organisation: "Booth Co" } },
    { name: "Ben Banned", email: "ben@bannedco.ca", ticketId: "con700000023", ticketType: "connect", details: { organisation: "Banned Co" } },
  ]);
  // Staff cleared Litware's logo: it's never searched for again automatically.
  await M.Company.create({ nameKey: "litware", name: "Litware", logoUrl: "", updatedBy: "Mia Manager" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body, token } = {}) {
  const headers = { "content-type": "application/json" };
  if (as) headers.authorization = `Bearer ${tokenFor(as)}`;
  if (token) headers.authorization = token;
  const r = await realFetch(base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: r.status, body: json, text, headers: r.headers };
}
const ok = async (p, want = 200) => {
  const r = await p;
  assert.equal(r.status, want, JSON.stringify(r.body));
  return r;
};
const orgs = async () => (await ok(call("GET", "/api/app/organisations"))).body;
const find = (list, key) => [...list.featured, ...list.attending].find((o) => o.key === key);

/* ---------- GET /api/app/organisations ---------- */

test("organisations: public, cached, one entry per organisation, only counts about people", { skip }, async () => {
  const r = await ok(call("GET", "/api/app/organisations"));
  assert.equal(r.headers.get("cache-control"), "public, max-age=120");
  const list = r.body;
  assert.deepEqual(Object.keys(list), ["updatedAt", "featured", "attending"]);
  assert.deepEqual(list.featured.map((o) => o.name), ["Dell Technologies"]);
  const dell = find(list, "dell technologies");
  assert.deepEqual([dell.attendeeCount, dell.logoSource, dell.logo, dell.kind, dell.scale, dell.website, dell.aliases],
    [1, "website", `${CDN}/dell.png`, "corporateEnterprisePartners", 120, "https://www.dell.com/", ["dell"]]);          // Dan typed "Dell"
  const fab = find(list, "fabrikam ai");
  assert.deepEqual([fab.attendeeCount, fab.speakerCount], [2, 1]);                                                    // Bo + Cy (two passes)
  assert.equal(find(list, "woodgrove bank").attendeeCount, 1);                                                        // Ann once, not twice
  assert.deepEqual([find(list, "ibm").speakerCount, find(list, "ibm").attendeeCount], [1, 0]);
  assert.equal(find(list, "ibm consulting").attendeeCount, 1);                                                        // never IBM
  for (const gone of ["banned co", "shadow co", "quiet co", "student", "no pass org", "quiet partner", "booth co", "test ticket co"]) {
    assert.equal(find(list, gone), undefined, gone);
  }
  const counts = list.attending.map((o) => o.attendeeCount);
  assert.deepEqual(counts, [...counts].sort((a, b) => b - a));
  // No one's name, email or work domain leaves the server.
  for (const s of ["Ann Attendee", "Bo Builder", "@", "fabrikam-ai.ca", "woodgrove-bank.ca", "gmail"]) assert.equal(r.text.includes(s), false, s);
});

test("organisations: someone new joins → their organisation is there within the minute, nothing to approve", { skip }, async () => {
  await M.User.create({ name: "Nia New", email: "nia@tailspin-toys.ca", organization: "Tailspin Toys", tickets: [{ ticketId: "con700000030", type: "power" }] });
  assert.equal(find(await orgs(), "tailspin toys"), undefined);          // the minute's list
  ORG.forgetOrganisations();                                             // a minute later
  const t = find(await orgs(), "tailspin toys");
  assert.deepEqual([t.name, t.attendeeCount, t.logo, t.logoSource], ["Tailspin Toys", 1, "", ""]);
});

/* ---------- the automatic logo ---------- */

test("automatic logo: in the background, from the work email's domain, stored on the Company record as auto", { skip }, async () => {
  ORG.configureAutoLogo({ enabled: true, reset: true });
  lookups.length = 0;
  ORG.forgetOrganisations();
  slowFirstMs = 1500;
  const started = Date.now();
  const first = await orgs();
  assert.ok(Date.now() - started < 1500, "the request didn't wait for the search");
  assert.equal(find(first, "fabrikam ai").logo, "");
  await ORG.autoLogoIdle();
  const company = await M.Company.findOne({ nameKey: "fabrikam ai" }).lean();
  assert.deepEqual([company.logoSource, company.updatedBy, company.logoStore, company.domain], ["auto", "Automatic", "database", "fabrikam-ai.ca"]);
  assert.match(company.logoUrl, /^https:\/\/techfest-canada-backend\.onrender\.com\/api\/files\/company-logo\/[a-f0-9]{24}$/);
  assert.equal(await M.CompanyLogo.countDocuments({}), 1);
  // Only domain lookups for organisations whose domain looks like them: never Wikimedia, never a personal mailbox,
  // never an organisation with a website logo, never one staff cleared (Litware), never a reserved domain (IBM Consulting).
  assert.ok(lookups.length > 0);
  for (const u of lookups) {
    assert.ok(!/wikimedia|gmail|dell|litware|consulting-ibm/i.test(u), u);
  }
  assert.ok(lookups.every((u) => /fabrikam-ai\.ca|woodgrove-bank\.ca|tailspin-toys\.ca/.test(u)), lookups.join("\n"));
  const fab = find(await orgs(), "fabrikam ai");                         // the search forgot the list when it found one
  assert.deepEqual([fab.logoSource, fab.logo], ["auto", company.logoUrl]);
  const set = await M.OrgSetting.findOne({ key: "fabrikam ai" }).lean();
  assert.deepEqual([set.logoCheckResult, set.logoCheckDomain], ["found", "fabrikam-ai.ca"]);
  assert.equal((await M.OrgSetting.findOne({ key: "woodgrove bank" }).lean()).logoCheckResult, "none");
});

test("automatic logo: at most once a day per organisation, on any server; never over a logo staff chose", { skip }, async () => {
  lookups.length = 0;
  ORG.forgetOrganisations();
  await orgs();
  await ORG.autoLogoIdle();
  assert.deepEqual(lookups, []);                                          // Woodgrove and Tailspin were tried today
  // Another server took Tailspin's search a moment ago: this one doesn't run it (the claim is in the database).
  await M.OrgSetting.updateOne({ key: "tailspin toys" }, { $unset: { logoCheckedAt: 1 } });
  ORG.forgetOrganisations();
  slowMs = 50;
  const building = orgs();
  await M.OrgSetting.updateOne({ key: "tailspin toys" }, { $set: { logoCheckedAt: new Date() } });
  await building;
  await ORG.autoLogoIdle();
  slowMs = 0;
  assert.equal(lookups.filter((u) => u.includes("tailspin")).length, 0);
  // Staff pick a logo for Fabrikam: theirs wins and the automatic one is never written over it.
  await M.Company.updateOne({ nameKey: "fabrikam ai" }, { $set: { logoUrl: "https://res.cloudinary.com/demo/fabrikam-staff.png", logoSource: "upload", updatedBy: "Mia Manager" } });
  await call("POST", "/api/console/organisations/lookup", { as: U.mia, body: { key: "fabrikam ai" } });
  await orgs();
  await ORG.autoLogoIdle();
  const fab = find(await orgs(), "fabrikam ai");
  assert.deepEqual([fab.logoSource, fab.logo], ["company", "https://res.cloudinary.com/demo/fabrikam-staff.png"]);
});

/* ---------- Admin › Attending organisations ---------- */

test("admin: staff only; the merged list with sources, counts and merged keys", { skip }, async () => {
  assert.equal((await call("GET", "/api/console/organisations")).status, 401);
  assert.equal((await call("GET", "/api/console/organisations", { as: U.ann })).status, 403);
  const { body } = await ok(call("GET", "/api/console/organisations?fresh=1", { as: U.mia }));
  assert.equal(body.cmsOk, true);
  const row = (key) => body.orgs.find((o) => o.key === key);
  assert.deepEqual([row("dell technologies").section, row("dell technologies").partnerId, row("dell technologies").mergedKeys],
    ["featured", "82f1d0a0-0167-479a-94e3-4b9ffeefb24d", ["dell"]]);
  assert.deepEqual([row("quiet partner").hidden, row("quiet partner").hiddenBy], [true, "partner"]);
  assert.equal(row("fabrikam ai").company.logoSource, "upload");
  assert.ok(body.aliases.some((a) => a.from === "ontario government" && a.builtin));
  assert.equal(JSON.stringify(body).includes("@"), false);
});

test("admin: add a logo to any attending organisation (no Company record yet), by its key; both lists show it at once", { skip }, async () => {
  const before = (await ok(call("GET", "/api/console/organisations?fresh=1", { as: U.mia }))).body;
  assert.equal(before.counts.total, before.orgs.length);
  assert.equal(before.counts.missingLogo, before.orgs.filter((o) => !o.logo).length);
  const org = before.orgs.find((o) => !o.logo && !o.partnerId && !o.hidden && !o.company);
  assert.ok(org, "an organisation with no logo and no Company record");
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  // Saved under the organisation's key, whatever name the panel sends (kept in the database here: no Cloudinary or Sanity;
  // the apps only take https logo links, as API_URL is on Render).
  const api = process.env.API_URL;
  process.env.API_URL = "https://api.example.test";
  const saved = (await ok(call("POST", "/api/console/companies/logo", { as: U.mia, body: { key: org.key, name: `${org.name} (display)`, data: PNG } }))).body;
  if (api === undefined) delete process.env.API_URL; else process.env.API_URL = api;
  assert.match(saved.logoUrl, /^https:\/\/api\.example\.test\/api\/files\/company-logo\/[a-f0-9]{24}$/);
  assert.equal((await M.Company.findOne({ nameKey: org.key }).lean()).logoSource, "upload");
  // No ?fresh=1: the save dropped this server's copy, so the next read has it (other servers: within the minute).
  const after = (await ok(call("GET", "/api/console/organisations", { as: U.mia }))).body;
  assert.deepEqual([after.orgs.find((o) => o.key === org.key).logo, after.orgs.find((o) => o.key === org.key).logoSource], [saved.logoUrl, "company"]);
  assert.equal(after.counts.missingLogo, before.counts.missingLogo - 1);
  const app = (await ok(call("GET", "/api/app/organisations"))).body;
  assert.equal([...app.featured, ...app.attending].find((o) => o.key === org.key).logo, saved.logoUrl);
  // A key that isn't one (spaces, capitals): the name decides, as before.
  assert.equal((await call("POST", "/api/console/companies/logo", { as: U.mia, body: { key: "Not A Key ", name: "", data: PNG } })).status, 400);
  // Remove it: the monogram again, at once.
  await ok(call("POST", "/api/console/companies/logo/clear", { as: U.mia, body: { key: org.key, name: org.name } }));
  const cleared = (await ok(call("GET", "/api/console/organisations", { as: U.mia }))).body;
  assert.equal(cleared.orgs.find((o) => o.key === org.key).logo, "");
  assert.equal(cleared.counts.missingLogo, before.counts.missingLogo);
});

test("admin: hide and show an organisation; merge X into Y and undo it; loops refused; all audited", { skip }, async () => {
  await ok(call("POST", "/api/console/organisations/hide", { as: U.mia, body: { key: "tailspin toys", hidden: true, name: "Tailspin Toys" } }));
  assert.equal(find(await orgs(), "tailspin toys"), undefined);                                     // at once on this server
  assert.equal((await call("POST", "/api/console/organisations/hide", { as: U.mia, body: { key: "tailspin toys", hidden: "yes" } })).status, 400);
  await ok(call("POST", "/api/console/organisations/hide", { as: U.mia, body: { key: "tailspin toys", hidden: false } }));
  assert.ok(find(await orgs(), "tailspin toys"));

  await ok(call("POST", "/api/console/organisations/alias", { as: U.mia, body: { from: "IBM Consulting", into: "IBM" } }));
  let list = await orgs();
  assert.equal(find(list, "ibm consulting"), undefined);
  assert.equal(find(list, "ibm").attendeeCount, 1);
  assert.ok(find(list, "ibm").aliases.includes("ibm consulting"));
  // Ian's directory entry carries the key his organisation is listed under.
  const people = (await ok(call("GET", "/api/social/attendees", { as: U.ann }))).body;
  const key = (name) => people.find((p) => p.name === name)?.orgKey;
  assert.deepEqual([key("Ian Consultant"), key("Dan Dell"), key("Bo Builder"), key("Gus Student")], ["ibm", "dell technologies", "fabrikam ai", ""]);
  // A loop (IBM into IBM Consulting, which is now IBM) is refused.
  assert.equal((await call("POST", "/api/console/organisations/alias", { as: U.mia, body: { from: "IBM", into: "IBM Consulting" } })).status, 400);
  assert.equal((await call("POST", "/api/console/organisations/alias", { as: U.mia, body: { from: "", into: "IBM" } })).status, 400);
  await ok(call("DELETE", `/api/console/organisations/alias/${encodeURIComponent("ibm consulting")}`, { as: U.mia }));
  list = await orgs();
  assert.equal(find(list, "ibm consulting").attendeeCount, 1);
  assert.equal((await call("DELETE", "/api/console/organisations/alias/acme", { as: U.mia })).status, 404);
  // A built-in merge can be switched off.
  await ok(call("DELETE", `/api/console/organisations/alias/${encodeURIComponent("ontario government")}`, { as: U.mia }));
  const { body } = await ok(call("GET", "/api/console/organisations", { as: U.mia }));
  assert.equal(body.aliases.find((a) => a.from === "ontario government").off, true);
  const actions = (await M.AdminAudit.find({ targetType: "organisation" }).lean()).map((a) => a.action).sort();
  assert.deepEqual(actions, ["org_alias", "org_alias_remove", "org_alias_remove", "org_hide", "org_logo_lookup", "org_unhide"]);
});

/* ---------- Catalyst Awards ---------- */

const nominations = () => {
  const base = {
    categoryType: "matrix", pillar: "AI & Machine Learning", sector: "Healthcare", nomineeType: "Organisation", nomineeOrganisation: "Northwind Health",
    nomineeLocation: "Toronto, ON", nomineeWebsite: "northwind-health.ca", nomineeEmail: "nominee@northwind-health.ca", nomineePhone: "+1 416 555 0101",
    nomineeLinkedIn: "https://www.linkedin.com/company/northwind-health", nominatorName: "Pat Nominator", nominatorEmail: "pat@nominator.ca",
    nominatorPhone: "+1 416 555 0199", nominatorTitle: "Chief Secret Officer", nominatorOrganisation: "Nominator Org", nominatorRelationship: "Former colleague",
    statementOverview: "Overview text that stays private", statementImpact: "Impact text", statementAchievements: "Achievements text",
    adminNotes: "Staff note that stays private", status: "pending",
  };
  return [
    { ...base, nomineeName: "Northwind Health" },
    { ...base, nomineeName: "Ada Example", nomineeType: "Individual", nomineeTitle: "Chief Scientist", sector: "Energy", selfNomination: true, nominatorName: "Ada Example" },
    { ...base, nomineeName: "Zed Team", nomineeType: "Team / Project", categoryType: "special", specialAward: "rising", nomineeWebsite: "javascript:alert(1)" },
    { ...base, nomineeName: "Rejected Co", sector: "Finance", status: "rejected" },
    { ...base, nomineeName: "Second Look Co", status: "shortlisted" },
  ];
};

test("awards: the public summary — categories with eligible applications, the count, the switch", { skip }, async () => {
  await M.Nomination.create(nominations());
  forgetAwards();
  const r = await ok(call("GET", "/api/app/awards/summary"));
  assert.equal(r.headers.get("cache-control"), "public, max-age=60");
  assert.deepEqual(r.body, { enabled: true, categoriesCount: 3, applicationsCount: 4 });
});

test("awards: applications for signed-in pass holders only (401 / 403 otherwise), nothing private", { skip }, async () => {
  assert.equal((await call("GET", "/api/app/awards/applications")).status, 401);
  assert.equal((await call("GET", "/api/app/awards/applications", { token: "Bearer nonsense" })).status, 401);
  assert.equal((await call("GET", "/api/app/awards/applications", { as: U.ben })).status, 403);               // suspended
  const nopass = await call("GET", "/api/app/awards/applications", { as: U.hal });
  assert.deepEqual([nopass.status, nopass.body.code], [403, "no_pass"]);
  await ok(call("GET", "/api/app/awards/applications", { as: U.mia }));                                        // staff
  const r = await ok(call("GET", "/api/app/awards/applications", { as: U.ann }));
  assert.equal(r.headers.get("cache-control"), "private, max-age=60");
  assert.deepEqual([r.body.enabled, r.body.total, r.body.categoriesCount], [true, 4, 3]);
  assert.deepEqual(r.body.items.map((i) => i.nomineeName), ["Ada Example", "Northwind Health", "Second Look Co", "Zed Team"]);
  const ada = r.body.items[0];
  assert.deepEqual([ada.nomineeType, ada.nomineeTitle], ["Individual", "Chief Scientist"]);
  assert.deepEqual(Object.keys(ada).filter((k) => /applicant|selfNominat|nominator/i.test(k)), []);   // who applied stays private (Oct 22 2026)
  assert.equal(r.body.items[1].nomineeWebsite, "https://northwind-health.ca/");
  assert.equal(r.body.items[3].nomineeWebsite, "");                                                          // not http(s)
  for (const s of ["@", "555", "linkedin", "Secret", "colleague", "Nominator Org", "Pat Nominator", "private", "Healthcare", "Energy", "rising", "AI & Machine",
    "pending", "shortlisted", "status", "pillar", "sector", "category", "Rejected Co"]) {
    assert.equal(r.text.toLowerCase().includes(s.toLowerCase()), false, s);
  }
});

test("awards: \"Show award applications in the app\" off → empty list, the category count stays", { skip }, async () => {
  assert.equal((await call("PUT", "/api/console/app-content/site.award_applications", { as: U.mia, body: { value: false } })).status, 200);
  const off = (await ok(call("GET", "/api/app/awards/applications", { as: U.ann }))).body;
  assert.deepEqual(off, { enabled: false, total: 0, categoriesCount: 3, items: [] });
  assert.deepEqual((await ok(call("GET", "/api/app/awards/summary"))).body, { enabled: false, categoriesCount: 3, applicationsCount: 0 });
  assert.equal((await ok(call("GET", "/api/console/app-content", { as: U.mia }))).body.find((c) => c.key === "site.award_applications").value, false);
  await ok(call("PUT", "/api/console/app-content/site.award_applications", { as: U.mia, body: { value: true } }));
  assert.equal((await ok(call("GET", "/api/app/awards/applications", { as: U.ann }))).body.enabled, true);
});
