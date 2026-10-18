import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import walletRouter from "../routes/wallet.js";
import { verifyTicketSig, walletPassUrl } from "../services/walletLink.js";

/* GET /api/wallet/link/:ticketId (web app "Add to Apple Wallet"):
   same ticket rule as /pass, answers with the emailed signed link. */

const SECRET = "wallet-link-test-jwt";
const LINK_SECRET = "wallet-link-test-sig";
const API = "https://api.test";
const WALLET_ENV = {
  WALLET_PASS_TYPE_ID: "pass.test.ttfc", WALLET_TEAM_ID: "TEAM000000",
  WALLET_SIGNER_CERT_B64: "Y2VydA==", WALLET_SIGNER_KEY_B64: "a2V5", WALLET_WWDR_CERT_B64: "d3dkcg==",
};
const saved = {};
const KEYS = ["JWT_SECRET", "WALLET_LINK_SECRET", "API_URL", ...Object.keys(WALLET_ENV)];

const users = new Map([
  ["a".repeat(24), { _id: "a".repeat(24), name: "Ann Lee", role: "user", tickets: [{ ticketId: "a1b2c3d4e5f6", type: "influence" }] }],
  ["b".repeat(24), { _id: "b".repeat(24), name: "Bo Chan", role: "user", tickets: [{ ticketId: "0f0f0f0f0f0f", type: "power" }] }],
  ["c".repeat(24), { _id: "c".repeat(24), name: "Sam Staff", role: "admin", tickets: [] }],
]);
const chain = (v) => ({ select: async () => v });
const bearer = (id, secret = SECRET) => ({ Authorization: `Bearer ${jwt.sign({ id }, secret)}` });

let server;
let base;
before(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, { JWT_SECRET: SECRET, WALLET_LINK_SECRET: LINK_SECRET, API_URL: API, ...WALLET_ENV });
  const app = express();
  app.use("/api/wallet", walletRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/wallet`;
});
after(() => {
  server?.close();
  for (const k of KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});
beforeEach(() => {
  mock.restoreAll();
  mock.method(User, "findById", (id) => chain(users.get(String(id)) || null));
  mock.method(User, "findOne", (q) => chain([...users.values()].find((u) => u.tickets.some((t) => t.ticketId === q["tickets.ticketId"])) || null));
  Object.assign(process.env, WALLET_ENV);
});

const getLink = async (ticketId, headers = {}) => {
  const r = await fetch(`${base}/link/${ticketId}`, { headers });
  return { status: r.status, cache: r.headers.get("cache-control"), body: await r.json() };
};

test("link: your own ticket → the signed /pass URL, the same one the ticket email carries", async () => {
  const r = await getLink("a1b2c3d4e5f6", bearer("a".repeat(24)));
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body), ["url"]);
  const url = new URL(r.body.url);
  assert.equal(url.origin + url.pathname, `${API}/api/wallet/pass/a1b2c3d4e5f6`);
  assert.equal(verifyTicketSig("a1b2c3d4e5f6", url.searchParams.get("sig"), LINK_SECRET), true);
  assert.equal(r.body.url, walletPassUrl("a1b2c3d4e5f6", { secret: LINK_SECRET, base: API }));
  assert.equal(r.cache, "private, no-store");
});

test("link: needs a valid Bearer token", async () => {
  assert.equal((await getLink("a1b2c3d4e5f6")).status, 401);
  assert.equal((await getLink("a1b2c3d4e5f6", { Authorization: "Bearer nope" })).status, 401);
  assert.equal((await getLink("a1b2c3d4e5f6", bearer("a".repeat(24), "other-secret"))).status, 401);
  assert.equal((await getLink("a1b2c3d4e5f6", bearer("d".repeat(24)))).status, 401, "account gone");
});

test("link: someone else's ticket is refused; staff may fetch any", async () => {
  const other = await getLink("0f0f0f0f0f0f", bearer("a".repeat(24)));
  assert.equal(other.status, 404);
  assert.equal(other.body.url, undefined);
  const staff = await getLink("0f0f0f0f0f0f", bearer("c".repeat(24)));
  assert.equal(staff.status, 200);
  assert.equal(verifyTicketSig("0f0f0f0f0f0f", new URL(staff.body.url).searchParams.get("sig"), LINK_SECRET), true);
  assert.equal((await getLink("999999999999", bearer("c".repeat(24)))).status, 404, "unknown ticket, even for staff");
});

test("link: 503 while Apple Wallet isn't set up (after the ticket check)", async () => {
  delete process.env.WALLET_SIGNER_CERT_B64;
  const r = await getLink("a1b2c3d4e5f6", bearer("a".repeat(24)));
  assert.equal(r.status, 503);
  assert.match(r.body.error, /not set up/);
  assert.equal((await getLink("0f0f0f0f0f0f", bearer("a".repeat(24)))).status, 404, "still 404 for a ticket that isn't yours");
});

test("pass: the Bearer rule is unchanged (shared helper)", async () => {
  delete process.env.WALLET_SIGNER_CERT_B64;   // stop before building a pass
  const pass = (id, h) => fetch(`${base}/pass/${id}`, { headers: h }).then((r) => r.status);
  assert.equal(await pass("a1b2c3d4e5f6"), 401);
  assert.equal(await pass("0f0f0f0f0f0f", bearer("a".repeat(24))), 404);
  assert.equal(await pass("a1b2c3d4e5f6", bearer("a".repeat(24))), 503);
  assert.equal(await pass("0f0f0f0f0f0f", bearer("c".repeat(24))), 503);
});
