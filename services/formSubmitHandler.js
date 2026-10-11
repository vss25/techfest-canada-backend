/* =========================================================
   POST /api/forms/:form — the request handler, with its storage
   and mailer passed in so tests can use fakes
   (test/form-submissions.test.js). routes/forms.js wires the real
   FormSubmission model and Resend.

   Order of events:
     1. Validate. Unknown form → 404, bad input → 400.
     2. Save (FormSubmission). Bots are saved as spam and never emailed.
     3. Answer 201 straight away.
     4. Then, in the background, email FORMS_INBOX and record the outcome.
   If the save fails the email is sent before answering; only when both
   fail does the visitor get a 500.
========================================================= */

import { makeLimiter } from "./ticketAccess.js";
import { cleanText } from "./brochureDownloads.js";
import { validateFormSubmission, formBotReason, isHoneypotFilled, formsInbox, buildFormEmail } from "./formSubmissions.js";

export const FALLBACK_EMAIL = "baldeep@thetechfestival.com";
export const TOO_MANY = `Too many requests. Please try again later or email ${FALLBACK_EMAIL}.`;
export const FAILED = `Something went wrong. Please try again, or email ${FALLBACK_EMAIL}.`;
const OK = { success: true, message: "Thanks! We received your submission." };

/**
 * @param {object} deps
 * @param {(doc: object) => Promise<object>} deps.save            create a FormSubmission, resolves to the saved doc (with _id)
 * @param {(id: any, set: object) => Promise<any>} deps.update    record the email outcome
 * @param {(msg: object) => Promise<{id?: string}>} deps.send     send { to, subject, html, text, replyTo }; throws on failure
 * @param {object} [deps.env]                                     for FORMS_INBOX
 * @param {object} [deps.ipLimiter] / [deps.emailLimiter]         makeLimiter() instances
 * @param {(p: Promise) => void} [deps.background]                tests await this to see the background email
 */
export function makeFormSubmitHandler({
  save, update, send, env = process.env,
  ipLimiter = makeLimiter({ max: 10, windowMs: 15 * 60 * 1000 }),
  emailLimiter = makeLimiter({ max: 5, windowMs: 60 * 60 * 1000 }),
  adminUrl = "",
  background = () => {},
  log = console,
}) {
  async function deliver(doc) {
    const to = formsInbox(env);
    const mail = buildFormEmail(doc, { adminUrl });
    try {
      const r = await send({ to, ...mail });
      return { ok: true, set: { emailStatus: "sent", emailTo: to, emailedAt: new Date(), emailId: cleanText(r?.id), emailError: "" } };
    } catch (err) {
      const emailError = String(err?.message || err).slice(0, 300);
      log.error?.("FORM EMAIL ERROR:", emailError);
      return { ok: false, set: { emailStatus: "failed", emailTo: to, emailError } };
    }
  }

  return async function submitForm(req, res) {
    try {
      const form = String(req.params?.form || "");
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const check = validateFormSubmission(form, body);
      const honeypot = isHoneypotFilled(body);
      const ipOk = ipLimiter.hit(String(req.ip || "unknown"));

      if (!check.ok) {
        if (check.status === 404) return res.status(404).json({ success: false, message: check.error });
        // A bot that filled the hidden field gets the same answer as a person, so it doesn't adapt.
        if (honeypot) return res.status(201).json(OK);
        if (!ipOk) return res.status(429).json({ success: false, message: TOO_MANY });
        return res.status(400).json({ success: false, message: check.error, field: check.field });
      }

      const v = check.value;
      const bot = formBotReason(v, body);
      const emailOk = v.email ? emailLimiter.hit(`${form}:${v.email}`) : true;
      if (!ipOk || !emailOk) {
        if (bot) return res.status(201).json(OK);
        return res.status(429).json({ success: false, message: TOO_MANY });
      }

      const userAgent = cleanText(req.headers?.["user-agent"]).slice(0, 300);
      let doc = null;
      try {
        doc = await save({
          ...v, userAgent, source: "website", status: "new",
          emailStatus: bot ? "blocked" : "sending", spam: !!bot, spamReason: bot,
        });
      } catch (err) {
        log.error?.("FORM SAVE ERROR (emailing anyway):", err?.message || err);
      }

      // Bots: saved for review, never emailed.
      if (bot) return res.status(201).json(OK);

      if (doc) {
        res.status(201).json({ ...OK, id: String(doc._id ?? "") });
        const job = deliver(doc).then(({ set }) => update(doc._id, set))
          .catch((err) => log.error?.("FORM EMAIL STATUS SAVE ERROR:", err?.message || err));
        background(job);
        return undefined;
      }

      // Not saved: the email is the only copy, so wait for it.
      const sent = await deliver({ ...v, createdAt: new Date() });
      if (sent.ok) return res.status(201).json(OK);
      return res.status(500).json({ success: false, message: FAILED });
    } catch (err) {
      log.error?.("FORM SUBMIT ERROR:", err);
      if (!res.headersSent) res.status(500).json({ success: false, message: FAILED });
      return undefined;
    }
  };
}
