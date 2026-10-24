/* Graceful shutdown (services/gracefulShutdown.js, wired in server.js): on SIGTERM (every Render deploy / restart) the
   server stops taking connections, long-lived responses are asked to end, requests in flight finish (a check-in desk
   tap half-written isn't cut off), then the database closes and the process exits; whatever is still open after the
   wait is cut off. A plain local HTTP server; no database, nothing leaves the machine. */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { installGracefulShutdown } from "../services/gracefulShutdown.js";

const quiet = { log() {}, warn() {}, error() {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A server whose /slow answers when `release()` is called; /fast at once. */
async function serverWithSlowRoute() {
  let release;
  const released = new Promise((r) => { release = r; });
  let started;
  const slowStarted = new Promise((r) => { started = r; });
  const server = http.createServer(async (req, res) => {
    if (req.url === "/slow") { started(); await released; }
    res.end(`done ${req.url}`);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}`;
  return { server, url, release, slowStarted };
}

test("SIGTERM: no new connections, the request in flight finishes, then the database closes and the process exits", async () => {
  const { server, url, release, slowStarted } = await serverWithSlowRoute();
  const calls = [];
  const exited = new Promise((resolve) => {
    const shutdown = installGracefulShutdown(server, {
      timeoutMs: 5000, signals: [], log: quiet,
      beforeClose: () => calls.push("beforeClose"),
      onClosed: async () => { calls.push("onClosed"); },
      exit: (code) => { calls.push(`exit ${code}`); resolve(); },
    });
    globalThis.__shutdown = shutdown;
  });
  assert.equal(await (await fetch(`${url}/fast`)).text(), "done /fast", "a keep-alive connection, idle now");
  const inFlight = fetch(`${url}/slow`).then((r) => r.text());
  await slowStarted;
  const going = globalThis.__shutdown("SIGTERM");
  assert.deepEqual(calls, ["beforeClose"], "long-lived responses are asked to end first");
  // New connections are refused.
  await assert.rejects(fetch(`${url}/fast`, { headers: { connection: "close" } }), "no new connections");
  await sleep(100);
  assert.ok(!calls.includes("onClosed"), "nothing closes while a request is in flight");
  const t0 = Date.now();
  release();
  assert.equal(await inFlight, "done /slow", "the request in flight finished");
  await exited;
  await going;
  assert.ok(Date.now() - t0 < 1500, `it exits once the request is answered, not after the wait (${Date.now() - t0} ms)`);
  assert.deepEqual(calls, ["beforeClose", "onClosed", "exit 0"]);
});

test("a request still open after the wait is cut off, then the process exits anyway", async () => {
  const { server, url, slowStarted } = await serverWithSlowRoute();
  const calls = [];
  const exited = new Promise((resolve) => {
    globalThis.__shutdown2 = installGracefulShutdown(server, {
      timeoutMs: 200, signals: [], log: quiet,
      onClosed: async () => { calls.push("onClosed"); },
      exit: (code) => { calls.push(`exit ${code}`); resolve(); },
    });
  });
  const hung = fetch(`${url}/slow`).then(() => "answered", () => "cut off");
  await slowStarted;
  const t0 = Date.now();
  globalThis.__shutdown2("SIGTERM");
  await exited;
  assert.ok(Date.now() - t0 >= 180, "it waited");
  assert.deepEqual(calls, ["onClosed", "exit 0"]);
  assert.equal(await hung, "cut off");
});

test("server.js stops gracefully on SIGTERM (the check-in desk's streams told to reconnect, the database closed after)", () => {
  const src = fs.readFileSync(new URL("../server.js", import.meta.url), "utf8");
  assert.match(src, /const server = app\.listen\(/);
  assert.match(src, /installGracefulShutdown\(server,[\s\S]*beforeClose: endStreams[\s\S]*mongoose\.disconnect\(\)/);
});

test("the desk's live streams end with \"reconnect\" when the instance shuts down", async () => {
  const Log = await import("../services/checkinDeskLog.js");
  const ended = [];
  const a = { send() {}, end() { ended.push("a"); } };
  const b = { send() {} }; // (a stream still catching up: no end yet)
  const leaveA = Log.subscribe(a);
  const leaveB = Log.subscribe(b);
  Log.endStreams();
  assert.deepEqual(ended, ["a"]);
  leaveA(); leaveB();
});
