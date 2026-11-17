/* The admin-first content workflow (Nov 2026) through the real /api/cms routes: staff save
   (nothing in Sanity changes), send to staging (Sanity drafts, references weak), and
   management publishes (published documents, references strong again, event records).
   Sanity is an in-memory fake that answers exactly the queries routes/cms.js sends; MongoDB is
   a throwaway local mongod, skipped when the binary isn't there (TTFC_TEST_MONGOD, else
   ~/.cache/mongodb-binaries/mongod-arm64-darwin-8.2.6). Fictional people, example.com. */
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
process.env.SANITY_WRITE_TOKEN = "sk-test";

/* ---------- fake Sanity ---------- */
const docs = new Map();
const mutations = [];
const isDraft = (id) => id.startsWith("drafts.");
const all = () => [...docs.values()];
const pick = (cond) => all().filter(cond);
function answer(groq, p) {
  const q = groq.replace(/\s+/g, " ");
  if (q.startsWith('{ "published"')) return { published: docs.get(p.id) || null, draft: docs.get(p.d) || null };
  if (q.startsWith("*[_id == $id][0]._type")) return docs.get(p.id)?._type ?? null;
  if (q.startsWith("count(*[_id in [$id, $d] || eventKey")) return pick((d) => d._id === p.id || d._id === p.d || d.eventKey?.current === p.key).length;
  if (q.startsWith("count(*[_id in [$id, $d]])")) return pick((d) => d._id === p.id || d._id === p.d).length;
  if (q.startsWith('*[_type == $type && !(_id in path("drafts.**"))]')) return pick((d) => d._type === p.type && !isDraft(d._id));
  if (q.startsWith('*[_type == $type && _id in path("drafts.**")]')) return pick((d) => d._type === p.type && isDraft(d._id));
  if (q.startsWith('*[_id in path("drafts.**") && _type in $types]')) return pick((d) => isDraft(d._id) && p.types.includes(d._type));
  if (q === "*[_id in $ids]._id") return pick((d) => p.ids.includes(d._id)).map((d) => d._id);
  if (q === "*[_id in $ids]") return pick((d) => p.ids.includes(d._id));
  throw new Error(`fake Sanity doesn't know: ${q}`);
}
function mutate(list) {
  const next = new Map(docs);
  const out = [];
  for (const m of list) {
    const [kind, body] = Object.entries(m)[0];
    if (kind === "create" || kind === "createOrReplace") {
      const id = body._id || `gen-${next.size}`;
      for (const r of JSON.stringify(body).matchAll(/"_ref":"([^"]+)"(,"_weak":true)?/g)) {
        if (!r[2] && !/^(image|file)-/.test(r[1]) && !next.has(r[1])) throw Object.assign(new Error(`strong reference to missing ${r[1]}`), { status: 409 });
      }
      if (kind === "create" && next.has(id)) throw Object.assign(new Error("exists"), { status: 409 });
      next.set(id, { ...body, _id: id, _updatedAt: new Date().toISOString() });
      out.push({ id, document: next.get(id) });
    } else if (kind === "delete") next.delete(body.id);
    else if (kind === "patch") {
      const d = { ...next.get(body.id) };
      Object.assign(d, body.set || {});
      for (const k of body.unset || []) delete d[k];
      next.set(body.id, d);
      out.push({ id: body.id, document: d });
    } else throw new Error(`fake Sanity can't ${kind}`);
  }
  for (const k of [...docs.keys()]) docs.delete(k);
  for (const [k, v] of next) docs.set(k, v);
  mutations.push(list);
  return { results: out };
}

const realFetch = globalThis.fetch;
globalThis.fetch = async (input, opts) => {
  const url = String(input?.url || input);
  if (/^http:\/\/127\.0\.0\.1/.test(url)) return realFetch(input, opts);
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  if (url.includes(".api.sanity.io/") && url.includes("/data/query/")) {
    const u = new URL(url);
    const params = {};
    for (const [k, v] of u.searchParams) if (k.startsWith("$")) params[k.slice(1)] = JSON.parse(v);
    return json({ result: answer(u.searchParams.get("query"), params) });
  }
  if (url.includes(".api.sanity.io/") && url.includes("/data/mutate/")) {
    try { return json(mutate(JSON.parse(opts.body).mutations)); } catch (e) { return json({ error: { description: e.message } }, e.status || 400); }
  }
  throw new Error(`blocked in the test: ${url}`);
};

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", mongoose, jwt;
const U = {};
let CmsChange, EventConfig;

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-cmswf-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_cmswf_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const User = (await import("../models/User.js")).default;
  CmsChange = (await import("../models/CmsChange.js")).default;
  EventConfig = (await import("../models/EventConfig.js")).default;
  U.mia = await User.create({ name: "Mia Manager", email: "mia.manager@example.com", password: "x".repeat(20), role: "admin", staffRole: "management" });
  U.sam = await User.create({ name: "Sam Staff", email: "sam.staff@example.com", password: "x".repeat(20), role: "admin", staffRole: "staff" });
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/cms", (await import("../routes/cms.js")).default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/cms`;
  // Live content: one speaker and the Vancouver event.
  docs.set("speaker-ada", { _id: "speaker-ada", _type: "speaker", name: "Ada Example", title: "CTO", company: "Example Co", order: 1, bio: "Live bio" });
  docs.set("event-ttfc-2027-vancouver-briefing", { _id: "event-ttfc-2027-vancouver-briefing", _type: "event", name: "Vancouver Briefing", city: "Vancouver", type: "briefing", year: 2027, eventKey: { _type: "slug", current: "ttfc-2027-vancouver-briefing" } });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const call = async (who, method, p, body) => {
  const r = await fetch(`${base}${p}`, {
    method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: String(U[who]._id) }, process.env.JWT_SECRET)}` },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};
const IMG = "image-0123456789abcdef0123456789abcdef01234567-800x1000-jpg";
let newId = "";

test("staff save: new and edited content is kept off Sanity, and the editors see it", { skip }, async () => {
  const before = mutations.length;
  const created = await call("sam", "POST", "/speaker?draft=1", { name: "Bo Example", title: "Founder", company: "Bo Labs", order: 2, image: IMG, events: ["event-ttfc-2027-vancouver-briefing"] });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  newId = created.body._id;
  assert.match(newId, /^speaker-[a-f0-9]{12}$/);
  assert.deepEqual([created.body.hasDraft, created.body.staged, created.body.unpublished], [true, false, true]);
  assert.match(created.body.imageUrl, /^https:\/\/cdn\.sanity\.io\/images\/021qtoci\/production\/.+-800x1000\.jpg$/);

  const edited = await call("sam", "PATCH", "/speaker/speaker-ada?draft=1", { bio: "New bio" });
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.bio, edited.body.name, edited.body.hasDraft], ["New bio", "Ada Example", true]);
  assert.equal(mutations.length, before, "nothing was written to Sanity");
  assert.equal(docs.get("speaker-ada").bio, "Live bio");

  const live = await call("sam", "GET", "/speaker");
  assert.deepEqual(live.body.map((d) => d._id), ["speaker-ada"]);
  assert.equal(live.body[0].bio, "Live bio");
  const editor = await call("sam", "GET", "/speaker?drafts=1");
  assert.deepEqual(editor.body.map((d) => [d._id, d.bio || "", d.hasDraft, d.unpublished]), [["speaker-ada", "New bio", true, false], [newId, "", true, true]]);
});

test("the panel can't skip the workflow: live creation is management only, publishing needs staging first (for everyone)", { skip }, async () => {
  assert.equal((await call("sam", "POST", "/speaker", { name: "X", title: "Y", company: "Z", order: 3, image: IMG })).status, 403);
  const p = await call("sam", "POST", `/speaker/${newId}/publish`);
  assert.equal(p.status, 409);
  assert.match(p.body.error, /staging/);
  assert.equal((await call("sam", "POST", "/changes/publish")).status, 409);   // nothing on staging yet
});

test("the Changes list says what's unsent and which fields changed", { skip }, async () => {
  const c = await call("sam", "GET", "/changes");
  assert.equal(c.status, 200);
  assert.deepEqual(c.body.counts, { unsent: 2, staged: 0 });
  assert.equal(c.body.canPublish, true);   // any staff publishes from staging
  const ada = c.body.items.find((i) => i.id === "speaker-ada");
  assert.deepEqual([ada.typeLabel, ada.title, ada.unsent, ada.staged, ada.isNew, ada.fields, ada.wipBy], ["Speaker", "Ada Example", true, false, false, ["bio"], "Sam Staff"]);
  assert.equal(c.body.items.find((i) => i.id === newId).isNew, true);
});

test("send to staging: Sanity drafts with weak references; the live documents don't move", { skip }, async () => {
  const one = await call("sam", "POST", `/speaker/${newId}/stage`);
  assert.equal(one.status, 200, JSON.stringify(one.body));
  assert.deepEqual([one.body.hasDraft, one.body.staged], [false, true]);
  const d = docs.get(`drafts.${newId}`);
  assert.equal(d.events[0]._weak, true);
  assert.equal(docs.has(newId), false);

  const rest = await call("sam", "POST", "/changes/stage");
  assert.deepEqual(rest.body.staged, ["speaker-ada"]);
  assert.equal(docs.get("drafts.speaker-ada").bio, "New bio");
  assert.equal(docs.get("speaker-ada").bio, "Live bio");
  assert.equal((await call("sam", "POST", "/changes/stage")).status, 409);

  const c = (await call("sam", "GET", "/changes")).body;
  assert.deepEqual(c.counts, { unsent: 0, staged: 2 });
  assert.deepEqual(c.items.find((i) => i.id === "speaker-ada").stagedFields, ["bio"]);
  assert.equal(c.items.find((i) => i.id === "speaker-ada").stagedBy, "Sam Staff");
});

test("edits after staging wait as unsent work on top of the staged version", { skip }, async () => {
  const e = await call("sam", "PATCH", "/speaker/speaker-ada?draft=1", { title: "CEO" });
  assert.deepEqual([e.body.bio, e.body.title, e.body.hasDraft, e.body.staged], ["New bio", "CEO", true, true]);
  const item = (await call("sam", "GET", "/changes")).body.items.find((i) => i.id === "speaker-ada");
  assert.deepEqual([item.unsent, item.staged, item.fields], [true, true, ["title"]]);
});

test("publish to live (any staff): what's on staging goes live, references strong, unsent work stays", { skip }, async () => {
  const out = await call("sam", "POST", "/changes/publish");
  assert.equal(out.status, 200, JSON.stringify(out.body));
  assert.deepEqual(out.body.published.sort(), [newId, "speaker-ada"].sort());
  assert.equal(docs.get("speaker-ada").bio, "New bio");
  assert.equal(docs.get("speaker-ada").title, "CTO", "the unsent title isn't published");
  assert.equal(docs.get(newId).events[0]._weak, undefined);
  assert.equal(docs.has(`drafts.${newId}`), false);
  assert.equal(await CmsChange.countDocuments({ docId: newId }), 0);
  const ada = await CmsChange.findOne({ docId: "speaker-ada" }).lean();
  assert.equal(ada.wip.title, "CEO");
  assert.equal(ada.stagedAt, undefined);
});

test("throw away unsent work: back to the live version", { skip }, async () => {
  const d = await call("sam", "DELETE", "/speaker/speaker-ada/draft");
  assert.equal(d.status, 200);
  assert.deepEqual([d.body.deleted, d.body.row.title, d.body.row.hasDraft], [false, "CTO", false]);
  assert.equal(await CmsChange.countDocuments({ docId: "speaker-ada" }), 0);
  assert.deepEqual((await call("sam", "GET", "/changes")).body.counts, { unsent: 0, staged: 0 });
});

test("events: always saved first, one per city/year/type, and publishing makes the event record", { skip }, async () => {
  const ev = await call("sam", "POST", "/event", { name: "Calgary Briefing", city: "Calgary", type: "briefing", year: 2027 });
  assert.equal(ev.status, 201, JSON.stringify(ev.body));
  assert.equal(ev.body._id, "event-ttfc-2027-calgary-briefing");
  assert.equal(docs.has(ev.body._id), false);
  assert.equal((await call("sam", "POST", "/event", { name: "Again", city: "Calgary", type: "briefing", year: 2027 })).status, 409);
  // A speaker on the new event goes to staging with it and is published in the same step.
  const s = await call("sam", "POST", "/speaker?draft=1", { name: "Cy Example", title: "VP", company: "Cy Co", order: 4, image: IMG, events: [ev.body._id] });
  assert.equal((await call("sam", "POST", "/changes/stage")).status, 200);
  assert.equal((await call("mia", "POST", "/changes/publish", { ids: [s.body._id, ev.body._id] })).status, 200);
  assert.equal(docs.get(s.body._id).events[0]._weak, undefined);
  const cfg = await EventConfig.findOne({ eventKey: "ttfc-2027-calgary-briefing" }).lean();
  assert.deepEqual([cfg.status, cfg.city, cfg.year], ["announced", "Calgary", 2027]);
});

test("a never-published item thrown away from staging is gone", { skip }, async () => {
  const s = await call("sam", "POST", "/speaker?draft=1", { name: "Di Example", title: "VP", company: "Di Co", order: 5, image: IMG });
  await call("sam", "POST", `/speaker/${s.body._id}/stage`);
  const d = await call("sam", "DELETE", `/speaker/${s.body._id}/draft?which=staged`);
  assert.deepEqual([d.status, d.body.deleted], [200, true]);
  assert.equal(docs.has(`drafts.${s.body._id}`), false);
  assert.equal((await call("sam", "GET", `/speaker?drafts=1`)).body.some((r) => r._id === s.body._id), false);
});
