/* What the apps' profile steps need, merged from everything we already know.

   An attendee may have answered the same questions on the website checkout
   form (stored on each ticket as `details`), or staff may have filled them in
   from the admin panel. The apps read the account from /api/auth/me and only
   ask what's still missing, so these merges must never invent answers:
   the account's own value wins, the newest checkout answer fills a gap.

   When the app's onboarding finishes, mirrorProfileToTickets() copies the
   answers back onto the tickets' details (gaps only), so the admin panel's
   ticket list and attendee export show them too. Pure, unit-tested. */

const blank = (v) => (Array.isArray(v) ? v.length === 0 : !String(v ?? "").trim());

// account field ← checkout-form field
const FROM_DETAILS = [
  ["salutation", "salutation"],
  ["jobTitle", "jobTitle"],
  ["organization", "organisation"],
  ["country", "country"],
  ["linkedinUrl", "linkedin"],
  ["jobLevel", "jobLevel"],
  ["fieldOfWork", "jobFunction"],
  ["topics", "topics"],
  ["objectives", "objectives"],
];

const time = (t) => new Date(t?.purchaseDate || t?.createdAt || 0).getTime() || 0;

/** Checkout details from tickets (and claimed guest rows), newest first. */
export function detailSources(tickets = [], extra = []) {
  return [...tickets, ...extra]
    .filter((t) => t && t.details && typeof t.details === "object")
    .sort((a, b) => time(b) - time(a))
    .map((t) => t.details);
}

/** The account with empty profile fields filled from checkout answers. */
export function withCheckoutProfile(user, extraSources = []) {
  if (!user) return user;
  const out = { ...user };
  const sources = detailSources(user.tickets, extraSources);
  for (const [field, key] of FROM_DETAILS) {
    if (!blank(out[field])) continue;
    const found = sources.find((d) => !blank(d[key]));
    if (found) out[field] = Array.isArray(found[key]) ? [...found[key]] : String(found[key]).trim();
  }
  if (blank(out.name)) {
    const d = sources.find((x) => !blank(x.firstName));
    if (d) out.name = [d.firstName, d.lastName].filter(Boolean).join(" ").trim();
  }
  return out;
}

// checkout-form field ← account field
const TO_DETAILS = FROM_DETAILS.map(([field, key]) => [key, field]);

/** Each ticket's details with gaps filled from the profile. Returns only the
    tickets that changed: [{ index, details }]. Booths are left alone. */
export function mirrorProfileToTickets(user, now = new Date()) {
  const changes = [];
  const [firstName = "", ...rest] = String(user?.name || "").trim().split(/\s+/);
  const lastName = rest.join(" ");
  (user?.tickets || []).forEach((t, index) => {
    if (!t?.ticketId || /^BOOTH-/i.test(t.ticketId)) return;
    const details = { ...(t.details || {}) };
    let changed = false;
    const fill = (key, v) => {
      if (blank(v) || !blank(details[key])) return;
      details[key] = Array.isArray(v) ? [...v] : String(v).trim();
      changed = true;
    };
    fill("firstName", firstName);
    fill("lastName", lastName);
    for (const [key, field] of TO_DETAILS) fill(key, user[field]);
    if (!changed) return;
    if (!details.source) details.source = "app";
    details.appUpdatedAt = now.toISOString();
    changes.push({ index, details });
  });
  return changes;
}

/** Consent fields the apps may send. The server stamps the times. */
export const TERMS_VERSION_MAX = 40;
export function consentPatch(body = {}, current = {}, now = new Date()) {
  const out = {};
  if (body.ageConfirmed === true && !current.ageConfirmedAt) out.ageConfirmedAt = now;
  if (typeof body.termsVersion === "string" && body.termsVersion.trim()) {
    const v = body.termsVersion.trim().slice(0, TERMS_VERSION_MAX);
    if (v !== current.termsVersion) { out.termsVersion = v; out.termsAcceptedAt = now; }
  }
  return out;
}
