import User from "../models/User.js";
import Attendee from "../models/Attendee.js";
import { AdminAudit } from "../models/Admin.js";
import { holderIsAccount } from "./checkinCard.js";
import { sessionRefunded } from "./passConnect.js";
import { cachedStripeSessions } from "./stripeSales.js";
import { normalizeTicketId } from "./ticketAccess.js";

/* =========================================================
   Passes sent to an account's email show up in its app (Oct 24 2026)
   ---------------------------------------------------------
   The organiser: "Auto update their passes in the app. I can't ask
   them to enter pass ID manually." A pass issued to an email (Give a
   pass, a complimentary pass, a Speaker Pass with its email) only
   reached the account with that email when the person signed in with
   the emailed code, and never a staff account (they sign in with a
   password): their app said "Link your pass". Now every pass record
   (Attendee) that
     - isn't hidden by staff, a Stripe-sync duplicate, fully refunded
       (this instance's cached Stripe sessions) or a booth order,
     - isn't claimed by another account, nor on another account's
       tickets (never taken off anyone),
     - has the account's email (any case; never a placeholder), and
     - names the account's holder (services/checkinCard.js
       holderIsAccount: the checkout form's name, else the pass's, must
       agree with the account's; a buyer's email on a colleague's pass
       never links)
   is linked: the ticket goes on the account's tickets (its ID as it
   is: the QR codes don't change) and the pass record is claimed by
   the account (Attendee.claimedBy), exactly as claim-ticket does. The
   pass record keeps everything else (extras, VIP / Media marks, its
   pass emails); no inventory moves. Each link is audited
   `pass_auto_link`, and the people directory and the check-in desks
   are told (the hook routes/people.js sets).
   Run (idempotent, one query by email) on GET /api/auth/me, the
   password and emailed-code sign-ins, and when a pass is made for (or
   given) an email; once for everyone: POST /api/console/people/
   link-passes (management).
   The plan is pure: planPassLinks; test/pass-auto-link*.test.js
========================================================= */

const PLACEHOLDER = /@ticket\.thetechfestival\.com$/i;
const isBooth = (id) => /^BOOTH-/i.test(String(id || ""));
const lower = (v) => String(v || "").trim().toLowerCase();
const str = (v) => (v === null || v === undefined ? "" : String(v));
const realEmail = (v) => { const e = lower(v); return e && !PLACEHOLDER.test(e) ? e : ""; };

/** Why a pass with the account's email isn't linked (the backfill's preview shows them). */
export const SKIP_REASONS = Object.freeze({
  hidden: "Hidden by staff",
  duplicate: "A Stripe-sync duplicate",
  refunded: "Refunded",
  booth: "A booth order",
  claimed_by_other: "Linked to another account",
  on_other_account: "On another account's tickets",
  name_differs: "The name on the pass isn't theirs (a buyer's email on a colleague's pass?)",
});

/**
 * Which of `passes` (the pass records with the account's email) to link to `account` ({ _id, name, email, tickets }).
 * `heldElsewhere`: normalized ticket IDs on another account's tickets; `stripeRows`: cached Stripe sessions
 * ({ id, total, refunded }) or null. Pure.
 * → { link: [pass], skip: [{ pass, why }] } (a pass already linked to them is in neither)
 */
export function planPassLinks({ account, passes = [], heldElsewhere = new Set(), stripeRows = null } = {}) {
  const link = [];
  const skip = [];
  if (!account?._id) return { link, skip };
  const mine = str(account._id);
  const email = realEmail(account.email);
  const onAccount = new Set((account.tickets || []).map((t) => normalizeTicketId(t?.ticketId)).filter(Boolean));
  for (const a of passes || []) {
    if (!a?.ticketId || !email || realEmail(a.email) !== email) continue;
    const norm = normalizeTicketId(a.ticketId);
    const claimedByMe = !!a.claimedBy && str(a.claimedBy) === mine;
    if (claimedByMe && onAccount.has(norm)) continue; // linked already
    let why = "";
    if (a.hiddenByStaff) why = "hidden";
    else if (a.syncDuplicate) why = "duplicate";
    else if (isBooth(a.ticketId)) why = "booth";
    else if (sessionRefunded(a.stripeSessionId, stripeRows)) why = "refunded";
    else if (a.claimedBy && !claimedByMe) why = "claimed_by_other";
    else if (heldElsewhere.has(norm)) why = "on_other_account";
    // The name on the pass must be theirs (a pass claimed by them is theirs already).
    else if (!holderIsAccount({ account, attendee: a })) why = "name_differs";
    if (why) skip.push({ pass: a, why });
    else link.push(a);
  }
  return { link, skip };
}

/** The ticket an account gets for a pass record (as routes/ticketAuth.js ticketFromAttendee: the same fields). */
export function ticketFromPass(a) {
  return {
    ticketId: a.ticketId,
    type: a.ticketType,
    purchaseDate: a.purchaseDate || new Date(),
    checkedIn: !!a.checkedIn,
    checkedInAt: a.checkedInAt,
    ...(a.details ? { details: a.details } : {}),
  };
}

const PASS_SELECT = "name email ticketId ticketType purchaseDate checkedIn checkedInAt details hiddenByStaff syncDuplicate stripeSessionId claimedBy";
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/* After links: the people directory and the desks (routes/people.js sets it: forgetPeople + deskGuestChanged). */
let afterLink = null;
export function setPassLinkHook(fn) { afterLink = typeof fn === "function" ? fn : null; }

/** Link the planned passes (each atomically: claimed only while nobody else has; the ticket added only once). */
async function applyLinks(account, passes, { by = null, trigger = "" } = {}) {
  const linked = [];
  for (const a of passes) {
    const claim = await Attendee.updateOne(
      { _id: a._id, $or: [{ claimedBy: null }, { claimedBy: account._id }] },
      { $set: { claimedBy: account._id } },
    );
    if (!claim.matchedCount) continue; // claimed by someone else a moment ago
    const variants = [...new Set([a.ticketId, normalizeTicketId(a.ticketId), normalizeTicketId(a.ticketId).toUpperCase()])];
    const push = await User.updateOne({ _id: account._id, "tickets.ticketId": { $nin: variants } }, { $push: { tickets: ticketFromPass(a) } });
    if (!claim.modifiedCount && !push.modifiedCount) continue;
    linked.push({ ticketId: a.ticketId, type: a.ticketType || "", name: str(a.name).trim() });
    await AdminAudit.create({
      adminId: by?._id || account._id, adminName: str(by?.name || "Automatic"), action: "pass_auto_link", targetType: "ticket", targetId: a.ticketId,
      detail: `${str(a.name).trim() || "Pass"} · ${str(a.ticketType) || "pass"} ${str(a.ticketId).toUpperCase()} linked to the account ${str(account.name).trim() || str(account._id)} (same email${trigger ? `, ${trigger}` : ""})`.slice(0, 500),
    }).catch(() => {});
  }
  if (linked.length && afterLink) {
    // Never holds up the sign-in or the answer: the directory rebuild and the desk event happen after.
    void Promise.resolve().then(() => afterLink({ account, linked, by })).catch((err) => console.error("PASS AUTO-LINK HOOK ERROR:", err?.message || err));
  }
  return linked;
}

/**
 * Link every pass sent to this account's email that is theirs (see the top). `user`: a User document or its id.
 * `trigger`: what ran it, for the audit ("sign-in", "app refresh", "pass given"…); `by`: the staff member whose action
 * ran it (else the account itself). Never throws (a sign-in or /me never fails over it). → [{ ticketId, type, name }]
 * the passes it linked now ([] when none: the usual case, one indexed query).
 */
export async function autoLinkPasses(user, { trigger = "", by = null } = {}) {
  try {
    const id = user?._id || user;
    if (!id) return [];
    const account = await User.findById(id).select("name email tickets.ticketId banned").lean();
    const email = realEmail(account?.email);
    if (!account || !email || account.banned) return [];
    const passes = await Attendee.find({ email: { $in: [email, new RegExp(`^${escapeRe(email)}$`, "i")] } }).select(PASS_SELECT).lean();
    if (!passes.length) return [];
    const ids = [...new Set(passes.flatMap((a) => [a.ticketId, normalizeTicketId(a.ticketId), normalizeTicketId(a.ticketId).toUpperCase()]))];
    const others = await User.find({ _id: { $ne: account._id }, "tickets.ticketId": { $in: ids } }).select("tickets.ticketId").lean();
    const heldElsewhere = new Set(others.flatMap((u) => (u.tickets || []).map((t) => normalizeTicketId(t?.ticketId))));
    const { link } = planPassLinks({ account, passes, heldElsewhere, stripeRows: cachedStripeSessions()?.rows || null });
    if (!link.length) return [];
    return await applyLinks(account, link, { by, trigger });
  } catch (err) {
    console.error("PASS AUTO-LINK ERROR:", err?.message || err);
    return [];
  }
}

/** The same for the account with this email, if there is one (a pass was just made for, or given, that email). */
export async function autoLinkEmail(email, opts = {}) {
  try {
    const e = realEmail(email);
    if (!e) return [];
    const user = await User.findOne({ email: e }).select("_id").lean();
    return user ? autoLinkPasses(user._id, opts) : [];
  } catch (err) {
    console.error("PASS AUTO-LINK ERROR:", err?.message || err);
    return [];
  }
}

/**
 * Every account at once (the backfill, POST /api/console/people/link-passes): what would be linked and what is left out
 * and why. `apply`: link them too (as `by`). → { accounts, link: [row], skipped: [row], linked: [row] } with row =
 * { ticketId, type, passName (the name on the pass), accountId, accountName, email, why?, reason? }.
 */
export async function backfillPassLinks({ apply = false, by = null } = {}) {
  const passes = await Attendee.find({ email: { $nin: [null, ""] } }).select(PASS_SELECT).lean();
  const byEmail = new Map();
  for (const a of passes) {
    const e = realEmail(a.email);
    if (!e) continue;
    if (!byEmail.has(e)) byEmail.set(e, []);
    byEmail.get(e).push(a);
  }
  const accounts = byEmail.size ? await User.find({ email: { $in: [...byEmail.keys()] } }).select("name email tickets.ticketId banned").lean() : [];
  // Who holds which ticket on their account (to never take one off anyone).
  const ids = [...new Set(passes.flatMap((a) => [a.ticketId, normalizeTicketId(a.ticketId), normalizeTicketId(a.ticketId).toUpperCase()]))];
  const holders = ids.length ? await User.find({ "tickets.ticketId": { $in: ids } }).select("tickets.ticketId").lean() : [];
  const heldBy = new Map();
  for (const u of holders) for (const t of u.tickets || []) {
    const k = normalizeTicketId(t?.ticketId);
    if (!heldBy.has(k)) heldBy.set(k, new Set());
    heldBy.get(k).add(str(u._id));
  }
  const stripeRows = cachedStripeSessions()?.rows || null;
  const row = (account, a, why = "") => ({
    ticketId: a.ticketId, type: a.ticketType || "", passName: str(a.name).trim(), accountId: str(account._id), accountName: str(account.name).trim(),
    email: realEmail(account.email), ...(why ? { why, reason: SKIP_REASONS[why] || why } : {}),
  });
  const out = { accounts: 0, link: [], skipped: [], linked: [] };
  for (const account of accounts) {
    if (account.banned) continue;
    const mine = byEmail.get(realEmail(account.email)) || [];
    const heldElsewhere = new Set(mine.map((a) => normalizeTicketId(a.ticketId))
      .filter((k) => [...(heldBy.get(k) || [])].some((uid) => uid !== str(account._id))));
    const plan = planPassLinks({ account, passes: mine, heldElsewhere, stripeRows });
    if (plan.link.length) out.accounts += 1;
    out.link.push(...plan.link.map((a) => row(account, a)));
    out.skipped.push(...plan.skip.map((s) => row(account, s.pass, s.why)));
    if (apply && plan.link.length) {
      const done = await applyLinks(account, plan.link, { by, trigger: "backfill" });
      const linkedIds = new Set(done.map((d) => d.ticketId));
      out.linked.push(...plan.link.filter((a) => linkedIds.has(a.ticketId)).map((a) => row(account, a)));
    }
  }
  return out;
}
