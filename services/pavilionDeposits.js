/* =========================================================
   India Pavilion $500 deposits → applications
   ---------------------------------------------------------
   A deposit is paid through Stripe Checkout (routes/payments.js,
   metadata.type "pavilion-deposit"). It is recorded here from:
     • the Stripe webhook (routes/webhook.js), as it happens, and
     • the same Stripe read the revenue page uses (services/stripeSales.js),
       which also brings in deposits paid before this existed.
   Each deposit is saved once (by Checkout Session id) in PavilionDeposit
   and linked to the matching application (reference, email, then
   company name: services/pavilionApplications.js matchDeposit). Ones that
   match nothing stay unlinked and are listed on their own; they are
   retried whenever a new application comes in.
========================================================= */

import PavilionApplication from "../models/PavilionApplication.js";
import PavilionDeposit from "../models/PavilionDeposit.js";
import { matchDeposit, depositFieldsFor, depositFromStripeRow, applicationFromDeposit, makeReference } from "./pavilionApplications.js";
import { stripeRows } from "./stripeSales.js";

/** Save a deposit once per Checkout Session (refund amount kept current). */
export async function recordDeposit(dep, source) {
  if (!dep?.stripeSessionId) return;
  const { refunded, ...rest } = dep;
  await PavilionDeposit.updateOne(
    { stripeSessionId: dep.stripeSessionId },
    { $setOnInsert: { ...rest, source }, ...(refunded !== undefined ? { $set: { refunded } } : {}) },
    { upsert: true },
  );
  if (refunded !== undefined) {
    await PavilionApplication.updateMany({ depositStripeId: dep.stripeSessionId }, { $set: { depositRefunded: refunded } });
  }
}

/** Link every unlinked deposit that now matches an application. Returns how many were linked. */
export async function linkDeposits() {
  const open = await PavilionDeposit.find({ applicationId: null }).sort({ paidAt: 1 }).lean();
  if (!open.length) return 0;
  const apps = await PavilionApplication.find({}, {
    reference: 1, repEmail: 1, legalName: 1, tradingName: 1, spam: 1, spamReason: 1, depositStripeId: 1, createdAt: 1,
  }).lean();
  let linked = 0;
  for (const dep of open) {
    const m = matchDeposit(dep, apps);
    if (!m) {
      // Paid, but the application was only ever emailed: give it its own row, marked paid.
      const doc = applicationFromDeposit(dep, makeReference());
      if (!doc) continue;
      const app = await PavilionApplication.create(doc);
      // List it on the day they paid, not today (timestamps would stamp now).
      if (doc.createdAt) await PavilionApplication.updateOne({ _id: app._id }, { $set: { createdAt: doc.createdAt } }, { timestamps: false });
      await PavilionDeposit.updateOne({ _id: dep._id }, { $set: { applicationId: app._id, matchedBy: "deposit" } });
      apps.push(app.toObject());
      linked += 1;
      continue;
    }
    await PavilionDeposit.updateOne({ _id: dep._id }, { $set: { applicationId: m.app._id, matchedBy: m.by } });
    // One application, one deposit shown; a second payment stays listed under the application's deposits.
    if (!m.app.depositStripeId) {
      const set = depositFieldsFor(dep, m.by);
      // Someone who paid is not a bot.
      if (m.app.spam) Object.assign(set, { spam: false, spamReason: `was flagged (${m.app.spamReason || "bot"}), then paid the deposit` });
      await PavilionApplication.updateOne({ _id: m.app._id }, { $set: set });
      m.app.depositStripeId = dep.stripeSessionId;
      m.app.spam = false;
    }
    linked += 1;
  }
  return linked;
}

/* Pull pavilion deposits out of the revenue page's Stripe read (cached 5 min
   there). Only writes when that read is new, so the admin list stays fast. */
let lastSynced = null;
export async function syncDepositsFromStripe(stripe, { force = false } = {}) {
  const rows = await stripeRows(stripe, { force });
  if (rows === lastSynced) return 0;
  const deps = rows.map(depositFromStripeRow).filter(Boolean);
  for (const d of deps) await recordDeposit(d, "stripe");
  lastSynced = rows;
  return deps.length;
}
