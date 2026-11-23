/* Marketing › Social posts: templated posts (Nov 23 2026), through the real routes against a real (throwaway)
   MongoDB: the template list, writing from a template (Claude stubbed: the template's brief and link reach the
   prompt, em-dashes never come back), saving a post with its own designed image per channel, the view's per-channel
   images, and a change of image sending an approved post back for approval. Starts a local mongod in a temp folder
   on a free port; skipped when the binary isn't there (TTFC_TEST_MONGOD, else
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
process.env.RESEND_API_KEY ||= "re_dummy";

const freePort = () => new Promise((ok) => { const s = net.createServer(); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => ok(p)); }); });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const portOpen = (port) => new Promise((ok) => { const c = net.connect(port, "127.0.0.1", () => { c.end(); ok(true); }); c.on("error", () => ok(false)); });

let mongod = null, dbDir = "", server = null, base = "", jwt, mongoose;
const U = {};
const sent = [];

before(async () => {
  if (!HAVE) return;
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttfc-socialtpl-"));
  const port = await freePort();
  mongod = spawn(BIN, ["--dbpath", dbDir, "--port", String(port), "--bind_ip", "127.0.0.1", "--quiet"], { stdio: "ignore" });
  ({ default: mongoose } = await import("mongoose"));
  for (let i = 0; i < 120 && !(await portOpen(port)); i++) await pause(250);
  await mongoose.connect(`mongodb://127.0.0.1:${port}/ttfc_socialtpl_test`);
  ({ default: jwt } = await import("jsonwebtoken"));
  const User = (await import("../models/User.js")).default;
  const social = await import("../routes/socialPosts.js");
  social.socialDeps.claude = () => ({ beta: { messages: { create: async (params) => {
    sent.push(params);
    return { stop_reason: "end_turn", usage: { input_tokens: 1000, output_tokens: 300 },
             content: [{ type: "text", text: JSON.stringify({ linkedin: "Meet Ada Lovelace — our keynote.", x: "Ada – live in Vancouver", instagram: "Say hello to Ada —" }) }] };
  } } } });
  const { default: express } = await import("express");
  const app = express();
  app.use(express.json());
  app.use("/api/console/social", social.default);
  server = app.listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  U.mgr = await User.create({ name: "Mo Manager", email: "mo.manager@example.com", role: "admin", staffRole: "management" });
  U.staff = await User.create({ name: "Sky Staff", email: "sky.staff@example.com", role: "admin", staffRole: "staff" });
});

after(async () => {
  server?.close();
  if (mongoose) await mongoose.disconnect().catch(() => {});
  if (mongod) { mongod.kill("SIGTERM"); await new Promise((r) => mongod.once("exit", r)); }
  if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
});

const tokenFor = (u) => jwt.sign({ id: String(u._id) }, process.env.JWT_SECRET, { expiresIn: "1h" });
async function call(method, url, { as, body } = {}) {
  const r = await fetch(base + url, { method, headers: { "content-type": "application/json", ...(as ? { authorization: `Bearer ${tokenFor(as)}` } : {}) },
                                      body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => null) };
}
const ok = async (p, want = 200) => { const r = await p; assert.equal(r.status, want, JSON.stringify(r.body)); return r.body; };
const img = (n, size = "1200x627") => `https://cdn.sanity.io/images/abc123/production/${n}-${size}.png`;
const API = "/api/console/social";

test("the template list comes with the settings", { skip }, async () => {
  const s = await ok(call("GET", `${API}/settings`, { as: U.staff }));
  assert.deepEqual(s.templates.map((t) => t.key), ["speaker", "panel", "partner", "callSpeakers", "callSponsors", "tickets"]);
  assert.deepEqual(s.templates[1], { key: "panel", label: "Panel announcement", source: "session" });
});

test("writing from a template: its brief and link reach Claude, no em-dash comes back", { skip }, async () => {
  const r = await ok(call("POST", `${API}/write`, { as: U.staff, body: {
    channels: ["linkedin", "x", "instagram"], template: "speaker", link: "https://www.thetechfestival.com/tickets",
    source: "Speaker: Ada Lovelace\nChief Scientist, Example Labs\nSession: Day 1, 10:00, The AI Agenda", eventName: "Vancouver Briefing" } }));
  assert.deepEqual(r.texts, { linkedin: "Meet Ada Lovelace, our keynote.", x: "Ada, live in Vancouver", instagram: "Say hello to Ada" });
  const prompt = sent.at(-1).messages[0].content;
  assert.match(prompt, /Template: Speaker announcement/);
  assert.match(prompt, /Link to use: https:\/\/www\.thetechfestival\.com\/tickets/);
  assert.match(sent.at(-1).system[0].text, /Never use em-dashes/);
  // A link that isn't https is left out.
  await ok(call("POST", `${API}/write`, { as: U.staff, body: { channels: ["x"], template: "tickets", link: "javascript:alert(1)", source: "Event: Vancouver Briefing" } }));
  assert.doesNotMatch(sent.at(-1).messages[0].content, /Link to use/);
});

test("a templated post keeps a designed image per channel; changing one sends it back for approval", { skip }, async () => {
  const created = await ok(call("POST", `${API}/posts`, { as: U.staff, body: {
    title: "Speaker: Ada Lovelace", text: "Meet Ada.", template: "speaker",
    images: { linkedin: { url: img("li"), alt: "Ada Lovelace, speaker" }, instagram: { url: img("ig", "1080x1350") }, x: { url: img("x", "1600x900") } },
    versions: { x: { own: true, list: [{ text: "Ada, live", ai: true }], chosen: 0 }, instagram: { own: true, list: [{ text: "Say hello", ai: true }], chosen: 0 } },
  } }), 201);
  const p = created.post;
  assert.equal(p.template, "speaker");
  assert.deepEqual(p.crops, { linkedin: img("li"), instagram: img("ig", "1080x1350"), x: img("x", "1600x900") });
  assert.equal((await call("POST", `${API}/posts`, { as: U.staff, body: { text: "x", images: { x: { url: "https://example.com/a.png" } } } })).status, 400);

  await ok(call("POST", `${API}/posts/${p.id}/submit`, { as: U.staff, body: {} }));
  await ok(call("POST", `${API}/posts/${p.id}/review`, { as: U.mgr, body: { decision: "approve" } }));
  const changed = await ok(call("PATCH", `${API}/posts/${p.id}`, { as: U.staff, body: { images: { ...p.images, x: { url: img("x2", "1600x900") } } } }));
  assert.equal(changed.post.crops.x, img("x2", "1600x900"));
  assert.equal(changed.post.review.state, "");
  const same = await ok(call("PATCH", `${API}/posts/${p.id}`, { as: U.staff, body: { title: "Speaker: Ada" } }));
  assert.equal(same.post.crops.linkedin, img("li"));
});
