import express from "express";
import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { requireCheckIn } from "../middleware/adminAuth.js";
import { checkinCard, plainCard, holderIsAccount } from "../services/checkinCard.js";
import { recordScan } from "../services/checkinDeskActions.js";
import { cleanTicketId } from "../services/doorQr.js";
import { deskNow } from "../services/checkinDeskLog.js";
import { eventDayInfo } from "../services/checkinDeskTime.js";

/* What the scanner shows about the pass and its holder (services/checkinCard.js): `ticketType` (connect | influence |
   power | apex | speaker; the text "All Access" is Power), `passName` its name ("Speaker Pass" for the internal one),
   `speaker` true for a Speaker Pass, and since Oct 22 2026 the door card: `badge` { key, label, bg, text } (VIP gold >
   Media > Speaker > Staff > Volunteer > the pass, green), `avatarUrl` (uploaded photo, else speaker photo, else ""),
   `name`, `title`, `company`, `extras` { cxo, lunch, gala, awards } and `cxoBreakfast`. Sent with "success",
   "already_checked_in" and "practice"; never with "invalid", and nothing without the checkIn right (requireCheckIn). */

/* A practice scan (Oct 24 2026, approved by the organiser): on a day that isn't Day 1 or Day 2 (Toronto, the desk's
   clock: deskNow(), which tests and a local rehearsal can set), a scan finds the pass and shows its card exactly as on
   the day, but writes NOTHING to the ticket (no checkedIn / checkedInAt on User.tickets or the Attendee row). Staff
   and volunteers scan people's entry passes in the apps' Network › Scan days before the event (to connect with them),
   and that used to collect the pass for real. Answer: 200 { ...card, status: "practice", practice: true, ticketId (as
   stored), alreadyCheckedIn, time (when it was collected before), message }. The check-in desk app still gets its
   practice marks (recordScan, contract C6), so a Sunday dry run shows on the desk board without touching real data.
   An unknown ticket is still 404 "invalid", on any day. */
const PRACTICE_MESSAGE = "Not an event day: nothing was checked in.";
const practiceAnswer = ({ card, ticketId, rec }) => ({
  ...card,
  status: "practice",
  practice: true,
  ticketId,
  alreadyCheckedIn: !!rec.checkedIn,
  ...(rec.checkedIn ? { time: rec.checkedInAt || null } : {}),
  message: PRACTICE_MESSAGE,
});

// What the card reads from an account (types, VIP flag, passes, photo, job). The email only to find their speaker photo.
const HOLDER_SELECT = "name email role types typesOff vip tickets jobTitle organization avatarVersion";
const PLACEHOLDER_EMAIL = /@ticket\.thetechfestival\.com$/i;

/** The account behind a guest / issued / speaker / exhibitor pass: the one that claimed it, else the one with its
    email whose name agrees (a buyer's email on a colleague's pass isn't the colleague's account). null: none. */
async function accountForPass(attendee) {
  if (attendee.claimedBy) {
    const claimer = await User.findById(attendee.claimedBy).select(HOLDER_SELECT).lean();
    if (claimer) return claimer;
  }
  const email = String(attendee.email || "").trim().toLowerCase();
  if (!email || PLACEHOLDER_EMAIL.test(email)) return null;
  const owner = await User.findOne({ email }).select(HOLDER_SELECT).lean();
  return owner && holderIsAccount({ account: owner, attendee }) ? owner : null;
}

/** The account's Attendee rows (claimed by them or with one of their ticket IDs): their VIP / Media / exhibitor marks. */
function passRowsOf(account) {
  const ids = (account.tickets || []).map((t) => t?.ticketId).filter(Boolean);
  return Attendee.find({ $or: [{ claimedBy: account._id }, ...(ids.length ? [{ ticketId: { $in: ids } }] : [])] })
    .select("ticketId ticketType promoCode claimedBy vip media exhibitor").lean();
}

/** The door card for a scanned ticket. Never fails the check-in: on an error, the name and the pass in green. */
async function cardFor({ ticketId, account = null, ticket = null, attendee = null, fallbackName = "" }) {
  try {
    if (!account && attendee) account = await accountForPass(attendee);
    const rows = account ? await passRowsOf(account) : [];
    return checkinCard({ ticketId, account, ticket, attendee, rows });
  } catch (err) {
    console.error("CHECK-IN CARD ERROR:", err?.message || err);
    return plainCard({ ticketId, name: fallbackName, tier: ticket ? ticket.type : attendee?.ticketType, rec: ticket || attendee });
  }
}

const router = express.Router();

// ================= CHECK-IN =================
// People with the checkIn right only (requireCheckIn: volunteers and staff by
// default, staff accounts always): the website's admin check-in page sends a
// staff JWT, the apps' scanner a staff or volunteer one. Previously this
// endpoint was open, so anyone who knew a ticketId could mark it used.
router.post("/scan", requireCheckIn, async (req, res) => {
  try {
    // Every form of the same ticket finds it (services/doorQr.js): "TECHFEST:<ticketId>" (pass emails, Wallet, the apps,
    // and since Oct 24 2026 the PDF ticket and the purchase email too) or the bare ID (PDF tickets and purchase emails
    // from before), any case, with stray spaces. Writes below use the ID as stored.
    const raw = String(req.body?.ticketId || "").trim().replace(/^TECHFEST:/i, "");
    const typed = cleanTicketId(raw);
    let ticketId = typed;

    if (!ticketId) {
      return res.status(400).json({
        error: "Ticket ID required",
      });
    }
    const variants = [...new Set([typed, typed.toUpperCase(), raw])].filter(Boolean);
    // Judged once, at one instant: the answer and the desk's marks (recordScan) agree on the day.
    const now = deskNow();
    const practice = !eventDayInfo(now).eventDay;

    // First check in User collection
    const user = await User.findOne({
      "tickets.ticketId": { $in: variants },
    });

    if (user) {
      const ticket = user.tickets.find(
        (t) => cleanTicketId(t.ticketId) === typed
      );
      ticketId = ticket.ticketId;
      // The guest record of a claimed ticket (its marks and staff's switches), when there is one.
      const attendee = await Attendee.findOne({ ticketId }).lean();
      const holder = typeof user.toObject === "function" ? user.toObject() : user;
      const card = await cardFor({
        ticketId, account: holder, ticket: holder.tickets.find((t) => t.ticketId === ticketId), attendee, fallbackName: user.name,
      });

      // Not an event day: the card, nothing written (see practiceAnswer above).
      if (practice) {
        res.json(practiceAnswer({ card, ticketId, rec: ticket }));
        void recordScan({ ticketId, user: req.user, outcome: "practice", at: now });
        return;
      }

      // already used (the desk app still records today's check-in once: Day 2, services/checkinDeskActions.js)
      if (ticket.checkedIn) {
        res.json({
          ...card,
          status: "already_checked_in",
          ticketId,
          time: ticket.checkedInAt,
        });
        // After the answer: the scanner never waits for the desk app's records (recordScan never throws).
        void recordScan({ ticketId, user: req.user, outcome: "already", at: now });
        return;
      }

      // mark as checked in
      ticket.checkedIn = true;
      ticket.checkedInAt = new Date();
      await user.save();
      // Keep the admin attendee list in step when a guest ticket was linked to this account.
      await Attendee.updateOne({ ticketId }, { $set: { checkedIn: true, checkedInAt: ticket.checkedInAt } });
      res.json({
        ...card,
        status: "success",
        ticketId,
        checkedInAt: ticket.checkedInAt,
      });
      // Then the check-in desk app's pass desk shows them checked in (never fails or slows the scan).
      void recordScan({ ticketId, user: req.user, outcome: "success", collectedAt: ticket.checkedInAt, at: now });

      return;
    }

    // Check in Attendee collection (guests)
    const attendee = await Attendee.findOne({ ticketId: { $in: variants } });

    if (!attendee) {
      return res.status(404).json({
        status: "invalid",
        message: "Ticket not found",
        error: "Ticket not found",
      });
    }
    ticketId = attendee.ticketId;

    const card = await cardFor({ ticketId, attendee: attendee.toObject(), fallbackName: attendee.name });

    if (practice) {
      res.json(practiceAnswer({ card, ticketId, rec: attendee }));
      void recordScan({ ticketId, user: req.user, outcome: "practice", at: now });
      return;
    }

    if (attendee.checkedIn) {
      res.json({
        ...card,
        status: "already_checked_in",
        ticketId,
        time: attendee.checkedInAt,
      });
      void recordScan({ ticketId, user: req.user, outcome: "already", at: now });
      return;
    }

    attendee.checkedIn = true;
    attendee.checkedInAt = new Date();
    await attendee.save();

    res.json({
      ...card,
      status: "success",
      ticketId,
      checkedInAt: attendee.checkedInAt,
    });
    void recordScan({ ticketId, user: req.user, outcome: "success", collectedAt: attendee.checkedInAt, at: now });
  } catch (err) {
    console.error("CHECK-IN ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
