import test from "node:test";
import assert from "node:assert/strict";
import {
  CHECKIN_BADGE_KEYS, CHECKIN_BADGE_COLORS, checkinBadge, checkinCard, holderIsAccount, plainCard,
} from "../services/checkinCard.js";
import { PROFILE_TAG_COLORS } from "../services/profileTag.js";
import { buildSpeakerPhotos, setSpeakerPhotos } from "../services/speakerPhotos.js";

/* The door check-in card (Oct 22 2026): the staff-facing colour band (VIP gold > Media > Speaker > Staff > Volunteer >
   the pass, green), the holder's photo (uploaded, else speaker photo, else none) and the pass's name, for accounts and
   pass-only tickets, never someone else's photo. Pure: no database, no network. Fictional people, example.com. */

const UID = "a".repeat(24);
const OTHER = "b".repeat(24);
const t = (ticketId, type, extra = {}) => ({ ticketId, type, purchaseDate: new Date("2026-10-01"), ...extra });
const account = (extra = {}) => ({ _id: UID, name: "Pat Person", email: "pat.person@example.com", role: "user", tickets: [], ...extra });
/** The card for the account's first ticket. */
const cardOf = (acc, { attendee = null, rows = [] } = {}) => checkinCard({ ticketId: acc.tickets[0].ticketId, account: acc, ticket: acc.tickets[0], attendee, rows });
const guest = (extra = {}) => ({ name: "Gus Guest", email: "gus.guest@example.com", ticketId: "gst000000001", ticketType: "power", ...extra });
const passCard = (a) => checkinCard({ ticketId: a.ticketId, attendee: a });
const band = (c) => [c.badge.key, c.badge.label];

const IMG = "https://cdn.sanity.io/images/021qtoci/production/abc123-800x800.jpg";

test.afterEach(() => setSpeakerPhotos(null));

test("badge: keys and colours in the order they win, VIP gold first, the rest the Profile tag's", () => {
  assert.deepEqual(CHECKIN_BADGE_KEYS, ["vip", "media", "speaker", "staff", "volunteer", "pass"]);
  assert.deepEqual(CHECKIN_BADGE_COLORS, {
    vip: { bg: "#F5C400", text: "#3D2E00" },
    media: { bg: "#0B3D91", text: "#FFFFFF" }, speaker: { bg: "#D01F2F", text: "#FFFFFF" },
    staff: { bg: "#7B2FD0", text: "#FFFFFF" }, volunteer: { bg: "#FF6B00", text: "#3A1500" }, pass: { bg: "#18A957", text: "#052E16" },
  });
  for (const k of Object.keys(PROFILE_TAG_COLORS)) assert.deepEqual(CHECKIN_BADGE_COLORS[k], PROFILE_TAG_COLORS[k], k);
  assert.deepEqual(checkinBadge({ vip: true, tag: { key: "media", label: "Media" }, passName: "Power Pass" }), { key: "vip", label: "VIP", bg: "#F5C400", text: "#3D2E00" });
  assert.deepEqual(checkinBadge({ tag: { key: "speaker", label: "Speaker" } }), { key: "speaker", label: "Speaker", bg: "#D01F2F", text: "#FFFFFF" });
  // Green says the scanned pass's name; "Exhibitor" when the Profile tag does; no tag at all is still green.
  assert.deepEqual(checkinBadge({ tag: { key: "pass", label: "Apex" }, passName: "Connect Pass" }), { key: "pass", label: "Connect Pass", bg: "#18A957", text: "#052E16" });
  assert.equal(checkinBadge({ tag: { key: "pass", label: "Exhibitor" }, passName: "Connect Pass" }).label, "Exhibitor");
  assert.equal(checkinBadge({ tag: null, passName: "Influence Pass" }).label, "Influence Pass");
  assert.equal(checkinBadge({ tag: { key: "nonsense", label: "?" }, passName: "" }).key, "pass");
  assert.equal(checkinBadge().label, "Pass");
});

test("accounts: each colour, and the organiser's precedence with VIP on top for door staff", () => {
  // VIP beats everything (the flag on the account), although the apps show no VIP tag.
  assert.deepEqual(band(cardOf(account({ vip: true, types: ["speaker", "media"], role: "admin", tickets: [t("pow000000001", "power")] }))), ["vip", "VIP"]);
  // VIP from a pass of theirs (Attendee.vip, claimed by them).
  const claimed = { ticketId: "pow000000002", ticketType: "power", claimedBy: UID, vip: true };
  assert.deepEqual(band(cardOf(account({ tickets: [t("pow000000002", "power")] }), { attendee: claimed, rows: [claimed] })), ["vip", "VIP"]);
  // Staff switched VIP off on the account: their pass's mark doesn't count.
  assert.deepEqual(band(cardOf(account({ vip: false, tickets: [t("pow000000002", "power")] }), { rows: [claimed] })), ["pass", "Power Pass"]);
  // Media > Speaker > Staff > Volunteer > pass.
  assert.deepEqual(band(cardOf(account({ types: ["speaker", "media"], tickets: [t("pow000000003", "power")] }))), ["media", "Media"]);
  assert.deepEqual(band(cardOf(account({ tickets: [t("spk000000004", "speaker")] }))), ["speaker", "Speaker"]);
  assert.deepEqual(band(cardOf(account({ role: "admin", types: ["speaker"], tickets: [t("con000000005", "connect")] }))), ["speaker", "Speaker"]);
  assert.deepEqual(band(cardOf(account({ role: "admin", tickets: [t("con000000006", "connect")] }))), ["staff", "Staff"]);
  assert.deepEqual(band(cardOf(account({ types: ["staff", "volunteer"], tickets: [t("con000000007", "connect")] }))), ["staff", "Staff"]);
  assert.deepEqual(band(cardOf(account({ role: "volunteer", tickets: [t("con000000008", "connect")] }))), ["volunteer", "Volunteer"]);
  // Media from a pass of theirs (Attendee.media) and exhibitors (Connect Pass, "Exhibitor").
  assert.deepEqual(band(cardOf(account({ tickets: [t("pow000000009", "power")] }), { rows: [{ ticketId: "pow000000009", media: true }] })), ["media", "Media"]);
  const eve = cardOf(account({ tickets: [t("con000000010", "connect", { promoCode: "EXHIBITOR" })] }));
  assert.deepEqual([...band(eve), eve.passName, eve.ticketType], ["pass", "Exhibitor", "Connect Pass", "connect"]);
  assert.deepEqual(eve.badge, { key: "pass", label: "Exhibitor", bg: "#18A957", text: "#052E16" });
  // Any other pass: green with the SCANNED pass's name (Ada holds Apex too; the Influence one was scanned).
  const ada = account({ tickets: [t("inf000000011", "influence"), t("apx000000011", "apex")] });
  assert.deepEqual(band(cardOf(ada)), ["pass", "Influence Pass"]);
  assert.deepEqual(band(checkinCard({ ticketId: "apx000000011", account: ada, ticket: ada.tickets[1] })), ["pass", "Apex Pass"]);
  // "All Access" is the Power Pass; an exhibitor pass never says "Exhibitor Pass".
  const aa = cardOf(account({ tickets: [t("all000000012", "All Access")] }));
  assert.deepEqual([aa.passName, aa.ticketType, aa.badge.label], ["Power Pass", "power", "Power Pass"]);
  assert.doesNotMatch(JSON.stringify([eve, aa]), /Exhibitor Pass|All Access/);
});

test("accounts: name, title, company, pass extras and the Speaker Pass flag", () => {
  const sol = cardOf(account({ name: "Sol Speaker", jobTitle: "CTO", organization: "Northwind", tickets: [t("spk000000020", "speaker")] }));
  assert.deepEqual(
    { name: sol.name, title: sol.title, company: sol.company, passName: sol.passName, ticketType: sol.ticketType, speaker: sol.speaker },
    { name: "Sol Speaker", title: "CTO", company: "Northwind", passName: "Speaker Pass", ticketType: "speaker", speaker: true },
  );
  assert.deepEqual(sol.extras, { cxo: true, lunch: true, gala: true, awards: true });
  assert.equal(sol.cxoBreakfast, true);
  // Job from the checkout form when the profile has none; staff's switch on the ticket wins over the pass's rule.
  const ray = cardOf(account({ name: "Ray Reporter", tickets: [t("con000000021", "connect", { details: { firstName: "Ray", lastName: "Reporter", jobTitle: "Editor", organisation: "Daily Bugle" }, luncheons: true })] }));
  assert.deepEqual([ray.title, ray.company], ["Editor", "Daily Bugle"]);
  assert.deepEqual(ray.extras, { cxo: false, lunch: true, gala: false, awards: false });
  // A VIP gets the CxO Breakfasts on any pass.
  assert.equal(cardOf(account({ vip: true, tickets: [t("con000000022", "connect")] })).cxoBreakfast, true);
  // Nothing private on the card.
  assert.deepEqual(Object.keys(sol).sort(), ["avatarUrl", "badge", "company", "cxoBreakfast", "extras", "name", "passName", "speaker", "ticketType", "title"]);
});

test("tickets without an app account: the colour from the pass record (VIP, Media, Speaker Pass, exhibitor, tier)", () => {
  assert.deepEqual(band(passCard(guest({ vip: true }))), ["vip", "VIP"]);
  assert.deepEqual(band(passCard(guest({ vip: true, media: true }))), ["vip", "VIP"]);
  assert.deepEqual(band(passCard(guest({ media: true }))), ["media", "Media"]);
  assert.deepEqual(band(passCard(guest({ ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-x" }))), ["speaker", "Speaker"]);
  assert.deepEqual(band(passCard(guest({ ticketType: "power", promoCode: "SPEAKER" }))), ["speaker", "Speaker"]);
  const ex = passCard(guest({ ticketType: "connect", promoCode: "EXHIBITOR" }));
  assert.deepEqual([...band(ex), ex.passName], ["pass", "Exhibitor", "Connect Pass"]);
  // Staff switched the exhibitor off: a plain Connect Pass.
  assert.deepEqual(band(passCard(guest({ ticketType: "connect", promoCode: "EXHIBITOR", exhibitor: false }))), ["pass", "Connect Pass"]);
  const inf = passCard(guest({ ticketType: "influence", details: { firstName: "Gus", lastName: "Guest", jobTitle: "Analyst", organisation: "Acme" } }));
  assert.deepEqual([...band(inf), inf.name, inf.title, inf.company, inf.avatarUrl], ["pass", "Influence Pass", "Gus Guest", "Analyst", "Acme", ""]);
  assert.deepEqual(inf.extras, { cxo: false, lunch: true, gala: false, awards: false });
  // Media on a Power pass: the CxO Breakfasts (passHolder, services/issuedPasses.js).
  assert.equal(passCard(guest({ media: true })).cxoBreakfast, true);
  assert.equal(passCard(guest()).cxoBreakfast, false);
});

test("a colleague's pass on a buyer's account: the name on the pass, the pass's own colour, never the buyer's photo", () => {
  const buyer = account({
    name: "Sam Staff", role: "admin", vip: true, avatarVersion: 4,
    tickets: [t("col000000030", "influence", { details: { firstName: "Cara", lastName: "Colleague", jobTitle: "Engineer", organisation: "Acme" } })],
  });
  assert.equal(holderIsAccount({ account: buyer, ticket: buyer.tickets[0] }), false);
  const c = cardOf(buyer);
  assert.deepEqual([c.name, c.title, c.company, c.avatarUrl, ...band(c)], ["Cara Colleague", "Engineer", "Acme", "", "pass", "Influence Pass"]);
  assert.equal(c.cxoBreakfast, false);   // the buyer's VIP flag isn't hers
  // The same pass with the buyer's own name on it (title and middle name aside), or no name, is the buyer's.
  const own = account({ name: "Sam Staff", role: "admin", avatarVersion: 4, tickets: [t("own000000031", "influence", { details: { firstName: "Dr. Sam J.", lastName: "Staff" } })] });
  assert.equal(holderIsAccount({ account: own, ticket: own.tickets[0] }), true);
  assert.deepEqual([cardOf(own).avatarUrl, cardOf(own).badge.key], [`/api/files/avatar/${UID}?v=4`, "staff"]);
  assert.equal(holderIsAccount({ account: own, ticket: t("non000000032", "power") }), true);
  // A guest record claimed by the account is theirs, whatever name it carries; an unclaimed one needs agreeing names.
  assert.equal(holderIsAccount({ account: own, attendee: { name: "Someone Else", claimedBy: UID } }), true);
  assert.equal(holderIsAccount({ account: own, attendee: { name: "Someone Else", claimedBy: OTHER } }), false);
  assert.equal(holderIsAccount({ account: own, attendee: { name: "Sam Staff" } }), true);
  assert.equal(holderIsAccount({ account: null, attendee: { name: "Sam Staff" } }), false);
});

test("photo: the uploaded one, else the speaker's website photo, else none; never another person's", () => {
  setSpeakerPhotos(buildSpeakerPhotos({
    speakers: [{ _id: "spk-nina", name: "Nina Speaker", imageUrl: IMG }, { _id: "spk-raj", name: "Raj Patel", imageUrl: IMG.replace("abc123", "raj456") }],
    passes: [
      { speakerId: "spk-nina", name: "Nina Speaker", email: "nina@example.com", ticketId: "spk000000040", claimedBy: UID },
      // A staff member's email on Raj's pass (his assistant), and no account for Raj.
      { speakerId: "spk-raj", name: "Raj Patel", email: "assistant@example.com", ticketId: "spk000000041" },
    ],
    users: [{ _id: UID, name: "Nina Speaker", email: "nina@example.com", tickets: [{ ticketId: "spk000000040" }] }],
  }));
  const nina = account({ name: "Nina Speaker", email: "nina@example.com", tickets: [t("spk000000040", "speaker")] });
  // Uploaded photo wins.
  assert.equal(cardOf({ ...nina, avatarVersion: 7 }).avatarUrl, `/api/files/avatar/${UID}?v=7`);
  // No upload: her speaker photo (Sanity, sized for avatars).
  assert.match(cardOf(nina).avatarUrl, /^https:\/\/cdn\.sanity\.io\/images\/021qtoci\/production\/abc123-800x800\.jpg\?.*w=256/);
  // Neither: "".
  assert.equal(cardOf(account({ _id: OTHER, tickets: [t("pow000000042", "power")] })).avatarUrl, "");
  // Pass-only Raj: his speaker photo by his Speaker Pass's ticket ID, names agreeing.
  const raj = passCard({ name: "Raj Patel", email: "assistant@example.com", ticketId: "spk000000041", ticketType: "speaker", promoCode: "SPEAKER", speakerId: "spk-raj" });
  assert.match(raj.avatarUrl, /raj456/);
  // The assistant's own pass under the same email: not Raj's face.
  assert.equal(passCard({ name: "Ann Assistant", email: "assistant@example.com", ticketId: "con000000043", ticketType: "connect" }).avatarUrl, "");
  // Someone else's ticket on Nina's account (a colleague she bought for): not Nina's face.
  const bought = { ...nina, avatarVersion: 7, tickets: [...nina.tickets, t("col000000044", "power", { details: { firstName: "Cole", lastName: "League" } })] };
  assert.equal(checkinCard({ ticketId: "col000000044", account: bought, ticket: bought.tickets[1] }).avatarUrl, "");
});

test("plainCard: what the scanner shows when the card can't be worked out", () => {
  assert.deepEqual(plainCard({ ticketId: "abc", name: "Pat Person", tier: "apex" }), {
    name: "Pat Person", title: "", company: "", badge: { key: "pass", label: "Apex Pass", bg: "#18A957", text: "#052E16" },
    avatarUrl: "", passName: "Apex Pass", ticketType: "apex", speaker: false,
  });
  assert.equal(plainCard({ ticketId: "abc", tier: "speaker", rec: { ticketType: "speaker" } }).speaker, true);
});
