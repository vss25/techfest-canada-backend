# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start        # production (node server.js)
npm run dev      # development with hot reload (nodemon server.js)
```

No build, test, or lint scripts are configured.

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
LINKEDIN_CLIENT_ID
LINKEDIN_CLIENT_SECRET
LINKEDIN_REDIRECT_URI

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
| `/api/campaigns` | `routes/campaigns.js` | Email campaign CRUD, launch, batch send (~32 KB) |
| `/api/campaigns/automation` | `routes/campaignAutomation.js` | Automation template scheduling (~22 KB) |
| `/api/track` | `routes/tracking.js` | Email open pixel + click redirect + bounce webhook |
| `/api/kyc` | `routes/kyc.js` | Exhibitor/sponsor KYC forms |
| `/api/subscriptions` | `routes/subscriptions.js` | Newsletter subscriptions |
| `/api/agenda` | `routes/agenda.js` | Event agenda |
| `/api/brochure` | `routes/brochure.js` | Event brochures |
| `/api/profile` | `routes/profile.js` | GET/PATCH attendee profile (linkedinUrl, fieldOfWork, jobTitle, organization, country, topics) |
| `/api/moderate` | `routes/moderate.js` | DeepCleer text-moderation proxy used by the iOS app |
| `/api/intel` | `routes/intel.js` | Gemini-generated company cards (cached in `IntelCard`) for the app's home screen |
| `/api/complete-profile` | `routes/completeProfile.js` | Public "complete your profile" form API (signed `?t=&s=` link, no login). Staff send links from `/api/console/tickets/profile-request` |
| `/api/auth/email-link` | `routes/emailLink.js` | "Email me a sign-in link": `POST /email-link {email, client}` always answers `{sent:true}`; emails a link to `${FRONTEND_URL}/app-login?token=` + a 6-digit code (15 min, single use, 5 code tries; hashes only in `SignInRequest`, TTL index). `POST /email-link/verify {token}` or `{email, code}` → `{token, created}` (30-day app JWT; creates the account for guest ticket holders). Pure parts in `services/emailLink.js`, emails in `services/signInEmail.js` |

### Key Models (`models/`)

- **User** — auth, ticket ownership, reset tokens; roles: `user` / `admin`
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
