/* Stripe → tickets, one Checkout Session = one ticket.

   The old "Sync from Stripe" stored the session id in a field the Attendee
   model didn't have, so it never recognised a session it had already
   imported: every click re-created every ticket, and it also ignored the
   ticket the webhook had already issued at purchase time.

   planSync() works out, for every paid ticket session, which existing
   ticket belongs to it (linking the session id so it's never imported
   again), which records are leftover copies (hidden from staff lists and
   analytics, flagged syncDuplicate), and which sessions truly have no
   ticket yet (created). Pure, unit-tested. */

const BEFORE = 5 * 60e3;      // webhook can't be earlier than ~the session
const AFTER = 60 * 60e3;      // …and normally lands within seconds

const lc = (s) => String(s || "").trim().toLowerCase();

/** A paid Checkout Session that should produce a delegate pass. */
export function isTicketSession(s) {
  const type = String(s?.metadata?.type || "");
  const tier = String(s?.metadata?.tier || "");
  if (s?.payment_status && s.payment_status !== "paid") return false;
  if (!tier || tier.startsWith("booth-")) return false;
  if (["booth", "upgrade", "pavilion-deposit"].includes(type)) return false;
  return !!lc(s?.customer_details?.email || s?.customer_email);
}

/**
 * @param sessions  Stripe Checkout Sessions (complete)
 * @param attendees Attendee docs (lean)
 * @param users     User docs with tickets (lean)
 * @returns { create: session[], link: {kind, id, userId?, ticketId?, sessionId}[], hide: attendeeId[] }
 */
export function planSync(sessions, attendees, users) {
  const records = [];
  for (const a of attendees) {
    records.push({ kind: "attendee", id: String(a._id), email: lc(a.email), tier: lc(a.ticketType),
      at: new Date(a.purchaseDate || 0).getTime(), sessionId: a.stripeSessionId || "",
      keep: !!(a.claimedBy || a.checkedIn), order: String(a._id) });
  }
  for (const u of users) {
    for (const t of u.tickets || []) {
      records.push({ kind: "user", userId: String(u._id), ticketId: t.ticketId, email: lc(u.email), tier: lc(t.type),
        at: new Date(t.purchaseDate || 0).getTime(), sessionId: t.stripeSessionId || "", keep: true, order: "" });
    }
  }
  const used = new Set();
  const key = (r) => (r.kind === "user" ? `u:${r.userId}:${r.ticketId}` : `a:${r.id}`);
  const best = (list) => [...list].sort((x, y) =>
    (y.kind === "user") - (x.kind === "user") || y.keep - x.keep || (x.order < y.order ? -1 : x.order > y.order ? 1 : 0))[0];

  const plan = { create: [], link: [], hide: [] };
  const hide = (r) => { if (r.kind === "attendee" && !plan.hide.includes(r.id)) plan.hide.push(r.id); used.add(key(r)); };
  const link = (r, sessionId) => {
    used.add(key(r));
    if (r.sessionId !== sessionId) plan.link.push({ kind: r.kind, id: r.id, userId: r.userId, ticketId: r.ticketId, sessionId });
  };

  const ticketSessions = sessions.filter(isTicketSession).sort((a, b) => a.created - b.created);
  for (const s of ticketSessions) {
    const email = lc(s.customer_details?.email || s.customer_email);
    const tier = lc(s.metadata.tier);
    const created = s.created * 1000;
    const byUser = s.metadata?.userId ? String(s.metadata.userId) : "";
    const sameBuyer = (r) => r.tier === tier && (r.email === email || (byUser && r.userId === byUser));

    // Exact copies the old sync made: purchaseDate is exactly the session time.
    const copies = records.filter((r) => !used.has(key(r)) && !r.sessionId && r.kind === "attendee" && sameBuyer(r) && r.at === created);
    const tagged = records.filter((r) => r.sessionId === s.id);

    if (tagged.length) {
      const keepR = best(tagged);
      used.add(key(keepR));
      tagged.filter((r) => r !== keepR).forEach(hide);
      copies.forEach(hide);
      continue;
    }
    // A ticket issued at purchase time (webhook), not yet tagged with this session.
    const issued = records.filter((r) => !used.has(key(r)) && !r.sessionId && sameBuyer(r) && r.at !== created
      && r.at >= created - BEFORE && r.at <= created + AFTER);
    if (issued.length) {
      link(best(issued), s.id);
      copies.forEach(hide);
      continue;
    }
    if (copies.length) {
      const keepR = best(copies);
      link(keepR, s.id);
      copies.filter((r) => r !== keepR).forEach(hide);
      continue;
    }
    plan.create.push(s);
  }
  return plan;
}

/** Applies a plan. `allowCreate: false` only repairs (links + hides). */
export async function applySync(plan, { Attendee, User, crypto, allowCreate = true }) {
  let created = 0;
  for (const l of plan.link) {
    if (l.kind === "attendee") await Attendee.updateOne({ _id: l.id }, { $set: { stripeSessionId: l.sessionId } });
    else await User.updateOne({ _id: l.userId, "tickets.ticketId": l.ticketId }, { $set: { "tickets.$.stripeSessionId": l.sessionId } });
  }
  if (plan.hide.length) {
    await Attendee.updateMany({ _id: { $in: plan.hide } }, { $set: { hiddenByStaff: true, syncDuplicate: true } });
  }
  if (allowCreate) {
    for (const s of plan.create) {
      await Attendee.create({
        name: s.customer_details?.name || "Guest",
        email: lc(s.customer_details?.email || s.customer_email),
        ticketId: crypto.randomBytes(6).toString("hex"),
        ticketType: lc(s.metadata.tier),
        purchaseDate: new Date(s.created * 1000),
        stripeSessionId: s.id,
      });
      created += 1;
    }
  }
  return { created, linked: plan.link.length, duplicatesHidden: plan.hide.length };
}

/** Every complete Checkout Session (auto-paginated). */
export async function listCompleteSessions(stripe) {
  const out = [];
  for await (const s of stripe.checkout.sessions.list({ limit: 100, status: "complete" })) out.push(s);
  return out;
}
