/* =========================================================
   POST /api/rsvp/lookup, POST /api/rsvp and GET /api/rsvp/options —
   the request handlers, with storage and data sources passed in so
   tests (test/rsvp.test.js) and a local preview can use fakes.
   routes/rsvp.js wires the real User / Attendee / Rsvp models and
   the Sanity speaker list.

   Lookup ("who is this?"), in order:
     1. Ticket ID + last name → that ticket's pass, verified. The ticket is
        found and the name checked exactly as the app's ticket sign-in does,
        and every try comes out of the same per-ticket budget (ticketGuesses).
     2. First AND last name on the public speaker list → speaker (everything).
        The typed name is matched, not the ticket's: "Chris Golden" on the list
        is a speaker even when his ticket says "Christopher Golden". With a
        verified ticket, the typed last name must be its holder's too.
     3. First AND last name of exactly one ticket holder → their pass, unverified.
     4. Otherwise nothing.
   Only the kind of match and the pass ever leave the server: never an email,
   ticket ID or anything else about the person.

   Saving: one RSVP per person, but a name is not a secret, so only proof
   changes a saved RSVP: the verified ticket it was saved under, or the edit
   token its browser was given (`editToken` in the answer, sent back with a
   later RSVP). Without proof, an RSVP for a name that already has one is kept
   in a row of its own marked `duplicateOf`, left out of the headcounts until
   staff merge it or keep it as a separate person (resolveRsvpDuplicate, from
   routes/console.js). The answer looks the same either way, so it never says
   whether someone has RSVP'd.
========================================================= */

import { makeLimiter, ticketGuesses, ticketGuessKey } from "./ticketAccess.js";
import { cleanText, isHoneypotFilled, botReason } from "./brochureDownloads.js";
import {
  cleanLookup, foldName, personNameKey, matchSpeaker, matchHolder, tierFromTicketType, fullNameMatches, lastNameIs,
  validateRsvp, resolvePass, checkOptions, rsvpKeys, rsvpOptionsPayload, newEditToken, hashEditToken, planRsvpMerge,
  optionLabel, TIER_LABELS,
} from "./rsvp.js";

export const FALLBACK_EMAIL = "enquire@thetechfestival.com";
// Every RSVP limit uses a 15-minute window.
export const TOO_MANY = `Too many requests. Please try again in 15 minutes or email ${FALLBACK_EMAIL}.`;
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
/** Ticket ID + last name: what the ticket check (and its per-ticket budget) needs. */
const canCheckTicket = (q) => !!q.ticketId && foldName(q.lastName).length >= 2;

/**
 * @param {object} deps
 * @param {(ticketId: string, lastName: string) => Promise<{ticketId: string, type: string, names?: Array} | null>} deps.verifyTicket
 *        `names`: who the ticket is for (ticketPersonNames), to check the first name too
 * @param {() => Promise<Array>} deps.getHolders    buildHolderIndex() output
 * @param {() => Promise<string[]>} deps.getSpeakers public speaker names
 */
export function makeLookup({ verifyTicket, getHolders, getSpeakers, guessFromName = false }) {
  /** Internal result: also carries the verified ticket (never sent to the browser). */
  return async function lookup(q) {
    let ticket = null;
    if (canCheckTicket(q)) {
      const t = await verifyTicket(q.ticketId, q.lastName);
      // The ticket check needs only the last name; `holderMatch` says the first name is the holder's too.
      if (t) {
        const names = t.names || [];
        ticket = {
          ticketId: t.ticketId, type: t.type,
          holderMatch: names.some((n) => fullNameMatches(n, q.firstName, q.lastName)),
          // The typed last name is the holder's (the ticket check passed on the account or purchase name).
          holderLastMatch: !names.length || names.some((n) => lastNameIs(n, q.lastName)),
        };
      }
    }
    const both = hasFirstAndLast(q);

    // The typed name, on its own: a speaker's ticket can carry another form of their first name
    // ("Christopher" for "Chris"). Over a verified ticket the typed last name must be the holder's.
    // A speaker is never verified by this (resolvePass), so a name gains nothing a ticket could prove.
    const speaker = both && (!ticket || ticket.holderLastMatch) ? matchSpeaker(await getSpeakers(), q.firstName, q.lastName) : "";
    // `verified` here means the server settles the pass (the page locks it). The speaker list
    // is public, so resolvePass still saves a speaker RSVP as unverified for staff to confirm.
    if (speaker) return { kind: "speaker", tier: "speaker", verified: true, displayName: speaker, ticket };
    if (ticket) return { kind: "ticket", tier: tierFromTicketType(ticket.type), verified: true, displayName: q.firstName, ticket };
    // Off on the live site: a pass is only ever shown from a verified ticket ID, never guessed from a name.
    if (both && guessFromName) {
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
 * @param {(key: string) => Promise<object|null>} deps.store.findByKey          the non-bot RSVP with this key
 * @param {(nameKey: string) => Promise<object[]>} deps.store.findByNameKey   listed (non-bot, not merged) RSVPs with this nameKey
 * @param {(hash: string) => Promise<object|null>} deps.store.findByEditToken  the listed RSVP with this edit token hash
 * @param {(doc: object) => Promise<object>} deps.store.insert
 * @param {(id: any, set: object) => Promise<object>} deps.store.update      also bumps `submissions`
 * @param {(id: any, set: object) => Promise<any>} deps.store.mark          sets fields only (flags a possible duplicate)
 * @param {object} [deps.ticketGuessLimiter]  per-ticket last-name budget, shared with /api/auth/ticket-login
 */
export function makeRsvpHandlers({
  lookup, store, log = console,
  requireTicket = true, // every RSVP needs a ticket ID that matches the last name (client decision, Oct 2026)
  lookupIpLimiter = makeLimiter({ max: 40, windowMs: 15 * 60 * 1000 }),
  lookupNameLimiter = makeLimiter({ max: 12, windowMs: 15 * 60 * 1000 }), // per address + name
  ticketGuessLimiter = ticketGuesses,
  submitIpLimiter = makeLimiter({ max: 12, windowMs: 15 * 60 * 1000 }),
  submitNameLimiter = makeLimiter({ max: 8, windowMs: 15 * 60 * 1000 }), // per address + name, RSVPs about to be saved
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
      const withTicket = canCheckTicket(q);
      // One name alone could be used to fish for who holds which pass.
      if (!both && !withTicket) return res.json({ ...NONE });
      // Per address: a limit on the name alone would let anyone lock that person out.
      if (both && !lookupNameLimiter.hit(`${ipOf(req)}|n:${personNameKey(q.firstName, q.lastName)}`)) return res.status(429).json({ ...NONE, error: TOO_MANY });
      if (withTicket && !ticketGuessLimiter.hit(ticketGuessKey(q.ticketId), q.lastName)) return res.status(429).json({ ...NONE, error: TOO_MANY });
      const r = await lookup(q);
      return res.json(publicLookup(r, q));
    } catch (err) {
      log.error?.("RSVP LOOKUP ERROR:", err?.message || err);
      // Not finding someone just means they pick their pass themselves.
      return res.json({ ...NONE });
    }
  }

  // Pass fields a verified RSVP keeps when it is changed without the ticket.
  const PASS_FIELDS = ["ticketId", "ticketVerified", "kind", "tier", "tierVerified", "detectedTier", "matchedSpeaker"];

  async function submitHandler(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const OK = { success: true, message: "RSVP saved" };
      if (isHoneypotFilled(body)) return res.status(201).json(OK);
      if (!submitIpLimiter.hit(ipOf(req))) return res.status(429).json({ success: false, message: TOO_MANY });

      const check = validateRsvp(body);
      if (!check.ok) return res.status(400).json({ success: false, message: check.error, field: check.field });
      const v = check.value;

      const userAgent = cleanText(req.headers?.["user-agent"]).slice(0, 300);
      const fillMs = Number.isFinite(Number(body.elapsedMs)) ? Math.max(0, Math.round(Number(body.elapsedMs))) : undefined;
      const typedNameKey = personNameKey(v.firstName, v.lastName);
      const base = {
        firstName: v.firstName, lastName: v.lastName, name: `${v.firstName} ${v.lastName}`,
        email: v.email, ticketId: v.ticketId,
        days: v.days, dietary: v.dietary, dietaryOther: v.dietaryOther, accessibility: v.accessibility,
        page: v.page, userAgent, fillMs,
      };

      // Bot (random-text names, filled in instantly): kept for review in its own row,
      // never merged into a real person's RSVP. Same answer, so it doesn't adapt.
      const bot = botReason(v, body);
      if (bot) {
        await store.insert({
          ...base, nameKey: typedNameKey, key: `spam:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind: "none",
          tier: v.tier || "", tierVerified: false, chosenTier: v.tier, options: [], spam: true, spamReason: bot,
        });
        return res.status(201).json(OK);
      }

      // Ticket ID + last name is the app's sign-in: the same per-ticket budget as /api/auth/ticket-login.
      if (canCheckTicket(v) && !ticketGuessLimiter.hit(ticketGuessKey(v.ticketId), v.lastName)) {
        return res.status(429).json({ success: false, message: TOO_MANY });
      }

      // Work the pass out again here: the browser's answer is never trusted.
      const found = await lookup({ firstName: v.firstName, lastName: v.lastName, ticketId: v.ticketId });
      // A ticket ID that matches the last name is required for every RSVP (speakers included).
      if (requireTicket && !v.ticketId) return res.status(400).json({ success: false, message: "Please enter your ticket ID.", field: "ticketId" });
      if (requireTicket && !found.ticket) return res.status(400).json({ success: false, message: "That ticket ID doesn't match your last name.", field: "ticketId" });
      const pass = resolvePass(found, v.tier);
      if (!pass.ok) return res.status(400).json({ success: false, message: pass.error, field: pass.field });
      const opts = checkOptions(pass.tier, v.days, v.options);
      if (!opts.ok) return res.status(400).json({ success: false, message: opts.error, field: "options", invalid: opts.invalid });
      // Only RSVPs about to be saved count, per address: nobody can use up a person's quota.
      if (!submitNameLimiter.hit(`${ipOf(req)}|${typedNameKey}`)) return res.status(429).json({ success: false, message: TOO_MANY });

      const ticketVerified = !!found.ticket;
      const keys = rsvpKeys({
        ticketId: found.ticket?.ticketId, ticketVerified, holderMatch: !!found.ticket?.holderMatch,
        firstName: v.firstName, lastName: v.lastName,
      });
      const doc = {
        ...base, nameKey: keys.name,
        ticketId: ticketVerified ? found.ticket.ticketId : v.ticketId, ticketVerified,
        kind: pass.kind, tier: pass.tier, tierVerified: pass.tierVerified,
        chosenTier: v.tier, detectedTier: pass.detectedTier || "",
        matchedSpeaker: found.kind === "speaker" ? cleanText(found.displayName).slice(0, 120) : "",
        options: opts.options, spam: false, spamReason: "",
      };
      const sentToken = typeof body.editToken === "string" ? body.editToken.trim() : "";
      const sentHash = hashEditToken(sentToken);

      // A verified ticket holder's RSVP replaces an earlier name-only one for their name in the
      // headcounts (most likely them, before they had their ticket ID); staff can undo it, and
      // a row staff kept as a separate person (separatedAt) is never flagged again.
      const supersedeNameRow = async (saved) => {
        if (!keys.ticket || !keys.name || !saved) return;
        for (const r of await store.findByNameKey(keys.name)) {
          if (r.key === `n:${keys.name}` && !r.duplicateOf && !r.separatedAt && String(r._id) !== String(saved._id)) {
            await store.mark(r._id, { duplicateOf: String(saved._id) });
          }
        }
      };

      const update = async (row, set, final) => {
        // A later RSVP without an email or ticket ID keeps the ones given before.
        if (!set.email && row.email) delete set.email;
        if (!set.ticketId && row.ticketId) { delete set.ticketId; delete set.ticketVerified; }
        // The owner (proven by the ticket or the token) typed a name that isn't the ticket holder's,
        // such as "Chris" on Christopher's ticket: the row keeps the name it is known by.
        if (!set.nameKey && row.nameKey) delete set.nameKey;
        const keepToken = !!sentHash && row.editTokenHash === sentHash;
        const token = keepToken ? sentToken : newEditToken();
        if (!keepToken) set.editTokenHash = hashEditToken(token);
        const saved = await store.update(row._id, set);
        await supersedeNameRow(saved);
        return { saved, updated: true, token, final };
      };

      const insert = async (fields) => {
        const token = newEditToken();
        const saved = await store.insert({ ...doc, ...fields, editTokenHash: hashEditToken(token), submissions: 1 });
        await supersedeNameRow(saved);
        return { saved, updated: false, token, final: pass };
      };

      const write = async () => {
        // 1. The RSVP saved under this verified ticket: the ticket is the proof.
        const byTicket = keys.ticket ? await store.findByKey(keys.ticket) : null;
        if (byTicket) return update(byTicket, { ...doc }, pass);

        // 2. An RSVP this browser saved before (its edit token), for the name it was saved under or
        //    is known by: a token never moves an RSVP to somebody else's name (a shared computer).
        //    A token for an RSVP under another verified ticket doesn't change that one either.
        const sameName = keys.name ? await store.findByNameKey(keys.name) : [];
        const tokenRow = sentHash ? await store.findByEditToken(sentHash) : null;
        const own = tokenRow && tokenRow.editTokenHash === sentHash
          && (tokenRow.nameKey === typedNameKey || personNameKey(tokenRow.firstName, tokenRow.lastName) === typedNameKey)
          && (!keys.ticket || !String(tokenRow.key).startsWith("t:"))
          ? tokenRow : null;
        if (own) {
          const set = { ...doc };
          if (!keys.ticket && (own.ticketVerified || own.tierVerified)) {
            // Saved with a verified ticket, changed without it: the pass stays as it was.
            for (const k of PASS_FIELDS) delete set[k];
            const again = checkOptions(own.tier, v.days, v.options);
            if (!again.ok) return { invalid: again };
            set.options = again.options;
            return update(own, set, { kind: own.kind, tier: own.tier, tierVerified: !!own.tierVerified });
          }
          if (keys.ticket) { set.key = keys.ticket; set.duplicateOf = ""; } // now proven by its ticket too
          return update(own, set, pass);
        }

        // 3. No proof: a row of its own, and never a change to anyone else's.
        if (keys.ticket) return insert({ key: keys.ticket });
        const nKey = `n:${keys.name}`;
        const primary = sameName.find((r) => !r.duplicateOf && String(r.key).startsWith("t:"))
          || sameName.find((r) => !r.duplicateOf)
          || sameName.find((r) => r.key === nKey);
        if (primary) {
          return insert({
            key: `dup:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`,
            duplicateOf: String(primary.duplicateOf || primary._id),
          });
        }
        return insert({ key: nKey });
      };
      let result;
      try {
        result = await write();
      } catch (err) {
        if (!isDuplicateKey(err)) throw err;
        result = await write(); // two submissions at once: the other one won, go again
      }
      if (result.invalid) {
        return res.status(400).json({ success: false, message: result.invalid.error, field: "options", invalid: result.invalid.invalid });
      }

      // No row id, and `updated` only for the person who proved the RSVP is theirs.
      const { final } = result;
      return res.status(201).json({
        ...OK, updated: result.updated, editToken: result.token,
        kind: final.kind, tier: final.tier, tierLabel: TIER_LABELS[final.tier], tierVerified: !!final.tierVerified,
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

/**
 * Staff resolve a possible duplicate (POST /api/console/rsvps/:id/resolve, routes/console.js).
 *   "merge"    the same person: planRsvpMerge picks the row that stays listed (the ticket-verified one,
 *              else the RSVP it duplicates) and gives it the NEWER answers and the verified pass; the
 *              other row is kept for the record (mergedInto, its key freed) and no longer listed.
 *   "separate" a different person with the same name: counted on its own, and it stays that way
 *              (separatedAt / separatedBy: a later save by the namesake's ticket never flags it again).
 * @param {object} store
 * @param {(id: string) => Promise<object|null>} store.findLive         listed (non-bot, not merged) row by id, with editTokenHash
 * @param {(id: any, set: object, inc?: object) => Promise<object>} store.update   returns the updated row
 * @param {(fromId: string, toId: string) => Promise<any>} store.repoint  rows flagged as duplicates of fromId now point at toId
 * @returns {Promise<{ status: number, error: string } | { row: object, dropped: string[], audit: { action: string, targetId: string, detail: string } }>}
 */
export async function resolveRsvpDuplicate(store, id, action, staff = {}, now = () => new Date()) {
  if (!["merge", "separate"].includes(action)) return { status: 400, error: "action must be merge or separate" };
  const dup = await store.findLive(id);
  if (!dup) return { status: 404, error: "RSVP not found" };
  if (!dup.duplicateOf) return { status: 409, error: "This RSVP isn't marked as a possible duplicate" };
  const nameOf = (r) => r.name || [r.firstName, r.lastName].filter(Boolean).join(" ") || "no name";

  if (action === "separate") {
    const row = await store.update(dup._id, {
      duplicateOf: "", separatedFrom: String(dup.duplicateOf), separatedAt: now(), separatedBy: cleanText(staff.name).slice(0, 120),
    });
    return { row, dropped: [], audit: { action: "rsvp_separate", targetId: String(dup._id), detail: `${nameOf(dup)}: kept as a separate person` } };
  }

  const keep = await store.findLive(dup.duplicateOf);
  if (!keep) return { status: 409, error: "The RSVP this duplicates is gone. Keep this one as separate instead." };
  const plan = planRsvpMerge(keep, dup);
  const { survivor, retired } = plan;
  // The survivor first: if retiring the other row fails, both are still listed and nothing is lost.
  const row = await store.update(survivor._id, plan.set, plan.inc);
  await store.update(retired._id, { mergedInto: String(survivor._id), key: `merged:${retired._id}` });
  await store.repoint(String(retired._id), String(survivor._id));
  const dropped = plan.dropped.map(optionLabel);
  return {
    row, dropped: plan.dropped,
    audit: {
      action: "rsvp_merge", targetId: String(survivor._id),
      detail: `${nameOf(retired)} → ${nameOf(survivor)}; newer answers kept (from ${plan.newer === dup ? "the possible duplicate" : "the RSVP it duplicated"})`
        + `${dropped.length ? `; not in their pass: ${dropped.join(", ")}` : ""}`,
    },
  };
}
