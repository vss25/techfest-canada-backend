import { test, before, after, beforeEach, mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";

import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import SignInRequest from "../models/SignInRequest.js";
import { AppContent, Block } from "../models/Admin.js";
import { SocialPost } from "../models/Social.js";
import ActivityEvent from "../models/ActivityEvent.js";
import { linkDecision } from "../services/emailLink.js";
import {
  tokenClaims, cleanVia, signedInWithoutPassword, PASSWORD_REQUIRED, PASSWORD_REQUIRED_CODE, VIA_EMAIL, VIA_TICKET,
} from "../services/signInMethod.js";
import { requireAdmin, requireManagementAdmin } from "../middleware/adminAuth.js";
import { createEmailLinkRouter } from "../routes/emailLink.js";
import ticketAuthRouter from "../routes/ticketAuth.js";
import checkinRouter from "../routes/checkin.js";
import cmsRouter from "../routes/cms.js";

/* Email one-time-code sign-in for everyone (staff and volunteers too), with the
   admin panel kept password-only (services/signInMethod.js). Mongo is replaced
   by in-memory stand-ins; no email is sent (the router takes a stub sender). */

process.env.JWT_SECRET = "test-secret";
process.env.RESEND_API_KEY ||= "re_dummy";   // routes/auth.js builds a Resend client on import; nothing is sent
const { default: authRouter } = await import("../routes/auth.js");
const { default: socialRouter } = await import("../routes/social.js");
const { default: walletRouter } = await import("../routes/wallet.js");

const oid = () => new mongoose.Types.ObjectId();
const PASSWORD = "correct horse";
const HASH = bcrypt.hashSync(PASSWORD, 4);

/** A query stand-in: chainable, awaitable, and `.lean()`-able. */
const chain = (value) => {
  const q = { select: () => q, sort: () => q, limit: () => q, lean: () => Promise.resolve(value), then: (a, b) => Promise.resolve(value).then(a, b) };
  return q;
};

let users = [];
let guests = [];
let requests = [];
let posts = [];
let sent = [];

function people() {
  const staff = new User({ name: "Sam Staff", email: "sam@thetechfestival.com", role: "admin", staffRole: "management", provider: "local", password: HASH, tickets: [] });
  const volunteer = new User({ name: "Val Volunteer", email: "val@example.com", role: "volunteer", provider: "local", password: HASH, tickets: [] });
  const vendor = new User({ name: "Vic Vendor", email: "vic@example.com", role: "user", types: ["vendor"], provider: "local", tickets: [] });
  const attendee = new User({ name: "Ada Attendee", email: "ada@example.com", role: "user", provider: "ticket", tickets: [{ ticketId: "aaaa1111bbbb", type: "power", purchaseDate: new Date() }] });
  return { staff, volunteer, vendor, attendee };
}
let P;

const matches = (doc, filter) => Object.entries(filter || {}).every(([k, v]) => {
  const have = doc[k];
  if (v instanceof RegExp) return v.test(String(have ?? ""));
  if (v && typeof v === "object" && !(v instanceof Date) && !(v instanceof mongoose.Types.ObjectId)) {
    if ("$lt" in v) return (have ?? 0) < v.$lt;
    if ("$gt" in v) return new Date(have) > new Date(v.$gt);
    if ("$ne" in v) return have !== v.$ne;
    if ("$in" in v) return v.$in.map(String).includes(String(have));
  }
  return String(have) === String(v);
});
const applyUpdate = (r, u) => {
  if (u.$set) Object.assign(r, u.$set);
  if (u.$inc) for (const [k, n] of Object.entries(u.$inc)) r[k] = (r[k] || 0) + n;
};
const asDoc = (r) => r && { ...r, toObject() { return { ...r }; } };

before(() => {
  mock.method(User, "findOne", (q = {}) => {
    const want = q["tickets.ticketId"];
    if (want) {
      const ids = want.$in || [want];
      return chain(users.find((u) => (u.tickets || []).some((t) => ids.includes(t.ticketId))) || null);
    }
    return chain(users.find((u) => matches(u, { email: q.email })) || null);
  });
  mock.method(User, "findById", (id) => chain(users.find((u) => String(u._id) === String(id)) || null));
  mock.method(User.prototype, "save", async function () { if (!users.includes(this)) users.push(this); return this; });

  mock.method(Attendee, "find", (f = {}) => chain(f.email ? guests.filter((g) => matches(g, { email: f.email })) : []));
  mock.method(Attendee, "findOne", () => chain(null));
  mock.method(Attendee, "updateOne", async () => ({}));
  mock.method(Attendee, "updateMany", async (f, u) => {
    for (const g of guests) if (matches(g, f)) applyUpdate(g, u);
    return {};
  });

  mock.method(SignInRequest, "create", async (doc) => {
    const r = { _id: oid(), createdAt: new Date(Date.now() + requests.length), ...doc };
    requests.push(r);
    return r;
  });
  mock.method(SignInRequest, "updateMany", async (f, u) => { requests.filter((r) => matches(r, f)).forEach((r) => applyUpdate(r, u)); return {}; });
  mock.method(SignInRequest, "updateOne", async (f, u) => { const r = requests.find((x) => matches(x, f)); if (r) applyUpdate(r, u); return {}; });
  mock.method(SignInRequest, "findOne", (f) => chain(asDoc(requests.filter((r) => matches(r, f)).at(-1) || null)));
  mock.method(SignInRequest, "findOneAndUpdate", async (f, u) => {
    const r = requests.find((x) => matches(x, f));
    if (!r) return null;
    applyUpdate(r, u);
    return asDoc(r);
  });

  // App rights (defaults), live switches, exhibitor passes and blocks: nothing stored.
  mock.method(AppContent, "findOne", () => chain(null));
  mock.method(Block, "find", () => chain([]));
  mock.method(SocialPost, "findById", (id) => chain(posts.find((p) => String(p._id) === String(id)) || null));
  mock.method(SocialPost.prototype, "save", async function () { return this; });
  mock.method(ActivityEvent, "deleteMany", async () => ({}));
});
after(() => mock.restoreAll());

const app = express();
app.use(express.json());
app.use("/api/auth", authRouter);
app.use("/api/auth", ticketAuthRouter);
app.use("/api/auth", (req, res, next) => emailLinkRouter(req, res, next));
app.use("/api/checkin", checkinRouter);
app.use("/api/social", socialRouter);
app.use("/api/cms", cmsRouter);
app.use("/api/wallet", walletRouter);
app.get("/api/admin/management-only", requireManagementAdmin, (req, res) => res.json({ ok: true, id: String(req.user._id) }));
let emailLinkRouter;
let server;
let base;
before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

beforeEach(() => {
  P = people();
  users = Object.values(P);
  guests = [];
  requests = [];
  posts = [];
  sent = [];
  // A fresh router per test: fresh rate limits; the stub records what would have been emailed.
  emailLinkRouter = createEmailLinkRouter({ send: async (kind, payload) => { sent.push({ kind, ...payload }); } });
});

const call = async (method, path, { body, token } = {}) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};
const settle = () => new Promise((r) => setImmediate(r));

/** Requests a code for `email`, then signs in with it → { status, body, decoded }. */
async function signInByCode(email) {
  const r = await call("POST", "/api/auth/email-link", { body: { email, client: "ios" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: true });
  await settle();
  const mail = sent.find((s) => s.kind === "signin" && s.email === email);
  assert.ok(mail, `a sign-in code was emailed to ${email}`);
  const v = await call("POST", "/api/auth/email-link/verify", { body: { email, code: mail.code } });
  return { ...v, decoded: v.body.token ? jwt.verify(v.body.token, process.env.JWT_SECRET) : null };
}
const passwordToken = (user) => jwt.sign({ id: user._id, role: user.role }, process.env.JWT_SECRET, { expiresIn: "7d" });

/* ---------- who gets a code ---------- */
test("link decision: staff, volunteer and ticketless accounts get a code; strangers don't", () => {
  const { staff, volunteer, vendor, attendee } = people();
  assert.equal(linkDecision(staff, 0), "signin");
  assert.equal(linkDecision(volunteer, 0), "signin");
  assert.equal(linkDecision(vendor, 0), "signin");      // account with no ticket
  assert.equal(linkDecision(attendee, 0), "signin");
  assert.equal(linkDecision(null, 1), "signin");        // guest ticket, no account yet
  assert.equal(linkDecision(null, 0), "no-ticket");     // stranger
});

test("token claims: email and ticket sign-ins are marked, password tokens aren't", () => {
  const u = { _id: "u1", role: "admin" };
  assert.deepEqual(tokenClaims(u, VIA_EMAIL), { id: "u1", role: "admin", via: "email" });
  assert.deepEqual(tokenClaims(u, VIA_TICKET), { id: "u1", role: "admin", via: "ticket" });
  assert.deepEqual(tokenClaims(u), { id: "u1", role: "admin" });
  assert.deepEqual(tokenClaims(u, "password"), { id: "u1", role: "admin" });   // unknown values aren't kept
  assert.equal(cleanVia("email"), "email");
  assert.equal(cleanVia("admin"), undefined);
  assert.equal(signedInWithoutPassword({ via: "email" }), true);
  assert.equal(signedInWithoutPassword({ via: "ticket" }), true);
  assert.equal(signedInWithoutPassword({ id: "u1" }), false);   // older tokens = password tokens
  assert.equal(signedInWithoutPassword(null), false);
});

test("staff get a code by email and verify it: token carries via email, no account made", async () => {
  const r = await signInByCode("sam@thetechfestival.com");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, false);
  assert.equal(String(r.decoded.id), String(P.staff._id));
  assert.equal(r.decoded.role, "admin");
  assert.equal(r.decoded.via, "email");
  assert.equal(users.length, 4);
  assert.equal(requests[0].status, "used");
});

test("the emailed link works for staff too, and the email is matched case-insensitively", async () => {
  const r = await call("POST", "/api/auth/email-link", { body: { email: "Sam@TheTechFestival.com" } });
  assert.equal(r.status, 200);
  await settle();
  const token = new URL(sent[0].link).searchParams.get("token");
  const v = await call("POST", "/api/auth/email-link/verify", { body: { token } });
  assert.equal(v.status, 200, JSON.stringify(v.body));
  assert.equal(jwt.verify(v.body.token, process.env.JWT_SECRET).via, "email");
});

test("volunteers and ticketless accounts sign in by code", async () => {
  for (const email of ["val@example.com", "vic@example.com"]) {
    const r = await signInByCode(email);
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
    assert.equal(r.decoded.via, "email");
    assert.equal(r.body.created, false);
  }
  assert.equal(sent.filter((s) => s.kind === "no-ticket").length, 0);
});

test("a stranger gets the no-ticket email, no code and no account; same answer as everyone", async () => {
  const r = await call("POST", "/api/auth/email-link", { body: { email: "nobody@example.com" } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { sent: true });
  await settle();
  assert.deepEqual(sent.map((s) => s.kind), ["no-ticket"]);
  assert.equal(requests.length, 0);
  const v = await call("POST", "/api/auth/email-link/verify", { body: { email: "nobody@example.com", code: "123456" } });
  assert.equal(v.status, 400);
  assert.equal(users.length, 4);
});

test("a guest ticket email still gets a code and its account is made on verify", async () => {
  guests = [{ _id: oid(), name: "Gia Guest", email: "gia@example.com", ticketId: "cccc2222dddd", ticketType: "connect", purchaseDate: new Date() }];
  const r = await signInByCode("gia@example.com");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.created, true);
  const made = users.find((u) => u.email === "gia@example.com");
  assert.equal(made.role, "user");
  assert.deepEqual(made.tickets.map((t) => t.ticketId), ["cccc2222dddd"]);
  assert.equal(String(guests[0].claimedBy), String(made._id));
});

test("signing in by code never moves a pass that carries a staff member's email onto their account", async () => {
  guests = [{ _id: oid(), name: "Dr. Speaker", email: "sam@thetechfestival.com", ticketId: "eeee3333ffff", ticketType: "speaker", purchaseDate: new Date() }];
  const r = await signInByCode("sam@thetechfestival.com");
  assert.equal(r.status, 200);
  assert.equal(P.staff.tickets.length, 0);
  assert.equal(guests[0].claimedBy, undefined);
});

test("rate limits and wrong-code locks still apply", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call("POST", "/api/auth/email-link", { body: { email: "sam@thetechfestival.com" } })).status, 200);
  const r = await call("POST", "/api/auth/email-link", { body: { email: "sam@thetechfestival.com" } });
  assert.equal(r.status, 429);
  await settle();
  for (let i = 0; i < 4; i++) {
    const v = await call("POST", "/api/auth/email-link/verify", { body: { email: "sam@thetechfestival.com", code: "000000" } });
    assert.equal(v.status, 400);
  }
  const locked = await call("POST", "/api/auth/email-link/verify", { body: { email: "sam@thetechfestival.com", code: "000000" } });
  assert.match(locked.body.error, /Too many wrong codes/);
  const right = await call("POST", "/api/auth/email-link/verify", { body: { email: "sam@thetechfestival.com", code: sent.at(-1).code } });
  assert.equal(right.status, 400);   // locked: even the right code no longer works
});

/* ---------- what an email-code token can and can't do ---------- */
test("admin panel routes refuse a staff email-code token with a clear message", async () => {
  const { body: { token } } = await signInByCode("sam@thetechfestival.com");
  const cms = await call("GET", "/api/cms/status", { token });
  assert.equal(cms.status, 403);
  assert.deepEqual(cms.body, { error: PASSWORD_REQUIRED, code: PASSWORD_REQUIRED_CODE });
  assert.equal(cms.body.error, "Sign in to the admin panel with your staff password.");
  const mgmt = await call("GET", "/api/admin/management-only", { token });
  assert.equal(mgmt.status, 403);
  assert.equal(mgmt.body.code, PASSWORD_REQUIRED_CODE);
});

test("a pass-ID token is refused by the admin panel too; non-staff still get Admin only", async () => {
  const ticket = jwt.sign(tokenClaims(P.staff, VIA_TICKET), process.env.JWT_SECRET);
  assert.equal((await call("GET", "/api/cms/status", { token: ticket })).body.code, PASSWORD_REQUIRED_CODE);
  const attendeeEmail = jwt.sign(tokenClaims(P.attendee, VIA_EMAIL), process.env.JWT_SECRET);
  const r = await call("GET", "/api/cms/status", { token: attendeeEmail });
  assert.equal(r.status, 403);
  assert.equal(r.body.error, "Admin only");
});

test("password tokens are unchanged: staff sign-in, admin panel login and older tokens open the panel", async () => {
  // The apps' staff screen (staffOnly) and the admin panel login both use POST /auth/login.
  for (const staffOnly of [true, undefined]) {
    const login = await call("POST", "/api/auth/login", { body: { email: "sam@thetechfestival.com", password: PASSWORD, staffOnly } });
    assert.equal(login.status, 200, JSON.stringify(login.body));
    const decoded = jwt.verify(login.body.token, process.env.JWT_SECRET);
    assert.equal(decoded.via, undefined);
    assert.equal((await call("GET", "/api/cms/status", { token: login.body.token })).status, 200);
    assert.equal((await call("GET", "/api/admin/management-only", { token: login.body.token })).status, 200);
  }
  // A token from before the claim existed.
  assert.equal((await call("GET", "/api/cms/status", { token: passwordToken(P.staff) })).status, 200);
});

test("door check-in accepts staff and volunteer email-code tokens", async () => {
  for (const email of ["sam@thetechfestival.com", "val@example.com"]) {
    P.attendee.tickets[0].checkedIn = false;
    const { body: { token } } = await signInByCode(email);
    const r = await call("POST", "/api/checkin/scan", { token, body: { ticketId: "TECHFEST:aaaa1111bbbb" } });
    assert.equal(r.status, 200, `${email}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.status, "success");
    assert.equal(r.body.name, "Ada Attendee");
  }
  // An attendee's email-code token still can't check people in (no checkIn right).
  const { body: { token } } = await signInByCode("ada@example.com");
  assert.equal((await call("POST", "/api/checkin/scan", { token, body: { ticketId: "aaaa1111bbbb" } })).status, 403);
});

test("in-app moderation and removing anyone's post work with a staff email-code token", async () => {
  const post = new SocialPost({ authorId: P.attendee._id, authorName: "Ada Attendee", body: "Hello", status: "held" });
  posts = [post];
  const { body: { token } } = await signInByCode("sam@thetechfestival.com");

  const me = await call("GET", "/api/auth/me", { token });
  assert.equal(me.status, 200);
  assert.equal(me.body.role, "admin");
  assert.equal(me.body.rights.moderate, true);
  assert.equal(me.body.rights.deleteAnyPost, true);
  assert.equal(me.body.rights.checkIn, true);

  const approve = await call("POST", `/api/social/admin/post/${post._id}/status`, { token, body: { status: "approved" } });
  assert.equal(approve.status, 200, JSON.stringify(approve.body));
  assert.equal(post.status, "approved");

  const removed = await call("DELETE", `/api/social/feed/${post._id}`, { token });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  assert.equal(removed.body.removed, "hidden");
  assert.equal(String(post.removedBy), String(P.staff._id));
});

test("refreshing keeps the claim: an email token never turns into a password token", async () => {
  const { body: { token } } = await signInByCode("sam@thetechfestival.com");
  const r = await call("POST", "/api/auth/refresh", { token });
  assert.equal(r.status, 200);
  const decoded = jwt.verify(r.body.token, process.env.JWT_SECRET);
  assert.equal(decoded.via, "email");
  assert.equal((await call("GET", "/api/cms/status", { token: r.body.token })).status, 403);
  // A password token refreshes to a password token, as before.
  const p = await call("POST", "/api/auth/refresh", { token: passwordToken(P.staff) });
  assert.equal(jwt.verify(p.body.token, process.env.JWT_SECRET).via, undefined);
  assert.equal((await call("GET", "/api/cms/status", { token: p.body.token })).status, 200);
});

test("requireAdmin: password token passes, email token gets 403 password_required", async () => {
  const run = (token) => new Promise((resolve) => {
    const req = { headers: { authorization: `Bearer ${token}` } };
    const res = { status(code) { this.code = code; return this; }, json(body) { resolve({ code: this.code, body }); } };
    requireAdmin(req, res, () => resolve({ next: true, user: req.user }));
  });
  const ok = await run(passwordToken(P.staff));
  assert.equal(ok.next, true);
  assert.equal(String(ok.user._id), String(P.staff._id));
  const no = await run(jwt.sign(tokenClaims(P.staff, VIA_EMAIL), process.env.JWT_SECRET));
  assert.deepEqual(no, { code: 403, body: { error: PASSWORD_REQUIRED, code: PASSWORD_REQUIRED_CODE } });
});

test("ticket ID sign-in still refuses staff, and says the emailed code works", async () => {
  P.staff.tickets.push({ ticketId: "abab1212cdcd", type: "power", purchaseDate: new Date() });
  const r = await call("POST", "/api/auth/ticket-login", { body: { lastName: "Staff", ticketId: "abab1212cdcd" } });
  assert.equal(r.status, 400);
  assert.equal(r.body.error, "Staff accounts sign in with a code sent to their email or their password.");
  const a = await call("POST", "/api/auth/ticket-login", { body: { lastName: "Attendee", ticketId: "aaaa1111bbbb" } });
  assert.equal(a.status, 200);
  assert.equal(jwt.verify(a.body.token, process.env.JWT_SECRET).via, "ticket");
});

test("wallet: staff fetch someone else's pass only with a password token; their own works by email", async () => {
  const email = (await signInByCode("sam@thetechfestival.com")).body.token;
  const other = await call("GET", "/api/wallet/pass/aaaa1111bbbb", { token: email });
  assert.equal(other.status, 404);
  assert.equal(other.body.error, "Ticket not found on this account");
  // With a password token the lookup finds the attendee's ticket (then stops: no Wallet certificates here).
  const pw = await call("GET", "/api/wallet/pass/aaaa1111bbbb", { token: passwordToken(P.staff) });
  assert.equal(pw.status, 503);
  // An attendee's own pass by email code: found (same 503 for the missing certificates).
  const ada = (await signInByCode("ada@example.com")).body.token;
  assert.equal((await call("GET", "/api/wallet/pass/aaaa1111bbbb", { token: ada })).status, 503);
});
