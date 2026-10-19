import { test, mock, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import User from "../models/User.js";
import { AdminAudit } from "../models/Admin.js";
import profileRouter, { sanitizeProfilePatch, selfHideReply, SELF_HIDE_ERROR } from "../routes/profile.js";
import {
  MIGRATION_KEY, isStaffDirectoryAudit, planDirectoryUnhide, migrateDirectorySelfHideOnce, staffDirectoryHide,
} from "../services/directoryHide.js";

/* Attendee list (Oct 18 2026): everyone is shown, only staff can hide someone. */

// The console routes construct an email client on import.
process.env.RESEND_API_KEY ||= "re_test_placeholder";
const { default: consoleRouter } = await import("../routes/console.js");

const SECRET = "directory-hide-test";
let savedSecret;
let server;
let base;
const ids = { ann: "a".repeat(24), staff: "c".repeat(24) };
let docs;

before(async () => {
  savedSecret = process.env.JWT_SECRET;
  process.env.JWT_SECRET = SECRET;
  const app = express();
  app.use(express.json());
  app.use("/api/profile", profileRouter);
  app.use("/api/console", consoleRouter);
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => {
  server?.close();
  if (savedSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = savedSecret;
});
beforeEach(() => {
  mock.restoreAll();
  docs = {
    [ids.ann]: new User({ _id: ids.ann, name: "Ann Example", email: "ann@example.test", role: "user", directoryHidden: false }),
    [ids.staff]: new User({ _id: ids.staff, name: "Sam Staff", email: "sam@example.test", role: "admin", staffRole: "management" }),
  };
  const find = (id) => docs[String(id)] || null;
  // routes/profile.js chains .select(); the console and its auth don't.
  mock.method(User, "findById", (id) => {
    const d = find(id);
    const p = Promise.resolve(d);
    p.select = () => Promise.resolve(d);
    return p;
  });
  mock.method(User.prototype, "save", async function () { return this; });
  mock.method(AdminAudit, "create", async () => ({}));
});

const call = (method, path, body, as = ids.ann) => fetch(`${base}${path}`, {
  method, headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt.sign({ id: as }, SECRET)}` },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

/* ---------- self-hide ignored ---------- */

test("profile: directoryHidden is no longer an editable field", () => {
  assert.deepEqual(sanitizeProfilePatch({ directoryHidden: true }), {});
  assert.deepEqual(sanitizeProfilePatch({ directoryHidden: true, jobTitle: " CTO " }), { jobTitle: "CTO" });
  assert.deepEqual(selfHideReply({ directoryHidden: true }), { status: 403, error: SELF_HIDE_ERROR });
  assert.deepEqual(selfHideReply({ directoryHidden: false }), { status: 200 });
  assert.equal(selfHideReply({ jobTitle: "x" }), null);
  assert.equal(selfHideReply({ directoryHidden: "yes" }), null);
});

test("profile PATCH: hiding yourself is refused with a sentence; other fields still save", async () => {
  const hide = await call("PATCH", "/profile", { directoryHidden: true });
  assert.equal(hide.status, 403);
  assert.equal(hide.body.error, SELF_HIDE_ERROR);
  assert.equal(docs[ids.ann].directoryHidden, false);

  const both = await call("PATCH", "/profile", { directoryHidden: true, jobTitle: "CTO" });
  assert.equal(both.status, 200);
  assert.equal(docs[ids.ann].jobTitle, "CTO");
  assert.equal(docs[ids.ann].directoryHidden, false, "the hide part is ignored");

  const show = await call("PATCH", "/profile", { directoryHidden: false });
  assert.equal(show.status, 200, "older apps switching it back on get a plain success");

  // Someone staff hid can't show themselves either.
  docs[ids.ann].directoryHidden = true; docs[ids.ann].directoryHiddenByStaff = true;
  await call("PATCH", "/profile", { directoryHidden: false, tagline: "Hi" });
  assert.equal(docs[ids.ann].directoryHidden, true);
  assert.equal(docs[ids.ann].directoryHiddenByStaff, true);
});

/* ---------- staff hide kept ---------- */

test("console: staff hiding someone sets both fields; showing them clears both", async () => {
  assert.equal(staffDirectoryHide("true"), true);
  assert.equal(staffDirectoryHide(1), false);
  let r = await call("PATCH", `/console/users/${ids.ann}`, { directoryHidden: true }, ids.staff);
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ["directoryHidden"]);
  assert.equal(docs[ids.ann].directoryHidden, true);
  assert.equal(docs[ids.ann].directoryHiddenByStaff, true);

  r = await call("PATCH", `/console/users/${ids.ann}`, { directoryHidden: false }, ids.staff);
  assert.equal(docs[ids.ann].directoryHidden, false);
  assert.equal(docs[ids.ann].directoryHiddenByStaff, false);

  // A legacy self-hide that staff confirm becomes a staff hide.
  docs[ids.ann].directoryHidden = true; docs[ids.ann].directoryHiddenByStaff = false;
  r = await call("PATCH", `/console/users/${ids.ann}`, { directoryHidden: true }, ids.staff);
  assert.deepEqual(r.body.changed, ["directoryHidden"]);
  assert.equal(docs[ids.ann].directoryHiddenByStaff, true);

  // Attendees can't use the console.
  assert.equal((await call("PATCH", `/console/users/${ids.ann}`, { directoryHidden: true }, ids.ann)).status, 403);
});

/* ---------- migration ---------- */

test("plan: only people nobody on staff ever hid or showed are shown again", () => {
  const audits = [
    { action: "edit_user", targetId: "u-staff", detail: "directoryHidden" },
    { action: "edit_user", targetId: "u-staff2", detail: "name, directoryHidden, messagesOff | types: vip" },
    { action: "edit_user", targetId: "u-self", detail: "directoryHiddenNote" },   // not the field
    { action: "edit_user", targetId: "u-self2", detail: "name, jobTitle" },
    { action: "view_messages", targetId: "u-self3", detail: "directoryHidden" },
  ];
  assert.equal(isStaffDirectoryAudit(audits[1]), true);
  assert.equal(isStaffDirectoryAudit(audits[2]), false);
  const plan = planDirectoryUnhide([
    { _id: "u-staff" }, { _id: "u-staff2" }, { _id: "u-flag", directoryHiddenByStaff: true },
    { _id: "u-self" }, { _id: "u-self2" }, { _id: "u-self3" }, { _id: "" }, null,
  ], audits);
  assert.deepEqual(plan, { unhide: ["u-self", "u-self2", "u-self3"], keep: ["u-staff", "u-staff2", "u-flag"] });
  assert.deepEqual(planDirectoryUnhide([], audits), { unhide: [], keep: [] });
});

/** In-memory stand-ins for the three models the migration uses. */
function fakes(users, audits = []) {
  const content = new Map();
  const matches = (u, q) => Object.entries(q).every(([k, v]) => {
    if (v && typeof v === "object" && "$in" in v) return v.$in.includes(String(u[k]));
    if (v && typeof v === "object" && "$ne" in v) return u[k] !== v.$ne;
    return u[k] === v;
  });
  const lean = (rows) => ({ select: () => ({ lean: async () => rows.map((r) => ({ ...r })) }) });
  return {
    users, content,
    User: {
      find: (q) => lean(users.filter((u) => matches(u, q))),
      updateMany: async (q, { $set }) => {
        let modifiedCount = 0;
        for (const u of users.filter((x) => matches(x, q))) {
          if (Object.entries($set).some(([k, v]) => u[k] !== v)) modifiedCount += 1;
          Object.assign(u, $set);
        }
        return { modifiedCount };
      },
    },
    AdminAudit: { find: () => lean(audits) },
    AppContent: {
      exists: async ({ key }) => content.has(key),
      create: async (doc) => { if (content.has(doc.key)) throw new Error("duplicate key"); content.set(doc.key, doc); return doc; },
    },
  };
}

test("migration: shows self-hidden people, never staff-hidden ones, logs counts only", async () => {
  const users = [
    { _id: "u1", name: "Self Hider", directoryHidden: true, directoryHiddenByStaff: false },
    { _id: "u2", name: "Staff Hid", directoryHidden: true, directoryHiddenByStaff: false },
    { _id: "u3", name: "Flagged", directoryHidden: true, directoryHiddenByStaff: true },
    { _id: "u4", name: "Visible", directoryHidden: false, directoryHiddenByStaff: false },
  ];
  const f = fakes(users, [{ action: "edit_user", targetType: "user", targetId: "u2", detail: "directoryHidden" }]);
  const lines = [];
  const log = { log: (m) => lines.push(m), error: (...a) => lines.push(a.join(" ")) };
  const out = await migrateDirectorySelfHideOnce({ ...f, log });
  assert.equal(out.shown, 1);
  assert.equal(out.keptStaffHidden, 2);
  assert.deepEqual(users.map((u) => [u._id, u.directoryHidden, u.directoryHiddenByStaff]), [
    ["u1", false, false], ["u2", true, true], ["u3", true, true], ["u4", false, false],
  ]);
  assert.ok(f.content.has(MIGRATION_KEY));
  assert.deepEqual(lines, ["Attendee list: 1 self-hidden people shown again, 2 staff-hidden kept hidden"]);
  assert.ok(!lines.join(" ").includes("Self Hider"), "no names in the log");
});

test("migration: idempotent (runs once; a second pass would change nothing anyway)", async () => {
  const users = [
    { _id: "u1", directoryHidden: true, directoryHiddenByStaff: false },
    { _id: "u2", directoryHidden: true, directoryHiddenByStaff: true },
  ];
  const f = fakes(users);
  const quiet = { log: () => {}, error: () => {} };
  assert.equal((await migrateDirectorySelfHideOnce({ ...f, log: quiet })).shown, 1);
  const snapshot = JSON.stringify(users);
  assert.equal(await migrateDirectorySelfHideOnce({ ...f, log: quiet }), null, "the key stops a second run");
  assert.equal(JSON.stringify(users), snapshot);

  // Even without the key, re-running finds nobody self-hidden and keeps the staff hide.
  f.content.clear();
  const again = await migrateDirectorySelfHideOnce({ ...f, log: quiet });
  assert.deepEqual([again.shown, again.keptStaffHidden], [0, 1]);
  assert.equal(JSON.stringify(users), snapshot);
});

test("migration: a failure is logged, not thrown, and leaves no key", async () => {
  const f = fakes([{ _id: "u1", directoryHidden: true }]);
  f.User.find = () => { throw new Error("db down"); };
  const errors = [];
  assert.equal(await migrateDirectorySelfHideOnce({ ...f, log: { log: () => {}, error: (...a) => errors.push(a.join(" ")) } }), null);
  assert.equal(f.content.has(MIGRATION_KEY), false);
  assert.match(errors[0], /db down/);
});
