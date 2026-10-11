/* =========================================================
   POST /api/rsvp/lookup, POST /api/rsvp and GET /api/rsvp/options —
   the request handlers, with storage and data sources passed in so
   tests (test/rsvp.test.js) and a local preview can use fakes.
   routes/rsvp.js wires the real User / Attendee / Rsvp models and
   the Sanity speaker list.

   Lookup ("who is this?"), in order:
     1. Ticket ID + last name → that ticket's pass, verified. The ticket is
        found and the name checked exactly as the app's ticket sign-in does.
     2. First AND last name on the public speaker list → speaker (everything).
     3. First AND last name of exactly one ticket holder → their pass, unverified.
     4. Otherwise nothing.
   Only the kind of match and the pass ever leave the server: never an email,
   ticket ID or anything else about the person.
========================================================= */

import { makeLimiter } from "./ticketAccess.js";
import { cleanText, isHoneypotFilled, botReason } from "./brochureDownloads.js";
import {
  cleanLookup, foldName, personNameKey, matchSpeaker, matchHolder, tierFromTicketType,
  validateRsvp, resolvePass, checkOptions, rsvpKeys, rsvpOptionsPayload, TIER_LABELS,
} from "./rsvp.js";

export const FALLBACK_EMAIL = "enquire@thetechfestival.com";
export const TOO_MANY = `Too many requests. Please try again in a few minutes or email ${FALLBACK_EMAIL}.`;
export const FAILED = `Something went wrong. Please try again, or email ${FALLBACK_EMAIL}.`;

const NONE = Object.freeze({ kind: "none", verified: false });

/** A value loaded at most once per `ttlMs` (failures are retried on the next call). */
export function cached(loader, ttlMs, now = () => Date.now()) {
  let value;
  let expires = 0;
  let pending = null;
  return () => {
    if (now() < expires) return Promise.resolve(value);
    if (!pending) {
      pending = Promise.resolve().then(loader).then((v) => { value = v; expires = now() + ttlMs; return v; })
        .finally(() => { pending = null; });
    }
    return pending;
  };
}

const hasFirstAndLast = (q) => !!foldName(q.firstName) && foldName(q.lastName).length >= 2;

/**
 * @param {object} deps
 * @param {(ticketId: string, lastName: string) => Promise<{ticketId: string, type: string} | null>} deps.verifyTicket
 * @param {() => Promise<Array>} deps.getHolders    buildHolderIndex() output
 * @param {() => Promise<string[]>} deps.getSpeakers public speaker names
 */
export function makeLookup({ verifyTicket, getHolders, getSpeakers }) {
  /** Internal result: also carries the verified ticket ID (never sent to the browser). */
  return async function lookup(q) {
    let ticket = null;
    if (q.ticketId && foldName(q.lastName).length >= 2) ticket = await verifyTicket(q.ticketId, q.lastName);
    const both = hasFirstAndLast(q);

    const speaker = both ? matchSpeaker(await getSpeakers(), q.firstName, q.lastName) : "";
    if (speaker) return { kind: "speaker", tier: "speaker", verified: true, displayName: speaker, ticket };
    if (ticket) return { kind: "ticket", tier: tierFromTicketType(ticket.type), verified: true, displayName: q.firstName, ticket };
    if (both) {
      const holder = matchHolder(await getHolders(), q.firstName, q.lastName);
      if (holder) return { kind: "ticket", tier: holder.tier, verified: false, displayName: q.firstName, ticket: null };
    }
    return { ...NONE, ticket: null };
  };
}

/** What the browser is told. */
export function publicLookup(r, q = {}) {
  const out = { kind: r.kind, verified: !!r.verified };
  if (r.tier) { out.tier = r.tier; out.tierLabel = TIER_LABELS[r.tier] || ""; }
  if (r.displayName) out.displayName = cleanText(r.displayName).slice(0, 80);
  if (q.ticketId) out.ticketMatched = !!r.ticket;
  return out;
}

const isDuplicateKey = (err) => err?.code === 11000 || /E11000/.test(String(err?.message || ""));

/**
 * @param {object} deps
 * @param {(q: object) => Promise<object>} deps.lookup       makeLookup() result
 * @param {object} deps.store
 * @param {(keys: string[]) => Promise<object|null>} deps.store.findByKeys   first non-bot RSVP holding one of the keys (in key order)
 * @param {(doc: object) => Promise<object>} deps.store.insert
 * @param {(id: any, set: object) => Promise<object>} deps.store.update      also bumps `submissions`
 */
export function makeRsvpHandlers({
  lookup, store, log = console,
  lookupIpLimiter = makeLimiter({ max: 40, windowMs: 15 * 60 * 1000 }),
  lookupNameLimiter = makeLimiter({ max: 12, windowMs: 15 * 60 * 1000 }),
  lookupTicketLimiter = makeLimiter({ max: 8, windowMs: 15 * 60 * 1000 }),
  submitIpLimiter = makeLimiter({ max: 12, windowMs: 15 * 60 * 1000 }),
  submitNameLimiter = makeLimiter({ max: 8, windowMs: 60 * 60 * 1000 }),
}) {
  const ipOf = (req) => String(req.ip || "unknown");

  async function lookupHandler(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      // Bots that fill the hidden field learn nothing.
      if (isHoneypotFilled(body)) return res.json({ ...NONE });
      if (!lookupIpLimiter.hit(ipOf(req))) return res.status(429).json({ ...NONE, error: TOO_MANY });
      const q = cleanLookup(body);
      const both = hasFirstAndLast(q);
      const withTicket = !!q.ticketId && foldName(q.lastName).length >= 2;
      // One name alone could be used to fish for who holds which pass.
      if (!both && !withTicket) return res.json({ ...NONE });
      if (both && !lookupNameLimiter.hit(`n:${personNameKey(q.firstName, q.lastName)}`)) return res.status(429).json({ ...NONE, error: TOO_MANY });
      if (withTicket && !lookupTicketLimiter.hit(`t:${q.ticketId}`)) return res.status(429).json({ ...NONE, error: TOO_MANY });
      const r = await lookup(q);
      return res.json(publicLookup(r, q));
    } catch (err) {
      log.error?.("RSVP LOOKUP ERROR:", err?.message || err);
      // Not finding someone just means they pick their pass themselves.
      return res.json({ ...NONE });
    }
  }

  async function submitHandler(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const OK = { success: true, message: "RSVP saved" };
      if (isHoneypotFilled(body)) return res.status(201).json(OK);
      if (!submitIpLimiter.hit(ipOf(req))) return res.status(429).json({ success: false, message: TOO_MANY });

      const check = validateRsvp(body);
      if (!check.ok) return res.status(400).json({ success: false, message: check.error, field: check.field });
      const v = check.value;
      if (!submitNameLimiter.hit(personNameKey(v.firstName, v.lastName))) return res.status(429).json({ success: false, message: TOO_MANY });

      const userAgent = cleanText(req.headers?.["user-agent"]).slice(0, 300);
      const fillMs = Number.isFinite(Number(body.elapsedMs)) ? Math.max(0, Math.round(Number(body.elapsedMs))) : undefined;
      const base = {
        firstName: v.firstName, lastName: v.lastName, name: `${v.firstName} ${v.lastName}`,
        nameKey: personNameKey(v.firstName, v.lastName), email: v.email, ticketId: v.ticketId,
        days: v.days, dietary: v.dietary, dietaryOther: v.dietaryOther, accessibility: v.accessibility,
        page: v.page, userAgent, fillMs,
      };

      // Bot (random-text names, filled in instantly): kept for review in its own row,
      // never merged into a real person's RSVP. Same answer, so it doesn't adapt.
      const bot = botReason(v, body);
      if (bot) {
        await store.insert({
          ...base, key: `spam:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind: "none",
          tier: v.tier || "", tierVerified: false, chosenTier: v.tier, options: [], spam: true, spamReason: bot,
        });
        return res.status(201).json(OK);
      }

      // Work the pass out again here: the browser's answer is never trusted.
      const found = await lookup({ firstName: v.firstName, lastName: v.lastName, ticketId: v.ticketId });
      const pass = resolvePass(found, v.tier);
      if (!pass.ok) return res.status(400).json({ success: false, message: pass.error, field: pass.field });
      const opts = checkOptions(pass.tier, v.days, v.options);
      if (!opts.ok) return res.status(400).json({ success: false, message: opts.error, field: "options", invalid: opts.invalid });

      const ticketVerified = !!found.ticket;
      const keys = rsvpKeys({ ticketId: found.ticket?.ticketId || v.ticketId, ticketVerified, firstName: v.firstName, lastName: v.lastName });
      const doc = {
        ...base, key: keys[0],
        ticketId: ticketVerified ? found.ticket.ticketId : v.ticketId, ticketVerified,
        kind: pass.kind, tier: pass.tier, tierVerified: pass.tierVerified,
        chosenTier: v.tier, detectedTier: pass.detectedTier || "",
        options: opts.options, spam: false, spamReason: "",
      };

      const write = async () => {
        const existing = await store.findByKeys(keys);
        if (!existing) return { saved: await store.insert({ ...doc, submissions: 1 }), updated: false };
        // A later RSVP without an email or ticket ID keeps the ones given before.
        const set = { ...doc };
        if (!set.email && existing.email) delete set.email;
        if (!set.ticketId && existing.ticketId) { delete set.ticketId; delete set.ticketVerified; }
        return { saved: await store.update(existing._id, set), updated: true };
      };
      let result;
      try {
        result = await write();
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        result = await write(); // two submissions at once: the other one won, update it
      }

      return res.status(201).json({
        ...OK, id: String(result.saved?._id ?? ""), updated: result.updated,
        kind: pass.kind, tier: pass.tier, tierLabel: TIER_LABELS[pass.tier], tierVerified: pass.tierVerified,
      });
    } catch (err) {
      log.error?.("RSVP SUBMIT ERROR:", err);
      if (!res.headersSent) res.status(500).json({ success: false, message: FAILED });
      return undefined;
    }
  }

  function optionsHandler(req, res) {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.json(rsvpOptionsPayload());
  }

  return { lookup: lookupHandler, submit: submitHandler, options: optionsHandler };
}
