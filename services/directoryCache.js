import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { GUEST_DETAILS_SELECT } from "./ticketAccess.js";

/* =========================================================
   The attendee directory's two reads, shared (Oct 22 2026)
   ---------------------------------------------------------
   GET /api/social/attendees read every ticket holder and every
   unclaimed pass on each call, and the apps call it on each Home
   visit: with 50–70 people on the app at once it was the heaviest
   read. Now the rows are kept DIRECTORY_TTL_MS per server, and
   requests that arrive while a read is running wait for it
   instead of starting their own. Everything about the viewer
   (blocks, hidden people, rights, search) is still worked out on
   each request; a profile change shows in others' lists within
   the TTL. Callers must not change the rows.
   Under `node --test` the TTL is 0 (requests in flight together
   still share one read) unless TTFC_DIRECTORY_CACHE_MS says
   otherwise.
========================================================= */

export const DIRECTORY_TTL_MS = 15_000;

const USER_SELECT = "name email role jobTitle organization linkedinUrl country topics tickets directoryHidden avatarVersion lastActiveAt appOnboarded tagline availabilitySlots meetingSpot availabilitySpots messagesOff requestsOff types typesOff vip";

function ttlFromEnv() {
  const v = Number(process.env.TTFC_DIRECTORY_CACHE_MS);
  if (process.env.TTFC_DIRECTORY_CACHE_MS !== undefined && Number.isFinite(v) && v >= 0) return v;
  return process.env.NODE_TEST_CONTEXT ? 0 : DIRECTORY_TTL_MS;
}

/**
 * A memo around `load` (async → value): fresh for `ttlMs`, one load at a time, the last good value kept if a load
 * fails. → { get(), forget() }.
 */
export function makeDirectoryCache({ load, ttlMs = DIRECTORY_TTL_MS, now = Date.now, log = console } = {}) {
  let memo = { at: 0, value: null, pending: null, gen: 0 };
  return {
    get() {
      if (memo.value && ttlMs > 0 && now() - memo.at < ttlMs) return Promise.resolve(memo.value);
      if (memo.pending) return memo.pending;
      const gen = memo.gen;
      const pending = Promise.resolve().then(load).then((value) => {
        if (memo.gen === gen) memo = { at: now(), value, pending: null, gen };
        return value;
      }).catch((err) => {
        if (memo.pending === pending) memo.pending = null;
        if (memo.value) { log.error?.("DIRECTORY ERROR (kept the last rows):", err?.message || err); return memo.value; }
        throw err;
      });
      memo.pending = pending;
      return pending;
    },
    forget() {
      memo = { at: 0, value: null, pending: null, gen: memo.gen + 1 };
    },
  };
}

const rows = makeDirectoryCache({
  ttlMs: ttlFromEnv(),
  load: async () => {
    const [users, guests] = await Promise.all([
      User.find({ $or: [{ "tickets.0": { $exists: true } }, { appOnboarded: true }, { lastActiveAt: { $exists: true } }] })
        .select(USER_SELECT).lean(),
      Attendee.find({ claimedBy: { $exists: false }, directoryHidden: { $ne: true } })
        .select(`name email ticketId ticketType purchaseDate promoCode exhibitor vip issuedPass.booth ${GUEST_DETAILS_SELECT}`).lean(),
    ]);
    return { users, guests };
  },
});

/** { users, guests }: the directory's rows (shared; don't change them). */
export const directoryRows = () => rows.get();

/** The next read loads again (this server). */
export const forgetDirectory = () => rows.forget();
