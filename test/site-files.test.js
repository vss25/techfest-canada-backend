import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { AdminAudit, AppContent } from "../models/Admin.js";
import { requireManagementAdmin } from "../middleware/adminAuth.js";
import {
  SITE_FILE_MAX_BYTES, SITE_FILE_KEYS, SITE_FILE_TOO_BIG, BROCHURE_URL_KEY,
  sniffSiteFile, siteFileName, checkSiteFile, siteFileAuditDetail, cleanSiteFileUrl, savedSiteFileUrl,
} from "../services/siteFiles.js";
import { CONTENT_KEYS, cleanContent } from "../services/adminHelpers.js";
import { BROCHURES, brochureUrl, loadAttachment } from "../services/brochureDownloads.js";
import cmsRouter, { siteFileBody, uploadSiteFile } from "../routes/cms.js";
import appApiRouter from "../routes/appApi.js";
import Brochure from "../models/Brochure.js";

/* Large site files (Oct 19 2026): the home video and the brochure PDF move off the website's
   deploys to the Sanity CDN. Sanity, MongoDB and email are stubbed: no network, no database. */

// The console routes construct an email client on import.
process.env.RESEND_API_KEY ||= "re_test_placeholder";
const { default: consoleRouter } = await import("../routes/console.js");
const { default: brochureRouter } = await import("../routes/brochure.js");

const SECRET = "site-files-test";
const CDN = "https://cdn.sanity.io/files/021qtoci/production";
const VIDEO_URL = `${CDN}/0123456789abcdef0123456789abcdef01234567.mp4`;
const PDF_URL = `${CDN}/89abcdef0123456789abcdef0123456789abcdef.pdf`;
const brochure = BROCHURES.sponsorship;

const mp4 = (size = 64) => { const b = Buffer.alloc(size); b.write("ftypisom", 4, "latin1"); return b; };
const pdf = (size = 64) => { const b = Buffer.alloc(size); b.write("%PDF-1.7\n", 0, "latin1"); return b; };

/* ---------- pure parts ---------- */

test("file type comes from the bytes: MP4 (ftyp brands browsers play) or PDF; QuickTime and others refused", () => {
  assert.equal(sniffSiteFile(mp4()), "video/mp4");
  const mp42 = mp4(); mp42.write("mp42", 8, "latin1");
  assert.equal(sniffSiteFile(mp42), "video/mp4");
  assert.equal(sniffSiteFile(pdf()), "application/pdf");
  const mov = mp4(); mov.write("qt  ", 8, "latin1");
  assert.equal(sniffSiteFile(mov), "");
  assert.equal(sniffSiteFile(Buffer.from("\x89PNG\r\n\x1a\n0000000000", "latin1")), "");
  assert.equal(sniffSiteFile(Buffer.from("%PDF")), "");          // too short to be anything
  assert.equal(sniffSiteFile("ftypisom"), "");
  assert.equal(sniffSiteFile(null), "");
});

test("upload check: declared type must be MP4 or PDF and match the bytes; 40 MB at most; never empty", () => {
  assert.equal(SITE_FILE_MAX_BYTES, 40 * 1024 * 1024);
  const ok = checkSiteFile({ body: mp4(), contentType: "video/mp4", filename: "hero-bg.mp4" });
  assert.deepEqual(ok, { type: "video/mp4", ext: "mp4", filename: "hero-bg.mp4", bytes: 64 });
  assert.equal(checkSiteFile({ body: pdf(), contentType: "application/pdf; charset=binary", filename: "Brochure.pdf" }).type, "application/pdf");

  assert.deepEqual(checkSiteFile({ body: pdf(), contentType: "image/png" }), { status: 415, error: "Upload an MP4 video or a PDF." });
  assert.equal(checkSiteFile({ body: pdf(), contentType: "" }).status, 415);
  assert.deepEqual(checkSiteFile({ body: pdf(), contentType: "video/mp4" }), { status: 415, error: "That file isn't an MP4 video." });
  assert.deepEqual(checkSiteFile({ body: mp4(), contentType: "application/pdf" }), { status: 415, error: "That file isn't a PDF." });
  assert.deepEqual(checkSiteFile({ body: Buffer.alloc(0), contentType: "video/mp4" }), { status: 400, error: "The file is empty." });
  assert.equal(checkSiteFile({ body: undefined, contentType: "video/mp4" }).status, 400);
  assert.deepEqual(checkSiteFile({ body: pdf(SITE_FILE_MAX_BYTES + 1), contentType: "application/pdf" }), { status: 413, error: SITE_FILE_TOO_BIG });
  assert.equal(checkSiteFile({ body: pdf(SITE_FILE_MAX_BYTES), contentType: "application/pdf" }).bytes, SITE_FILE_MAX_BYTES);
});

test("file names: safe characters, the extension of the real type", () => {
  assert.equal(siteFileName("hero-bg.mp4", "mp4"), "hero-bg.mp4");
  assert.equal(siteFileName("Hero video (final).MP4", "mp4"), "Hero_video_final.mp4");
  assert.equal(siteFileName("brochure.mov", "mp4"), "brochure.mp4");
  assert.equal(siteFileName("../../etc/passwd", "pdf"), "etc_passwd.pdf");
  assert.equal(siteFileName("", "pdf"), "site-file.pdf");
  assert.equal(siteFileName(undefined, "mp4"), "site-file.mp4");
  assert.ok(siteFileName("x".repeat(300), "pdf").length <= 84);
  assert.equal(siteFileAuditDetail({ filename: "hero-bg.mp4", type: "video/mp4", bytes: 26_014_310 }), "hero-bg.mp4 · video/mp4 · 26.0 MB");
});

test("app content keys: site.hero_video_url and site.brochure_url, empty by default, public in /api/app/content", () => {
  assert.equal(CONTENT_KEYS["site.hero_video_url"], "");
  assert.equal(CONTENT_KEYS["site.brochure_url"], "");
  assert.deepEqual(Object.keys(SITE_FILE_KEYS).sort(), ["site.brochure_url", "site.hero_video_url"]);
  assert.equal(BROCHURE_URL_KEY, "site.brochure_url");
});

test("saved URLs: empty, or this project's Sanity CDN file of the right kind; anything else refused", () => {
  assert.equal(cleanSiteFileUrl("site.hero_video_url", VIDEO_URL), VIDEO_URL);
  assert.equal(cleanSiteFileUrl("site.brochure_url", ` ${PDF_URL} `), PDF_URL);
  assert.equal(cleanSiteFileUrl("site.brochure_url", ""), "");
  assert.equal(cleanSiteFileUrl("site.brochure_url", null), "");
  for (const bad of [
    PDF_URL.replace("https://", "http://"),
    PDF_URL.replace("021qtoci", "otherproj"),
    PDF_URL.replace("/production/", "/staging/"),
    PDF_URL.replace("/files/", "/images/"),
    `${PDF_URL}?dl=x.pdf`,
    "https://evil.example/Brochure.pdf",
    "https://cdn.sanity.io.evil.example/files/021qtoci/production/abcdefabcdef.pdf",
    "/Brochure.pdf",
    "javascript:alert(1)",
  ]) assert.equal(cleanSiteFileUrl("site.brochure_url", bad), null, bad);
  assert.equal(cleanSiteFileUrl("site.hero_video_url", PDF_URL), null);              // a PDF isn't the video
  assert.equal(cleanSiteFileUrl("site.brochure_url", VIDEO_URL), null);
  assert.equal(cleanSiteFileUrl("site.other", PDF_URL), null);
  assert.equal(cleanSiteFileUrl("site.brochure_url", "https://cdn.sanity.io/files/p2/d2/abcdefabcdef.pdf", { SANITY_PROJECT_ID: "p2", SANITY_DATASET: "d2" }),
    "https://cdn.sanity.io/files/p2/d2/abcdefabcdef.pdf");
});

test("cleanContent: the two keys keep a valid URL or empty; a bad URL is refused like an unknown key", () => {
  assert.deepEqual(cleanContent("site.hero_video_url", VIDEO_URL), ["site.hero_video_url", VIDEO_URL]);
  assert.deepEqual(cleanContent("site.brochure_url", ""), ["site.brochure_url", ""]);
  assert.equal(cleanContent("site.brochure_url", "https://evil.example/x.pdf"), null);
  assert.deepEqual(cleanContent("site.hero_tagline", "Hello"), ["site.hero_tagline", "Hello"]);   // others unchanged
});

test("brochure emails link the uploaded PDF when there is one, else the website's", async () => {
  assert.equal(brochureUrl(brochure, "https://www.thetechfestival.com"), "https://www.thetechfestival.com/Brochure.pdf");
  assert.equal(brochureUrl(brochure, "https://www.thetechfestival.com", ""), "https://www.thetechfestival.com/Brochure.pdf");
  assert.equal(brochureUrl(brochure, "https://www.thetechfestival.com", PDF_URL), PDF_URL);

  const calls = [];
  const small = pdf(100);
  const fetchImpl = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET" });
    return { ok: true, headers: { get: () => String(small.length) }, arrayBuffer: async () => small.buffer.slice(small.byteOffset, small.byteOffset + small.length) };
  };
  const a = await loadAttachment(brochure, { base: "https://site.test", uploaded: PDF_URL, fetchImpl });
  assert.equal(a.content.length, 100);
  assert.deepEqual(calls.map((c) => c.url), [PDF_URL, PDF_URL]);
});

test("savedSiteFileUrl reads the AppContent row, drops bad values and never throws", async () => {
  const model = (row) => ({ findOne: (q) => ({ lean: async () => (q.key === BROCHURE_URL_KEY ? row : null) }) });
  assert.equal(await savedSiteFileUrl(BROCHURE_URL_KEY, { AppContent: model({ key: BROCHURE_URL_KEY, value: PDF_URL }) }), PDF_URL);
  assert.equal(await savedSiteFileUrl(BROCHURE_URL_KEY, { AppContent: model(null) }), "");
  assert.equal(await savedSiteFileUrl(BROCHURE_URL_KEY, { AppContent: model({ value: "https://evil.example/x.pdf" }) }), "");
  const broken = { findOne: () => ({ lean: async () => { throw new Error("db down"); } }) };
  assert.equal(await savedSiteFileUrl(BROCHURE_URL_KEY, { AppContent: broken }), "");
});

test("server.js mounts the upload before every JSON parser, with management checked before the body is read", () => {
  const src = readFileSync(new URL("../server.js", import.meta.url), "utf8");
  const upload = src.indexOf('app.post("/api/cms/upload-file", requireManagementAdmin, siteFileBody, uploadSiteFile);');
  assert.ok(upload > 0, "upload route mounted");
  assert.ok(upload < src.indexOf('app.use("/api/cms", express.json('), "before the 9 MB CMS JSON parser");
  assert.ok(upload < src.indexOf("app.use(express.json("), "before the global JSON parser");
});

/* ---------- routes (same order as server.js; Sanity + MongoDB stubbed) ---------- */

const ids = { boss: "a".repeat(24), staff: "b".repeat(24), user: "c".repeat(24) };
const people = {
  [ids.boss]: { _id: ids.boss, name: "Mia Manager", email: "mia@example.test", role: "admin", staffRole: "management" },
  [ids.staff]: { _id: ids.staff, name: "Nicole", email: "nicole@thetechfestival.com", role: "admin", staffRole: "staff" },
  [ids.user]: { _id: ids.user, name: "Ann Attendee", email: "ann@example.test", role: "user" },
};
const realFetch = globalThis.fetch;
let server, base, savedEnv, globalFetchStub;
let sanityCalls, sanityReply, audits, content, emails, cdnCalls, brochureRows;

before(async () => {
  savedEnv = { JWT_SECRET: process.env.JWT_SECRET, SANITY_WRITE_TOKEN: process.env.SANITY_WRITE_TOKEN };
  process.env.JWT_SECRET = SECRET;
  process.env.SANITY_WRITE_TOKEN = "sanity-test-token-not-real";
  globalThis.fetch = globalFetchStub = async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.hostname === "127.0.0.1") return realFetch(input, init);
    if (u.hostname === "api.resend.com") {                       // email: captured, never sent
      emails.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ id: `email-${emails.length}` }), { status: 200, headers: { "Content-Type": "application/json" } });
    }
    if (u.hostname === "cdn.sanity.io") {                        // the uploaded brochure: 15.6 MB, so linked, not attached
      cdnCalls.push({ url: String(input), method: init.method || "GET" });
      return new Response(null, { status: 200, headers: { "Content-Length": "15604925", "Content-Type": "application/pdf" } });
    }
    if (!u.hostname.endsWith(".api.sanity.io")) throw new Error(`Unexpected network call in test: ${u.hostname}`);
    sanityCalls.push({ path: u.pathname, filename: u.searchParams.get("filename"), method: init.method, headers: init.headers, body: init.body });
    if (sanityReply) return new Response(JSON.stringify(sanityReply.body), { status: sanityReply.status });
    const ext = u.searchParams.get("filename").split(".").pop();
    const sha = "0123456789abcdef0123456789abcdef01234567";
    return new Response(JSON.stringify({ document: { _id: `file-${sha}-${ext}`, url: `${CDN}/${sha}.${ext}`, size: init.body.length } }), { status: 200 });
  };
  const app = express();
  app.post("/api/cms/upload-file", requireManagementAdmin, siteFileBody, uploadSiteFile);   // as in server.js
  app.use("/api/cms", express.json({ limit: "9mb" }), cmsRouter);
  app.use(express.json({ limit: "1mb" }));
  app.use("/api/app", appApiRouter);
  app.use("/api/brochure", brochureRouter);
  app.use("/api/console", consoleRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server?.close();
  globalThis.fetch = realFetch;
  for (const [k, v] of Object.entries(savedEnv)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});
beforeEach(() => {
  mock.restoreAll();
  sanityCalls = []; sanityReply = null; audits = []; content = {}; emails = []; cdnCalls = []; brochureRows = [];
  mock.method(Brochure, "exists", async () => null);
  mock.method(Brochure, "create", async (doc) => { const row = { _id: String(brochureRows.length + 1).padStart(24, "d"), ...doc }; brochureRows.push(row); return row; });
  mock.method(Brochure, "updateOne", async (q, u) => { Object.assign(brochureRows.find((r) => r._id === q._id) || {}, u.$set); return {}; });
  mock.method(User, "findById", async (id) => people[String(id)] || null);
  mock.method(AdminAudit, "create", async (doc) => { audits.push(doc); return doc; });
  mock.method(AppContent, "find", () => ({ lean: async () => Object.entries(content).map(([key, value]) => ({ key, value })) }));
  mock.method(AppContent, "findOne", (q) => ({ lean: async () => (q.key in content ? { key: q.key, value: content[q.key] } : null) }));
  mock.method(AppContent, "updateOne", async (q, u) => { content[q.key] = u.$set.value; return { acknowledged: true }; });
});

const token = (id, claims = {}) => jwt.sign({ id, ...claims }, SECRET);
const upload = (body, { type = "video/mp4", filename = "hero-bg.mp4", as = ids.boss, claims } = {}) =>
  realFetch(`${base}/cms/upload-file?filename=${encodeURIComponent(filename)}`, {
    method: "POST",
    headers: { ...(type ? { "Content-Type": type } : {}), ...(as ? { Authorization: `Bearer ${token(as, claims)}` } : {}) },
    body,
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("upload: management sends the raw MP4 → Sanity gets the same bytes → 201 { assetId, url } + one audit row", async () => {
  const bytes = mp4(4096);
  for (let i = 16; i < bytes.length; i++) bytes[i] = i % 251;
  const r = await upload(bytes, { filename: "Hero video.mp4" });
  assert.equal(r.status, 201);
  assert.deepEqual(r.body, { assetId: "file-0123456789abcdef0123456789abcdef01234567-mp4", url: `${CDN}/0123456789abcdef0123456789abcdef01234567.mp4` });
  assert.equal(sanityCalls.length, 1);
  const c = sanityCalls[0];
  assert.equal(c.method, "POST");
  assert.equal(c.path, "/v2021-10-21/assets/files/production");
  assert.equal(c.filename, "Hero_video.mp4");
  assert.equal(c.headers["Content-Type"], "video/mp4");
  assert.equal(c.headers.Authorization, "Bearer sanity-test-token-not-real");
  assert.ok(Buffer.compare(Buffer.from(c.body), bytes) === 0, "bytes unchanged");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "cms_upload_file");
  assert.equal(audits[0].targetType, "cms:asset");
  assert.equal(audits[0].targetId, r.body.assetId);
  assert.equal(audits[0].adminName, "Mia Manager");
  assert.equal(audits[0].detail, "Hero_video.mp4 · video/mp4 · 0.0 MB");
});

test("upload: a 12 MB PDF goes through (past the 9 MB and 1 MB JSON limits)", async () => {
  const r = await upload(pdf(12 * 1024 * 1024), { type: "application/pdf", filename: "Brochure.pdf" });
  assert.equal(r.status, 201);
  assert.match(r.body.url, /\.pdf$/);
  assert.equal(sanityCalls[0].body.length, 12 * 1024 * 1024);
  assert.equal(sanityCalls[0].headers["Content-Type"], "application/pdf");
});

test("upload: over 40 MB → 413 JSON, nothing sent to Sanity", async () => {
  const r = await upload(pdf(SITE_FILE_MAX_BYTES + 1), { type: "application/pdf", filename: "big.pdf" });
  assert.equal(r.status, 413);
  assert.equal(r.body.error, SITE_FILE_TOO_BIG);
  assert.equal(sanityCalls.length, 0);
  assert.equal(audits.length, 0);
});

test("upload: wrong or mismatched type → 415, nothing sent to Sanity", async () => {
  const png = await upload(Buffer.from("\x89PNG\r\n\x1a\n00000000", "latin1"), { type: "image/png", filename: "x.png" });
  assert.equal(png.status, 415);
  const none = await upload(pdf(), { type: "", filename: "x.pdf" });
  assert.equal(none.status, 415);
  const fake = await upload(pdf(), { type: "video/mp4", filename: "x.mp4" });
  assert.equal(fake.status, 415);
  assert.equal(fake.body.error, "That file isn't an MP4 video.");
  const mov = mp4(); mov.write("qt  ", 8, "latin1");
  assert.equal((await upload(mov, { filename: "x.mov" })).status, 415);
  assert.equal(sanityCalls.length, 0);
  assert.equal(audits.length, 0);
});

test("upload: management only; staff, attendees, no token and emailed-code sign-ins are refused", async () => {
  const staff = await upload(mp4(), { as: ids.staff });
  assert.equal(staff.status, 403);
  assert.equal(staff.body.error, "Management only");
  const attendee = await upload(mp4(), { as: ids.user });
  assert.equal(attendee.status, 403);
  const anon = await upload(mp4(), { as: null });
  assert.equal(anon.status, 401);
  const viaCode = await upload(mp4(), { claims: { via: "email" } });
  assert.equal(viaCode.status, 403);
  assert.equal(viaCode.body.code, "password_required");
  assert.equal(sanityCalls.length, 0);
  assert.equal(audits.length, 0);
});

test("upload: 503 without the Sanity token; Sanity's own errors come back as 4xx / 502", async () => {
  const saved = process.env.SANITY_WRITE_TOKEN;
  delete process.env.SANITY_WRITE_TOKEN;
  try {
    const r = await upload(mp4());
    assert.equal(r.status, 503);
  } finally { process.env.SANITY_WRITE_TOKEN = saved; }

  sanityReply = { status: 500, body: { error: { description: "Asset storage unavailable" } } };
  const down = await upload(mp4());
  assert.equal(down.status, 502);
  assert.equal(down.body.error, "Asset storage unavailable");
  sanityReply = { status: 200, body: { document: {} } };
  assert.equal((await upload(mp4())).status, 502);
  assert.equal(audits.length, 0);
});

test("the rest of /api/cms still takes JSON (the upload mount doesn't swallow it): a staff photo upload", async () => {
  const data = `data:image/png;base64,${Buffer.from("\x89PNG\r\n\x1a\nfake").toString("base64")}`;
  const r = await realFetch(`${base}/cms/upload`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(ids.staff)}` },
    body: JSON.stringify({ data, filename: "face.png" }),
  });
  assert.equal(r.status, 201);
  assert.equal(sanityCalls[0].path, "/v2021-10-21/assets/images/production");
  assert.equal(audits[0].action, "cms_upload");
});

test("console content save: a CDN URL saves (audited), a foreign URL is refused, empty goes back to the website copy", async () => {
  const put = (key, value, as = ids.staff) => realFetch(`${base}/console/app-content/${encodeURIComponent(key)}`, {
    method: "PUT", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token(as)}` }, body: JSON.stringify({ value }),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));

  assert.equal((await put("site.hero_video_url", VIDEO_URL)).status, 200);
  assert.equal(content["site.hero_video_url"], VIDEO_URL);
  assert.ok(audits.some((a) => a.action === "edit_app_text" && a.targetId === "site.hero_video_url"));
  const bad = await put("site.brochure_url", "https://evil.example/brochure.pdf");
  assert.equal(bad.status, 400);
  assert.equal(content["site.brochure_url"], undefined);
  assert.equal((await put("site.brochure_url", PDF_URL)).status, 200);

  const pub = await realFetch(`${base}/app/content`).then((x) => x.json());
  assert.equal(pub["site.hero_video_url"], VIDEO_URL);
  assert.equal(pub["site.brochure_url"], PDF_URL);

  assert.equal((await put("site.hero_video_url", "")).status, 200);
  const after = await realFetch(`${base}/app/content`).then((x) => x.json());
  assert.equal(after["site.hero_video_url"], "");
});

test("/api/app/content sends both keys as \"\" until something is uploaded", async () => {
  const pub = await realFetch(`${base}/app/content`).then((x) => x.json());
  assert.equal(pub["site.hero_video_url"], "");
  assert.equal(pub["site.brochure_url"], "");
});

test("brochure email: links the uploaded PDF once site.brochure_url is set, the website's copy before", async () => {
  const submit = (email) => realFetch(`${base}/brochure/submit`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Alex", lastName: "Chen", email, company: "Acme", brochure: "sponsorship", elapsedMs: 9000, _hp: "" }),
  }).then((r) => r.status);
  const waitFor = async (n) => { for (let i = 0; i < 100 && emails.length < n; i++) await new Promise((r) => setTimeout(r, 20)); };

  // Nothing uploaded: the website's own /Brochure.pdf (HEAD goes there, not to Sanity).
  mock.method(globalThis, "fetch", async (input, init = {}) => {
    const u = new URL(String(input));
    if (u.hostname === "www.thetechfestival.com") { cdnCalls.push({ url: String(input), method: init.method || "GET" }); return new Response(null, { status: 200, headers: { "Content-Length": "15604925" } }); }
    return globalFetchStub(input, init);
  });
  assert.equal(await submit("alex@example.test"), 201);
  await waitFor(2);
  const first = emails.find((e) => e.to === "alex@example.test");
  assert.ok(first, "brochure email built");
  assert.match(first.html, /https:\/\/www\.thetechfestival\.com\/Brochure\.pdf/);
  assert.equal(first.attachments, undefined);
  assert.deepEqual(cdnCalls.map((c) => c.url), ["https://www.thetechfestival.com/Brochure.pdf"]);

  // Uploaded: the CDN copy, linked (15.6 MB is past the attach limit).
  content["site.brochure_url"] = PDF_URL;
  emails.length = 0; cdnCalls.length = 0;
  assert.equal(await submit("bea@example.test"), 201);
  await waitFor(2);
  const second = emails.find((e) => e.to === "bea@example.test");
  assert.ok(second.html.includes(PDF_URL));
  assert.ok(second.text.includes(PDF_URL));
  assert.ok(!second.html.includes("thetechfestival.com/Brochure.pdf"));
  assert.deepEqual(cdnCalls, [{ url: PDF_URL, method: "HEAD" }]);
  for (let i = 0; i < 100 && brochureRows.at(-1).emailStatus !== "sent"; i++) await new Promise((r) => setTimeout(r, 20));
  assert.equal(brochureRows.at(-1).emailStatus, "sent");
  assert.equal(brochureRows.at(-1).delivery, "link");
});
