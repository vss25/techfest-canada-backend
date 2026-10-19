import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import { lastNameMatches } from "../services/ticketAccess.js";
import { findTicket, ticketNameMatches } from "./ticketAuth.js";
import { buildHolderIndex, makeSpeakerCache, ticketPersonNames, LIVE_RSVPS, buildRsvpEmail,
  RSVP_AGENDA_URL, parseRsvpAgenda, agendaTimes } from "../services/rsvp.js";
import { makeAgendaCache } from "../services/points.js";
import { sendFormSubmissionEmail } from "../services/emailService.js";
import { makeLookup, makeRsvpHandlers, cached } from "../services/rsvpHandler.js";
import { cxoOverride } from "../services/cxoBreakfast.js";
import { extrasOverride, EXTRA_SELECT } from "../services/passExtras.js";
import { effectiveTypes, passKind } from "../services/teamRoles.js";

/* =========================================================
   TTFC 2026 RSVPs — mounted at /api/rsvp
   GET  /api/rsvp/options   passes, days, experiences per pass, dietary list
   POST /api/rsvp/lookup    { firstName, lastName, ticketId?, _hp }
                            → { kind: ticket|speaker|none, tier?, verified, displayName?, ticketMatched?,
                                cxoBreakfast?, keepOptions? (verified tickets only), allowedOptions? }
                            `allowedOptions`: what this person may pick (their pass, and with a verified ticket the
                            pass extras staff switched on or off for it, plus any extra already on their RSVP)
   POST /api/rsvp           { firstName, lastName, email?, ticketId?, tier, days, options,
                              dietary, dietaryOther, accessibility?, page?, editToken?, _hp, elapsedMs }
                            → { success, updated, editToken, kind, tier, tierLabel, tierVerified }
                            Keep `editToken` and send it back to change the RSVP later.
   ---------------------------------------------------------
   The website page (/rsvp) has no links to it. No email is sent.
   Staff: Admin → Leads → RSVPs (routes/console.js /rsvps).
   Logic: services/rsvpHandler.js, services/rsvp.js.
========================================================= */

const router = express.Router();

/** Ticket ID + last name, checked exactly as the app's ticket sign-in does (routes/ticketAuth.js).
    `names`: who the ticket is for, so the lookup can check the first name too (never sent out).
    `types` (the holder's person types) and `extras` (staff's pass extras on this ticket: CxO Breakfasts,
    luncheons, Gala Dinner, Awards Night) decide which of those are offered (services/passExtras.js);
    `cxoOverride` is the CxO Breakfasts' switch alone (kept for older callers). */
async function verifyTicket(ticketId, lastName) {
  const found = await findTicket(ticketId);
  if (!found) return null;
  if (found.kind === "user") {
    if (!(await ticketNameMatches(found, lastName))) return null;
    const original = await Attendee.findOne({ ticketId: found.ticketId }).select(`name details.firstName details.lastName ${EXTRA_SELECT}`).lean();
    const names = [...ticketPersonNames(found.owner.name, found.ticket.details), ...(original ? ticketPersonNames(original.name, original.details) : [])];
    return {
      ticketId: found.ticketId, type: found.ticket.type, names,
      types: effectiveTypes(found.owner), cxoOverride: cxoOverride(found.ticket, original), extras: extrasOverride(found.ticket, original),
    };
  }
  const a = found.attendee;
  const ok = lastNameMatches(a.name, lastName) || (a.details?.lastName && lastNameMatches(a.details.lastName, lastName));
  return ok ? {
    ticketId: a.ticketId, type: a.ticketType, names: ticketPersonNames(a.name, a.details),
    types: passKind(a) === "speaker" ? ["speaker"] : [], cxoOverride: cxoOverride(a), extras: extrasOverride(a),
  } : null;
}

// Names only (and passes), reloaded at most every 2 minutes.
const getHolders = cached(async () => {
  const [users, guests] = await Promise.all([
    User.find({ "tickets.0": { $exists: true } },
      { name: 1, "tickets.ticketId": 1, "tickets.type": 1, "tickets.hiddenByStaff": 1, "tickets.details.firstName": 1, "tickets.details.lastName": 1 }).lean(),
    Attendee.find({},
      { name: 1, email: 1, ticketId: 1, ticketType: 1, hiddenByStaff: 1, syncDuplicate: 1, "details.firstName": 1, "details.lastName": 1 }).lean(),
  ]);
  return buildHolderIndex(users, guests);
}, 2 * 60 * 1000);

const speakers = makeSpeakerCache();

const lookup = makeLookup({ verifyTicket, getHolders, getSpeakers: () => speakers.get() });

// Each saved RSVP is emailed to the team (RSVP_INBOX, default enquire@thetechfestival.com).
const RSVP_INBOX = (process.env.RSVP_INBOX || "enquire@thetechfestival.com").split(",").map((x) => x.trim()).filter(Boolean);
const notify = (row, opts) => sendFormSubmissionEmail({ to: RSVP_INBOX, ...buildRsvpEmail(row, opts) });

// Special-event times on the RSVP page come from the agenda (cached a minute; the last good copy if Sanity is down).
const rsvpAgenda = makeAgendaCache({ url: RSVP_AGENDA_URL, parse: parseRsvpAgenda, label: "RSVP AGENDA", ttlMs: 60 * 1000 });

const handlers = makeRsvpHandlers({
  lookup,
  notify,
  agendaTimes: async () => { const s = await rsvpAgenda.get(); return s ? agendaTimes(s) : null; },
  store: {
    // The edit token's hash is never read anywhere else (select: false in the model).
    findByKey: (key) => Rsvp.findOne({ key, spam: false }).select("+editTokenHash").lean(),
    findByNameKey: (nameKey) => (nameKey
      ? Rsvp.find({ nameKey, ...LIVE_RSVPS }).select("+editTokenHash").sort({ createdAt: 1 }).limit(50).lean()
      : Promise.resolve([])),
    findByEditToken: (hash) => (hash
      ? Rsvp.findOne({ editTokenHash: hash, ...LIVE_RSVPS }).select("+editTokenHash").lean()
      : Promise.resolve(null)),
    insert: (doc) => Rsvp.create(doc),
    update: (id, set) => Rsvp.findByIdAndUpdate(id, { $set: set, $inc: { submissions: 1 } }, { new: true }).lean(),
    mark: (id, set) => Rsvp.updateOne({ _id: id }, { $set: set }),
  },
});

router.get("/options", handlers.options);
router.post("/lookup", handlers.lookup);
router.post("/", handlers.submit);

export default router;
