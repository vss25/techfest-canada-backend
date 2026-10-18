# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # production (node server.js)
npm run dev      # development with hot reload (nodemon server.js)
```

`npm test` runs the unit tests in `test/` (node:test, no database or network). No build or lint scripts.

## Environment Variables

Copy these to a `.env` file (no `.env.example` exists):

```
MONGO_URI
STRIPE_SECRET_KEY
STRIPE_WEBHOOK_SECRET
RESEND_API_KEY
JWT_SECRET
PORT                  # default 5000
FRONTEND_URL
API_URL
LINKEDIN_CLIENT_ID      # LinkedIn app (Sign In with LinkedIn using OpenID Connect): website sign-in and the /attending photo
LINKEDIN_CLIENT_SECRET
LINKEDIN_REDIRECT_URI   # https://<backend>/api/auth/linkedin/callback (shared by both flows)

# Optional — iOS app support
GOOGLE_CLIENT_IDS       # comma-separated OAuth client IDs allowed at POST /api/auth/google (web + iOS). Unset = accept any Google token (legacy)
APP_URL_SCHEME          # default "ttfc" — where /api/payments/app-return sends native-app buyers
DEEPCLEER_ACCESS_KEY    # enables POST /api/moderate (text moderation proxy)
DEEPCLEER_APP_ID        # default "default"
DEEPCLEER_EVENT_ID      # default "text"
DEEPCLEER_ENDPOINT      # default US-East /text/v4
DEEPCLEER_HOLD_ON_REVIEW # default true — REVIEW results are held, not just REJECT
GEMINI_API_KEY          # enables GET /api/intel (company-intel cards, refreshed daily)
GEMINI_MODEL            # default gemini-2.5-flash
INTEL_TTL_HOURS         # default 24

# Optional — brochure downloads
BROCHURE_SALES_INBOX    # default sales@thetechfestival.com (comma-separate for several)
BROCHURE_ATTACH_MAX_MB  # default 7; the PDF is attached only at or under this size, else link only (0 = always link)
BROCHURE_BASE_URL       # default https://www.thetechfestival.com — where the PDF is linked/fetched from

# Optional — website forms (volunteer, speaker, booth, sponsor, partnership, enquiry)
FORMS_INBOX             # default baldeep@thetechfestival.com (comma-separate for several)
```

## Architecture

Node.js + Express REST API using **ES modules** (`"type": "module"` in package.json). MongoDB via Mongoose.

**Entry point:** `server.js` — mounts all routes, configures CORS, connects to MongoDB, and handles the Stripe webhook raw body parser (must stay before `express.json()`).

### Route → File Map

| Mount | File | Notes |
|-------|------|-------|
| `/api/auth` | `routes/auth.js` | JWT + bcrypt + Google/LinkedIn OAuth |
| `/api/payments` | `routes/payments.js` | Stripe checkout session creation |
| `/api/webhook` | `routes/webhook.js` | Stripe webhook; ticket PDF + QR code generation |
| `/api/checkin` | `routes/checkin.js` | QR code scan check-in |
| `/api/admin` | `routes/admin.js` | Sales analytics, inventory management |
| `/api` (promos) | `routes/promos.js` | `POST /promos/validate` (public), `GET/POST/PUT/DELETE /admin/promos` (management). "Used" = **paid uses**: complete + paid Stripe Checkout Sessions with the code in `metadata.promoCode` (`promoUsage` in `services/stripeSales.js`, cached 5 min); `Promo.timesUsed` is not used. Optional `maxUses` (null = unlimited): validate and `create-checkout` refuse a code whose paid uses + checkouts in progress reach it ("This code has reached its limit."); capped checkouts expire after 31 min and are created one at a time per code (in-process lock). See `services/promoLimits.js` |
| `/api/campaigns` | `routes/campaigns.js` | Email campaign CRUD, launch, batch send (~32 KB) |
| `/api/campaigns/automation` | `routes/campaignAutomation.js` | Automation template scheduling (~22 KB) |
| `/api/track` | `routes/tracking.js` | Email open pixel + click redirect + bounce webhook |
| `/api/kyc` | `routes/kyc.js` | Exhibitor/sponsor KYC forms |
| `/api/subscriptions` | `routes/subscriptions.js` | Newsletter subscriptions |
| `/api/agenda` | `routes/agenda.js` | Event agenda |
| `/api/brochure` | `routes/brochure.js` | `POST /submit`: saves a brochure download (`Brochure` model), answers at once, then emails the person the PDF link (attached only if small, see `BROCHURE_ATTACH_MAX_MB`) and a receipt to sales@. Honeypot `_hp`, per-IP/per-email limits, no re-send of the same brochure within 10 min. Staff list: `GET /api/console/brochure-downloads` (+ `/export` CSV, management). Pure parts in `services/brochureDownloads.js`, emails in `services/brochureEmail.js` |
| `/api` (pavilion) | `routes/pavilion.js` | `POST /pavilion`: India Startup Pavilion application. Saved first (`PavilionApplication`, every form field + unknown extras in `raw`, gets a reference like `IP-7K3QXM`), then emailed to sales@ and the applicant; a failed save still emails, a failed email still answers 201. Bots (honeypot `_hp`, `botReason` random text / instant fill) are saved as spam and never emailed. $500 deposits (Stripe Checkout `metadata.type: "pavilion-deposit"`) are recorded in `PavilionDeposit` by the webhook and from the revenue page's Stripe read, and linked to the application by reference, email, then company (`services/pavilionDeposits.js`). Staff: `GET/PATCH /api/console/pavilion-applications[/:id]` (+ `/export` CSV, management). Pure parts in `services/pavilionApplications.js` |
| `/api/forms` | `routes/forms.js` | `POST /:form` (form = `volunteer` / `speaker` / `exhibit` / `sponsor` / `partnership` / `inquiry`): the website forms that used EmailJS until Oct 2026. Saved first (`FormSubmission`: name/first/last, email, phone, company, job title, message, every other field in `fields`), answered 201, then emailed in the background to `FORMS_INBOX` with reply-to the visitor. Every value is HTML-escaped; only http(s) links are clickable. Bots (honeypot `_hp`, `botReason`) are saved as spam and never emailed. A failed save still emails; 500 only if both fail. Staff: `GET/PATCH /api/console/form-submissions[/:id]`, `/export` CSV and `POST /import` (rows recovered from EmailJS, `source: "recovered"`, never emailed), both management. Pure parts in `services/formSubmissions.js`, handler in `services/formSubmitHandler.js` |
| `/api/rsvp` | `routes/rsvp.js` | TTFC 2026 RSVPs from the unlinked website page `/rsvp`. `GET /options` serves the one copy of what each pass includes (days, luncheons, CxO breakfasts, gala, awards, meetings, lounge; must match the Tickets page). `POST /lookup {firstName, lastName, ticketId?}` → `{kind: ticket\|speaker\|none, tier?, verified}`: ticket ID + last name like `/auth/ticket-login` (and from the same per-ticket budget, `ticketGuesses` in `services/ticketAccess.js`: 5 different last names per ticket per 15 min across sign-in, lookup and submit), else first AND last name against the Sanity speaker list (10-min cache) and then ticket holders (only when exactly one person matches, unverified). Never returns email or ticket IDs; limited per IP, IP + name and ticket. `POST /` re-runs the lookup, enforces the matrix for the resolved pass and saves one `Rsvp` per person (verified ticket ID, else folded full name). Speakers are matched by public name, so saved as unverified. A saved RSVP changes only with proof: the same verified ticket, or the `editToken` the first save returned (send it back as `editToken`). Otherwise a second RSVP for the name gets its own row marked `duplicateOf`, left out of the headcounts until staff merge it or keep it separate (`POST /api/console/rsvps/:id/resolve {action: merge\|separate}`). The answer never says whether someone had RSVP'd. Bots (`_hp`, `botReason`) get their own spam rows. No email. Staff: `GET /api/console/rsvps[/:id]` (headcounts, `verifiedCounts`, `?review=1` for possible duplicates) and `/export` CSV (management). Pure parts in `services/rsvp.js`, handlers in `services/rsvpHandler.js` |
| `/api/profile` | `routes/profile.js` | GET/PATCH attendee profile (linkedinUrl, fieldOfWork, jobTitle, organization, country, topics) |
| `/api/moderate` | `routes/moderate.js` | DeepCleer text-moderation proxy used by the iOS app |
| `/api/intel` | `routes/intel.js` | Gemini-generated company cards (cached in `IntelCard`) for the app's home screen |
| `/api/console/notify…` | `routes/console.js` | Staff → personal notifications (`GET recipients?q=`, `POST /notify`, `GET history`). Stored in `AppNotification`; helpers in `services/notifyHelpers.js` |
| `/api/console/speaker-passes…` | `routes/console.js` | Speaker Passes: a ghost pass (`ticketType: "speaker"`, promo `SPEAKER`, "Speaker Pass") for every Sanity `speaker` doc except Chris Golden. Never sold, not in `TicketInventory`, left out of sales numbers and duplicate detection; RSVP tier `speaker` (every option); ticket sign-in and the `TECHFEST:<ticketId>` QR work like any pass. Created with no email (the Attendee model allows that for `speaker` only). `GET /` rows + counts, `POST /sync` (management, idempotent, keyed by `speakerId` with a unique index), `PATCH /:id {email}`, `GET /:id/preview` and `/preview-sample` → `{subject, html, text}` (QR inline as a data: URI), `POST /:id/send` and `POST /send-all {confirm: "SEND"}` (management; Resend with the QR and logo as inline CID images, reply-to enquire@; records `passEmailSentAt/To/Count`). Pure parts in `services/speakerPasses.js`, email in `services/speakerPassEmail.js` |
| `/api/attending` | `routes/attending.js` | The website's unlinked `/attending` page ("I'm attending TTFC 2026" image for LinkedIn, drawn in the browser). `GET /linkedin` starts LinkedIn OpenID sign-in (scope `openid profile`) with the existing LinkedIn app and its registered redirect URI; `attendingLinkedinCallback` is mounted in `server.js` on `GET /api/auth/linkedin/callback` before `routes/auth.js` and handles only states starting `ttfc-att.` (checked against an HttpOnly cookie), then redirects to `/attending#li=1&fn=&ln=&pic=` (or `#li_error=`). Nothing is saved, no account is made. `GET /photo?u=` proxies the LinkedIn picture when its CDN refuses CORS: https `media.licdn.com` only, no redirects, images only, 5 MB cap, 30/15 min per IP. Not configured (any `LINKEDIN_*` missing) → `#li_error=unavailable` and the page offers upload instead |
| `/api/console/attending-campaign` | `routes/attendingCampaign.js` | "Show the world you're attending" email to every ticket holder (Admin → Marketing → I'm attending campaign). Recipients are read live (`planRecipients` in `services/attendingCampaign.js`): one per unique email across `User.tickets` and `Attendee`, Speaker Passes once they have an email; left out: `hiddenByStaff` tickets, booths, `@ticket.thetechfestival.com` placeholders, no email, banned accounts, `Subscription.subscribed: false`. `GET /preview-sample`, `GET /recipients` (`counts`, `skipped`, rows with send status, `job`), `POST /send-test {to}` and `POST /send-all {confirm: "SEND"}` (management, audited). Send-all answers 202 and runs in the background, 600 ms apart; each person is claimed in `CampaignSend` (unique `campaign` + `email`) before Resend is called, so re-running never double-sends ("failed" rows are retried, "sending" rows are left for staff to check). Email in `services/attendingEmail.js` (logo + `assets/email/attending-preview.jpg` as inline CID images, reply-to enquire@, `List-Unsubscribe` mailto, Resend tag `campaign=attending-2026`). Not built on `routes/campaigns.js`: that sends a static Audience with raw `{{token}}` replacement (no URL-encoding, its `/title` shortcut would rewrite the link) and can't resume a half-finished launch without re-sending |
| `/api/social/notifications` | `routes/social.js` | App polls its personal notifications (`?since=`), `POST /read { ids \| all }`. No APNs/FCM yet |
| `/api/social/feed…`, `/activity…`, `/users/:id` | `routes/social.js` | Posts take `mentions: [{type: user\|speaker, id, name}]` (≤10; user ids must be real accounts, speaker ids are Sanity ids); `postDTO` adds `mentions` and `canRemove`. `GET /feed/:id` one post (hidden/held only for author or staff; blocks → 404). `DELETE /feed/:id`: the author deletes it (with comments), staff hide it (`status: "hidden"`, `removedBy`, `removedAt`), else 403. Personal activity in `ActivityEvent` (first-ever like, comment, mention, discussion reply; never self or blocked; no push, no AppNotification): `GET /activity/unread` → `{feed, discussions}` since `User.activitySeen[section]`, `POST /activity/seen {section}`, `GET /activity?section=&limit=`. `GET /users/:id` = `publicProfile` (card + fieldOfWork, jobLevel, objectives; never email/role/tickets/gender). `POST /api/app/report` also sends every staff account an AppNotification (`kind: "report"`, link `ttfc://moderation`) + push, at most 10 per reporter per 10 min. Pure parts in `services/socialActivity.js` |
| `/api/social/connections…`, `/messages…` (contact switches) | `routes/social.js` | Staff switches on a person for VIPs who won't reply (e.g. ministers): `User.messagesOff`, `User.requestsOff` (default false), edited via `PATCH /api/console/users/:id` (audited like other edits) and returned by `GET /api/console/users[/:id]` (the list also has `directoryHidden`). `POST /connections/request` to someone with `requestsOff` → 403 `{error: "<First name> isn't taking connection requests in the app."}` unless the sender is staff (`role: "admin"`); existing pending/accepted rows still work (accepting their request, the mutual-request auto-accept), and `POST /connections/in-person` (badge scan) is unaffected. `POST /messages/:userId` to someone with `messagesOff` → 403 `{error: "<First name> isn't taking messages in the app."}` unless the sender is staff, an accepted connection, or they wrote to the sender before (so replies work). The VIP can still message and request out; group chats are unaffected. User cards (`userCard`, `/attendees` entries, group members) carry `acceptsMessages` / `acceptsRequests`: `!messagesOff` / `!requestsOff`, then corrected for the viewer in the routes (`services/contactAccess.js`), so they're false only when this viewer would get the 403. Card queries must select `CARD_SELECT` (`services/socialHelpers.js`). Rules in `services/contactSwitches.js` (`canMessage`, `canRequest`) |
| `/api/complete-profile` | `routes/completeProfile.js` | Public "complete your profile" form API (signed `?t=&s=` link, no login). Staff send links from `/api/console/tickets/profile-request` |
| `/api/auth/email-link` | `routes/emailLink.js` | "Email me a sign-in link": `POST /email-link {email, client}` always answers `{sent:true}`; emails a link to `${FRONTEND_URL}/app-login?token=` + a 6-digit code (15 min, single use, 5 code tries; hashes only in `SignInRequest`, TTL index). `POST /email-link/verify {token}` or `{email, code}` → `{token, created}` (30-day app JWT; creates the account for guest ticket holders). Pure parts in `services/emailLink.js`, emails in `services/signInEmail.js` |

### Key Models (`models/`)

- **User** — auth, ticket ownership, reset tokens; roles: `user` / `admin`. Staff contact switches `messagesOff` / `requestsOff` (see the contact switches row above)
- **Campaign** — email campaigns with open/click/bounce stats
- **CampaignTemplate** — 5-phase automation sequences
- **Audience** — contact lists with nested contact schema (CSV import via multer)
- **EmailTracking** — per-email engagement (opens, clicks, bounces with IP/UA)
- **TicketInventory** — ticket tiers with pricing and sold counts
- **Subscription, Kyc, Agenda, Brochure** — supporting data

### Email System (`routes/campaigns.js`, `services/`)

- Emails sent via **Resend** (`resend` package)
- `sanitizeEmailHtml()` strips `<title>` tags
- `wrapLinksWithTracking()` injects a 1×1 tracking pixel and rewrites `<a href>` links through `/api/track/click/:id`
- `sendBatchCampaignEmails()` handles rate-limited batch delivery
- Bounce events arrive via Resend webhook at `/api/track/bounce`

### iOS app (github.com/gunantsingh-del/techfest-canada-ios)

- Signs in with the same accounts (`/api/auth/login`, `/register`, `/google`), reads `/api/auth/me`, patches `/api/profile`.
- Checkout: `POST /api/payments/create-checkout { tier, client: "ios" }` with a Bearer token. The buyer's `userId` goes into Stripe metadata so the webhook attaches the ticket to the account; success/cancel return via `/api/payments/app-return`, which opens `ttfc://checkout-complete`.
- Ticket QR is `TECHFEST:<ticketId>` (same as the website wallet); `/api/checkin/scan` is admin-only.

### Stripe Integration

- Automatic tax (HST/GST Canada) is enabled on checkout sessions
- Booth purchases vs. ticket purchases use different metadata and redirect URLs
- **Critical:** the webhook route must receive the raw body — `server.js` applies `express.raw()` before `express.json()` for that path

### Auth Middleware

`middleware/adminAuth.js` exports `requireAdmin()` — attach to any route that should be admin-only.

### CORS Allowed Origins

`thetechfestival.com`, `techfest-canada-frontend.vercel.app`, `techfest-canada-backend.onrender.com`, `techfest-api.onrender.com`, `localhost:5173`
