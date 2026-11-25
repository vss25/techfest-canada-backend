// scripts/backfill-eventkey.js
/* One-time backfill for the event spine (Phase 1):
     node scripts/backfill-eventkey.js

   - Sets eventKey "ttfc-2026-main" on every Attendee and Rsvp row that
     predates the field, and on every pass held inside a User account
     (User.tickets — there is no separate Ticket collection; models/Ticket.js
     is an empty placeholder and passes live in Attendee + User.tickets).
   - Creates the 2026 EventConfig if it isn't there yet ($setOnInsert:
     re-running never overwrites what staff have set since).

   - Nov 23 2026: also the admin pages' own records, which had no event
     until then: SOS requests, app activity (AppEvent), promo codes,
     Catalyst Awards nominations, jurors and rubric versions. The admin
     reads already count rows without eventKey as the 2026 main event
     (eventClause), so this only makes the data say so explicitly.

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
import SosRequest from "../models/SosRequest.js";
import Promo from "../models/Promo.js";
import Nomination from "../models/Nomination.js";
import Juror from "../models/Juror.js";
import JuryRubric from "../models/JuryRubric.js";
import { AppEvent } from "../models/Admin.js";

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

  // Nov 23 2026: the admin pages' records (SOS & help, Live activity, Promo codes, Catalyst Awards).
  for (const [label, Model] of [["SOS requests", SosRequest], ["App activity", AppEvent], ["Promo codes", Promo],
                                ["Nominations", Nomination], ["Jurors", Juror], ["Jury rubric versions", JuryRubric]]) {
    const r = await Model.updateMany({ eventKey: { $exists: false } }, { $set: { eventKey: EVENT_KEY } });
    console.log(`${label}: ${r.modifiedCount} updated (${r.matchedCount} matched)`);
  }

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
        // 2026 pricing was public (it is historical now), so its flag is on;
        // every later event starts with pricingAnnounced off ("to be announced").
        settings: { lifecycleGraceDays: 7, pricingAnnounced: true },
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
