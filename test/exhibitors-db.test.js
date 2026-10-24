/* The public exhibitor list (Oct 24 2026, the website's /programme page) through the real route, against a real
   (throwaway) MongoDB. The CMS (Sanity) is a stubbed fetch; nothing else may leave the machine. Starts a local mongod
   in a temp folder on a free port and stops it after; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people and companies. */
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
    { _id: "p-acme", name: "Acme Robotics", displayName: "Acme Robotics", category: "corporateEnterprisePartners", order: 3, logo: `${CDN}/acme.png`, website: "https://acme-robotics.example" },
  ],
  logos: [],
  speakers: [],
};
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  if (url.includes(".sanity.io/")) {
    const result = decodeURIComponent(url).includes('"partners"') ? CMS : [];
    return new Response(JSON.stringify({ result }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null;
let dbDir = "";
let server = null;
let base = "";
let mongoose;
let EX;
let ORG;
const M = {};

const SECRETS = ["Jordan Booth", "jordan@acme-robotics.example", "Riley Stand", "riley@fabrikam.example", "+1 416 555 0100",
  "Head of Partnerships", "ex1000000001", "ex1000000002", "Shadow Person", "shadow@shadow.example"];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-exhibitors-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_exhibitors_test`);
  ORG = await import("../services/organisations.js");
  ORG.configureAutoLogo({ enabled: false, gapMs: 0, reset: true, log: { error() {} } });
  EX = await import("../services/exhibitors.js");
  const imp = async (p) => (await import(p)).default;
  M.User = await imp("../models/User.js");
  M.Attendee = await imp("../models/Attendee.js");
  M.Company = await imp("../models/Company.js");
  M.OrgSetting = await imp("../models/OrgSetting.js");
  await Promise.all([M.Company.init(), M.OrgSetting.init()]);
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/app", await imp("../routes/appExhibitors.js"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;

  const booth = (company, no, zone, extra = {}) => ({
    ticketType: "connect", promoCode: "EXHIBITOR", purchaseDate: new Date("2026-10-10"),
    details: { organisation: company, jobTitle: "Head of Partnerships", phone: "+1 416 555 0100" },
    issuedPass: { label: "", rsvp: true, issuedBy: "Mia Manager", issuedAt: new Date("2026-10-10"), booth: { booth: no, zone, passes: "4" } },
    ...extra,
  });
  await M.Attendee.create([
    booth("Acme Robotics", "07", "Zone A - Harbour Ballroom Foyer", { name: "Jordan Booth", email: "jordan@acme-robotics.example", ticketId: "ex1000000001" }),
    booth("Acme Robotics Inc.", "8", "", { name: "Jordan Booth", email: "jordan@acme-robotics.example", ticketId: "ex1000000002" }),
    booth("Fabrikam", "21", "Zone B - Pier 4 & 5 Foyer", { name: "Riley Stand", email: "riley@fabrikam.example", ticketId: "ex1000000003" }),
    booth("Test Ticket Co", "3", "", { name: "Tess Test", email: "tess@test.example", ticketId: "ex1000000004", hiddenByStaff: true }),
    booth("Shadow Co", "4", "", { name: "Shadow Person", email: "shadow@shadow.example", ticketId: "ex1000000005", appHidden: { at: new Date("2026-10-20"), byName: "Mia Manager" } }),
    booth("Not Exhibiting Co", "5", "", { name: "Nat No", email: "nat@notex.example", ticketId: "ex1000000006", exhibitor: false }),
    booth("Hidden Org", "6", "", { name: "Hal Hidden", email: "hal@hiddenorg.example", ticketId: "ex1000000007" }),
    booth("No Booth Co", "", "", { name: "Nora None", email: "nora@nobooth.example", ticketId: "ex1000000008" }),
    // An ordinary pass and a booth order: never exhibitors here.
    { name: "Ann Attendee", email: "ann@woodgrove.example", ticketId: "con800000001", ticketType: "power", details: { organisation: "Woodgrove Bank" } },
    { name: "Bo Buyer", email: "bo@boothbuyer.example", ticketId: "BOOTH-DOUBLE-1", ticketType: "booth-double", details: { organisation: "Booth Buyer Co" } },
  ]);
  await M.Company.create({ nameKey: "fabrikam", name: "Fabrikam", logoUrl: "https://res.cloudinary.com/demo/image/upload/fabrikam.png", logoSource: "upload", domain: "fabrikam.example", updatedBy: "Mia Manager" });
  await M.OrgSetting.create({ key: "hidden org", hidden: true, updatedBy: "Mia Manager" });
  (await import("../services/appHide.js")).forgetHidden();
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

async function get(url) {
  const r = await realFetch(base + url);
  const text = await r.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body, text, headers: r.headers };
}

test("GET /api/app/exhibitors: public, cached, one entry per company with its booths, zone, logo and website", { skip }, async () => {
  const r = await get("/api/app/exhibitors");
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers.get("cache-control"), "public, max-age=120");
  assert.deepEqual(Object.keys(r.body), ["updatedAt", "zones", "exhibitors"]);
  assert.deepEqual(r.body.zones.map((z) => [z.key, z.area, z.booths]), [["A", "Harbour Ballroom Foyer", "1–15"], ["B", "Pier 4 & 5 Foyer", "16–25"]]);
  assert.deepEqual(r.body.exhibitors, [
    { key: "acme robotics", name: "Acme Robotics", booth: "7 & 8", booths: ["7", "8"], zone: "A", logo: `${CDN}/acme.png`, website: "https://acme-robotics.example/" },
    { key: "fabrikam", name: "Fabrikam", booth: "21", booths: ["21"], zone: "B", logo: "https://res.cloudinary.com/demo/image/upload/fabrikam.png", website: "https://fabrikam.example/" },
  ]);
});

test("nothing about the people, their passes or orders is in the answer", { skip }, async () => {
  const r = await get("/api/app/exhibitors");
  for (const s of [...SECRETS, "@", "Test Ticket", "Shadow", "Not Exhibiting", "Hidden Org", "No Booth", "Woodgrove", "Booth Buyer", "connect", "EXHIBITOR", "\"passes\""]) {
    assert.equal(r.text.includes(s), false, s);
  }
});

test("a new exhibitor pass shows within the minute (the list is rebuilt at most once a minute)", { skip }, async () => {
  await M.Attendee.create({
    name: "Lee Late", email: "lee@litware.example", ticketId: "ex1000000009", ticketType: "connect", promoCode: "EXHIBITOR",
    details: { organisation: "Litware" }, issuedPass: { booth: { booth: "16", zone: "", passes: "2" } },
  });
  assert.equal((await get("/api/app/exhibitors")).body.exhibitors.some((x) => x.key === "litware"), false);   // the minute's list
  EX.forgetExhibitors();
  ORG.forgetOrganisations();
  const list = (await get("/api/app/exhibitors")).body.exhibitors;
  assert.deepEqual(list.map((x) => [x.name, x.booth, x.zone]), [["Acme Robotics", "7 & 8", "A"], ["Litware", "16", "B"], ["Fabrikam", "21", "B"]]);
});

test("the database is down and nothing was built yet: 503 with a plain message", { skip }, async () => {
  EX.forgetExhibitors();
  const orig = M.Attendee.find;
  M.Attendee.find = () => ({ select: () => ({ lean: () => Promise.reject(new Error("db down")) }) });
  const quiet = console.error;
  console.error = () => {};
  try {
    const r = await get("/api/app/exhibitors");
    assert.equal(r.status, 503);
    assert.deepEqual(r.body, { error: "The exhibitor list isn't available right now." });
  } finally {
    M.Attendee.find = orig;
    console.error = quiet;
  }
  assert.equal((await get("/api/app/exhibitors")).status, 200);
});
