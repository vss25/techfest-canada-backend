/* =========================================================
   Graceful shutdown (Oct 24 2026)
   ---------------------------------------------------------
   Render stops an instance with SIGTERM on every deploy and restart
   (and kills it about 30 s later). Without this the process died at
   once, in the middle of whatever requests it was answering: a
   check-in desk tap could be half-written (contract C2 copes, but a
   finished tap is better). On SIGTERM: stop taking new connections,
   ask long-lived responses to end (`beforeClose`: the desk's live
   streams say "reconnect", and the devices reconnect to another
   instance), let the requests in flight finish for up to `timeoutMs`,
   then `onClosed` (the database connection) and exit. Whatever is
   still open after `timeoutMs` is cut off and the process exits.
========================================================= */

/**
 * @param {import("node:http").Server} server
 * @param {object} [o]
 * @param {number} [o.timeoutMs]  how long requests in flight get to finish (default 10 s)
 * @param {string[]} [o.signals]  the signals that start it (default SIGTERM)
 * @param {Function} [o.beforeClose]  called first (end long-lived responses), errors ignored
 * @param {Function} [o.onClosed]  awaited once the server is closed or the time is up (close the database), errors ignored
 * @param {Function} [o.exit]  (code) → void, default process.exit
 * @param {object} [o.log]  console-like
 * @returns {(reason?: string) => Promise<void>}  the shutdown itself (tests call it; a second call waits for the first)
 */
export function installGracefulShutdown(server, {
  timeoutMs = 10 * 1000, signals = ["SIGTERM"], beforeClose = () => {}, onClosed = async () => {}, exit = (code) => process.exit(code), log = console,
} = {}) {
  let running = null;
  const shutdown = (reason = "shutdown") => {
    if (running) return running;
    running = new Promise((resolve) => {
      log.log?.(`${reason}: no new connections; finishing the requests in flight (up to ${Math.round(timeoutMs / 1000)} s)`);
      let done = false;
      let idle = null;
      const finish = async (why) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        clearInterval(idle);
        if (why === "timeout") {
          log.warn?.("Shutdown: requests still open after the wait; closing them");
          try { server.closeAllConnections?.(); } catch { /* gone */ }
        }
        try { await onClosed(); } catch (err) { log.error?.("Shutdown: closing down:", err?.message || err); }
        resolve();
        exit(0);
      };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      try { beforeClose(); } catch (err) { log.error?.("Shutdown: ending live responses:", err?.message || err); }
      // Stops listening; calls back once every connection has closed. Keep-alive connections are closed as soon as
      // they're idle: now, and each one once its request in flight is answered (Node would leave it open for seconds).
      server.close(() => finish("closed"));
      const closeIdle = () => { try { server.closeIdleConnections?.(); } catch { /* older Node */ } };
      closeIdle();
      idle = setInterval(closeIdle, 250);
    });
    return running;
  };
  for (const s of signals) process.once(s, () => { shutdown(s); });
  return shutdown;
}
