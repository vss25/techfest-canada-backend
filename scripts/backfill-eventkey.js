// scripts/backfill-eventkey.js
/* One-time backfill for the event spine (Phase 1):
     node scripts/backfill-eventkey.js

   - Sets eventKey "ttfc-2026-main" on every Attendee and Rsvp row that
     predates the field, and on every pass held inside a User account
     (User.tickets — there is no separate Ticket collection; models/Ticket.js
     is an empty placeholder and passes live in Attendee + User.tickets).
   - Creates the 2026 EventConfig if it isn't there yet ($setOnInsert:
     re-running never overwrites what staff have set since).

   Idempotent: every write only touches rows still missing the field, so it
   is safe to run again. NOT run by the server, and not run yet — it ships
   with the Phase 1 PR and runs once, by hand, when management says so. */
import dotenv from "dotenv";
dotenv.config();
import mongoose from "mongoose";
import Attendee from "../models/Attendee.js";
import Rsvp from "../models/Rsvp.js";
import User from "../models/User.js";
import EventConfig from "../models/EventConfig.js";

const EVENT_KEY = "ttfc-2026-main";

async function main() {
  await mongoose.connect(process.env.MONGO_URI, { readPreference: "primary" });
  console.log("✅ MongoDB connected");

  const attendees = await Attendee.updateMany(
    { eventKey: { $exists: false } },
    { $set: { eventKey: EVENT_KEY } }
  );
  console.log(`Attendees: ${attendees.modifiedCount} updated (${attendees.matchedCount} matched)`);

  const rsvps = await Rsvp.updateMany(
    { eventKey: { $exists: false } },
    { $set: { eventKey: EVENT_KEY } }
  );
  console.log(`RSVPs: ${rsvps.modifiedCount} updated (${rsvps.matchedCount} matched)`);

  const users = await User.updateMany(
    { tickets: { $elemMatch: { eventKey: { $exists: false } } } },
    { $set: { "tickets.$[ticket].eventKey": EVENT_KEY } },
    { arrayFilters: [{ "ticket.eventKey": { $exists: false } }] }
  );
  console.log(`User accounts: ${users.modifiedCount} updated (${users.matchedCount} matched)`);

  // The 2026 event itself. Its visibility is the decided exception: 2026
  // attendees already see each other in the app, so the record starts at
  // profiles + own-event. Every 2027 event starts hidden + staff-only
  // (the EventConfig defaults) until Admin opens it.
  const config = await EventConfig.updateOne(
    { eventKey: EVENT_KEY },
    {
      $setOnInsert: {
        eventKey: EVENT_KEY,
        name: "The Tech Festival Canada 2026",
        city: "Toronto",
        type: "main-event",
        year: 2026,
        startDate: new Date("2026-10-26"),
        endDate: new Date("2026-10-27"),
        status: "past",
        attendeeVisibility: { mode: "profiles", audience: "own-event", sharedWith: [] }
      }
    },
    { upsert: true }
  );
  console.log(
    `EventConfig ${EVENT_KEY}: ${config.upsertedCount ? "created" : "already existed — left as staff have it"}`
  );

  await mongoose.disconnect();
  console.log("Done.");
}

main().catch(async (err) => {
  console.error("❌ Backfill failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
