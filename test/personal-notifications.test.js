import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanLink, validateNotify, recipientFilter, recipientDTO, notificationDTO, groupHistory,
  parseSince, parseReadBody, ON_APP_FILTER, MAX_RECIPIENTS,
} from "../services/notifyHelpers.js";

const id = (n) => String(n).padStart(24, "a");

test("cleanLink allows app screens, sessions and https pages only", () => {
  assert.equal(cleanLink(""), "");
  assert.equal(cleanLink(undefined), "");
  assert.equal(cleanLink("ttfc://tab/schedule"), "ttfc://tab/schedule");
  assert.equal(cleanLink("TTFC://tab/Profile"), "ttfc://tab/profile");
  assert.equal(cleanLink("ttfc://tab/ticket"), "ttfc://tab/ticket");
  assert.equal(cleanLink("ttfc://session/d1-5"), "ttfc://session/d1-5");
  assert.equal(cleanLink("ttfc://session/d1-5/live"), "ttfc://session/d1-5/live");
  assert.equal(cleanLink("https://thetechfestival.com/agenda"), "https://thetechfestival.com/agenda");
  assert.equal(cleanLink("  https://thetechfestival.com  "), "https://thetechfestival.com/");
  for (const bad of ["ttfc://tab/admin", "ttfc://session/../x", "ttfc://checkout-complete", "http://x.com",
    "javascript:alert(1)", "data:text/html,hi", "tel:123", "otherapp://x", "https://localhost", "https://u:p@x.com",
    "https://x.com/a b", "https://" + "a".repeat(600) + ".com"]) {
    assert.equal(cleanLink(bad), null, bad);
  }
});

test("validateNotify trims, dedupes and rejects bad input", () => {
  const ok = validateNotify({ userIds: [id(1), id(1), id(2), "nope", null], title: "  Hello   there ", body: " Hi\r\n\n\n\nsee you ", link: "ttfc://tab/home" });
  assert.deepEqual(ok.value, { userIds: [id(1), id(2)], title: "Hello there", body: "Hi\n\nsee you", link: "ttfc://tab/home" });
  assert.match(validateNotify({ userIds: [id(1)], title: "", body: "x" }).error, /title/);
  assert.match(validateNotify({ userIds: [id(1)], title: "x".repeat(81), body: "x" }).error, /80/);
  assert.match(validateNotify({ userIds: [id(1)], title: "t", body: "" }).error, /message/);
  assert.match(validateNotify({ userIds: [id(1)], title: "t", body: "x".repeat(501) }).error, /500/);
  assert.match(validateNotify({ userIds: [], title: "t", body: "b" }).error, /at least one/);
  assert.match(validateNotify({ userIds: ["bad"], title: "t", body: "b" }).error, /at least one/);
  assert.match(validateNotify({ userIds: [id(1)], title: "t", body: "b", link: "javascript:x" }).error, /link/);
  const many = Array.from({ length: MAX_RECIPIENTS + 1 }, (_, i) => id(i + 1));
  assert.match(validateNotify({ userIds: many, title: "t", body: "b" }).error, /at most/);
  assert.equal(validateNotify(null).error, "Add a title.");
  assert.equal(validateNotify({ userIds: [id(1)], title: "t", body: "b" }).value.link, "");
});

test("recipientFilter limits to unsuspended app users and searches every word", () => {
  const f = recipientFilter("priya  shopify", [id(1), "junk"]);
  assert.deepEqual(f.$and[0], ON_APP_FILTER);
  assert.deepEqual(f.$and[1], { banned: { $ne: true } });
  assert.deepEqual(f.$and[2], { _id: { $in: [id(1)] } });
  assert.equal(f.$and.length, 5);
  const fields = f.$and[3].$or.map((c) => Object.keys(c)[0]);
  assert.deepEqual(fields, ["name", "email", "organization", "jobTitle"]);
  assert.ok(f.$and[3].$or[0].name.test("Priya Raman"));
  assert.ok(f.$and[4].$or[2].organization.test("Shopify Inc"));
  // regex metacharacters are escaped
  assert.ok(recipientFilter("a.b").$and[2].$or[0].name.test("a.b"));
  assert.ok(!recipientFilter("a.b").$and[2].$or[0].name.test("axb"));
  assert.equal(recipientFilter("").$and.length, 2);
});

test("ON_APP_FILTER matches the app's onApp rule", () => {
  const match = (u) => ON_APP_FILTER.$or.some((c) => {
    const [k, v] = Object.entries(c)[0];
    return v && typeof v === "object" ? u[k] != null : u[k] === v;
  });
  assert.equal(match({ appOnboarded: true }), true);
  assert.equal(match({ lastActiveAt: new Date() }), true);
  assert.equal(match({ appOnboarded: false }), false);
  assert.equal(match({}), false);
});

test("recipientDTO and notificationDTO shape", () => {
  const r = recipientDTO({ _id: id(1), name: "Priya", email: "p@x.com", organization: "Shopify", jobTitle: "CTO", avatarVersion: 3, lastActiveAt: "2026-10-01" });
  assert.deepEqual(r, { id: id(1), name: "Priya", email: "p@x.com", company: "Shopify", jobTitle: "CTO",
    avatarUrl: `/api/files/avatar/${id(1)}?v=3`, lastActiveAt: "2026-10-01" });
  assert.equal(recipientDTO({ _id: id(2) }).avatarUrl, "");
  const n = notificationDTO({ _id: id(9), userId: id(1), title: "T", body: "B", createdAt: "x", sentBy: id(3), sentByName: "Nicole" });
  assert.deepEqual(n, { id: id(9), title: "T", body: "B", link: "", kind: "personal", sentByName: "Nicole", createdAt: "x", readAt: null });
  assert.equal("userId" in n, false);
});

test("groupHistory groups sends with per-recipient read status", () => {
  const rows = [
    { _id: "n3", batchId: "b2", userId: id(3), title: "Later", body: "x", createdAt: 3, readAt: null, sentByName: "Nicole" },
    { _id: "n2", batchId: "b1", userId: id(2), title: "First", body: "y", createdAt: 2, readAt: 5, link: "ttfc://tab/home" },
    { _id: "n1", batchId: "b1", userId: id(1), title: "First", body: "y", createdAt: 2, readAt: null },
    { _id: "n0", batchId: "", userId: id(9), title: "Old", body: "z", createdAt: 1 },
  ];
  const names = new Map([[id(1), "Priya Raman"], [id(2), "Sam Lee"], [id(3), "Ana"]]);
  const g = groupHistory(rows, names);
  assert.equal(g.length, 3);
  assert.equal(g[0].id, "b2");
  assert.deepEqual(g[1].recipients.map((r) => r.name), ["Sam Lee", "Priya Raman"]);
  assert.equal(g[1].readCount, 1);
  assert.equal(g[1].total, 2);
  assert.equal(g[1].link, "ttfc://tab/home");
  assert.equal(g[2].recipients[0].name, "Deleted account");
  assert.equal(groupHistory(rows, names, 1).length, 1);
});

test("parseSince and parseReadBody", () => {
  assert.equal(parseSince(""), null);
  assert.equal(parseSince("garbage"), null);
  assert.equal(parseSince("2026-10-06T10:00:00Z").toISOString(), "2026-10-06T10:00:00.000Z");
  assert.deepEqual(parseReadBody({ all: true }), { all: true });
  assert.deepEqual(parseReadBody({ ids: [id(1), id(1), "x"] }), { ids: [id(1)] });
  assert.equal(parseReadBody({ ids: [] }), null);
  assert.equal(parseReadBody({ all: "yes" }), null);
  assert.equal(parseReadBody(undefined), null);
});
