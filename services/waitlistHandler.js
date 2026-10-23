/* =========================================================
   POST /api/stay-updated: the TTFC 2027 waitlist's request handler,
   with its storage and mailers passed in so tests can use fakes
   (test/waitlist.test.js). routes/stayUpdated.js wires the real
   WaitlistSignup model, AppContent wording and Resend.

   Order of events:
     1. A filled honeypot (`_hp`) gets the same answer as a person and
        nothing is saved or sent.
     2. Validate (services/waitlist.js validateSignup) → 400 with the
        field and the problem in plain words.
     3. Limits: per address sized for a venue's shared Wi-Fi
        (SHARED_ADDRESS) and per email (5 an hour) → 429.
     4. Save: one row per email (a repeat updates it and counts it).
     5. Answer { ok: true, message } at once (message = stay.thanks).
     6. Then, in the background: the team's email (WAITLIST_INBOX,
        enquire@; a staff alert, reply-to the person) and the person's
        "You're on the TTFC 2027 waitlist" (first sign-up, or the last
        one a day old; never to someone on the unsubscribe list).
   If the save fails the team's email is sent before answering (it is
   the only copy) and the person gets none (nothing to count it by);
   only when both fail is the answer a 500.
========================================================= */

import { makeLimiter, SHARED_ADDRESS } from "./ticketAccess.js";
import {
  CONFIRM_EVERY_MS, DEFAULT_MESSAGE, STAY_DEFAULTS, buildWaitlistAlert, confirmDue, ipHash, isHoneypotFilled, shortUserAgent,
  validateSignup, waitlistInbox,
} from "./waitlist.js";

export const FALLBACK_EMAIL = "enquire@thetechfestival.com";
export const TOO_MANY = `Too many tries. Please wait a few minutes, or email ${FALLBACK_EMAIL}.`;
export const FAILED = `Something went wrong. Please try again, or email ${FALLBACK_EMAIL}.`;

const errText = (err) => String(err?.message || err).slice(0, 300);

/**
 * @param {object} deps
 * @param {object} deps.store
 *   upsert(value, meta) → { row, first }   one row per email ($inc count, merge interests and sources)
 *   setAlert(id, set)                     the team email's outcome
 *   claimConfirmation(id, before, at)     → the row before, or null when one went out after `before`
 *                                           (sets confirmedAt = at, confirmStatus "sending" when it claims)
 *   setConfirm(id, set)                   the confirmation's outcome
 * @param {(msg) => Promise<{id}>} deps.sendAlert            { to, subject, html, text, replyTo }; throws on failure
 * @param {(msg) => Promise<{id}>} deps.sendConfirmation     { to, interests, copy }; throws on failure
 * @param {(email) => Promise<boolean>} deps.isUnsubscribed  on the unsubscribe list?
 * @param {() => Promise<object>} [deps.loadCopy]            the stay.* wording (defaults when it fails)
 */
export function makeWaitlistHandler({
  store, sendAlert, sendConfirmation, isUnsubscribed = async () => false, loadCopy = async () => STAY_DEFAULTS,
  env = process.env, adminUrl = "",
  ipLimiter = makeLimiter(SHARED_ADDRESS),
  emailLimiter = makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 }),
  now = () => new Date(),
  background = () => {},
  log = console,
}) {
  async function alertTeam(row, updated, at) {
    const to = waitlistInbox(env);
    const mail = buildWaitlistAlert(row, { updated, now: at, adminUrl });
    try {
      const r = await sendAlert({ to, ...mail });
      return { ok: true, set: { alertStatus: "sent", alertedAt: new Date(), alertId: String(r?.id || ""), alertError: "" } };
    } catch (err) {
      log.error?.("WAITLIST TEAM EMAIL ERROR:", errText(err));
      return { ok: false, set: { alertStatus: "failed", alertError: errText(err) } };
    }
  }

  async function confirm(row, copy, at) {
    if (!confirmDue(row, at)) return "recent";
    if (await isUnsubscribed(row.email)) {
      await store.setConfirm(row._id, { confirmStatus: "unsubscribed" });
      return "unsubscribed";
    }
    // Claimed in the database, so two sign-ups at once send one email.
    const before = await store.claimConfirmation(row._id, new Date(at.getTime() - CONFIRM_EVERY_MS), at);
    if (!before) return "recent";
    try {
      const r = await sendConfirmation({ to: row.email, interests: row.interests || [], copy });
      await store.setConfirm(row._id, { confirmStatus: "sent", confirmId: String(r?.id || ""), confirmError: "" });
      return "sent";
    } catch (err) {
      log.error?.("WAITLIST CONFIRMATION EMAIL ERROR:", errText(err));
      // Not sent: the next sign-up may try again.
      await store.setConfirm(row._id, { confirmStatus: "failed", confirmError: errText(err), confirmedAt: before.confirmedAt || null });
      return "failed";
    }
  }

  return async function joinWaitlist(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const copy = await Promise.resolve().then(loadCopy).catch(() => STAY_DEFAULTS);
      const message = String(copy?.["stay.thanks"] || "").trim() || DEFAULT_MESSAGE;
      const ok = { ok: true, message };

      // A bot that filled the hidden field gets the same answer as a person, so it doesn't adapt.
      if (isHoneypotFilled(body)) return res.status(200).json(ok);

      const check = validateSignup(body);
      const ipOk = ipLimiter.hit(String(req.ip || "unknown"));
      if (!check.ok) {
        if (!ipOk) return res.status(429).json({ ok: false, error: TOO_MANY });
        return res.status(400).json({ ok: false, field: check.field, error: check.error });
      }
      const v = check.value;
      const emailOk = emailLimiter.hit(v.email);
      if (!ipOk || !emailOk) return res.status(429).json({ ok: false, error: TOO_MANY });

      const at = now();
      const meta = { at, ipHash: ipHash(req.ip), userAgent: shortUserAgent(req.headers?.["user-agent"]) };
      let saved = null;
      try {
        saved = await store.upsert(v, meta);
      } catch (err) {
        log.error?.("WAITLIST SAVE ERROR (emailing the team anyway):", errText(err));
      }

      if (saved?.row) {
        res.status(200).json(ok);
        const { row, first } = saved;
        const job = Promise.all([
          alertTeam(row, !first, at).then(({ set }) => store.setAlert(row._id, set)),
          confirm(row, copy, at),
        ]).catch((err) => log.error?.("WAITLIST BACKGROUND ERROR:", errText(err)));
        background(job);
        return undefined;
      }

      // Not saved: the team's email is the only copy, so wait for it.
      const sent = await alertTeam({ ...v, interests: v.interests, lastInterests: v.interests, sources: [v.source], count: 1, createdAt: at, lastSubmittedAt: at }, false, at);
      if (sent.ok) return res.status(200).json(ok);
      return res.status(500).json({ ok: false, error: FAILED });
    } catch (err) {
      log.error?.("WAITLIST ERROR:", errText(err));
      if (!res.headersSent) res.status(500).json({ ok: false, error: FAILED });
      return undefined;
    }
  };
}
