/* =========================================================
   Where the admin search reads from (services/adminSearch.js
   matches and builds the results). Read only: nothing here
   writes, creates or emails.
     directory    the People directory (routes/people.js
                  `directory`: accounts, passes, website
                  speakers, RSVPs, built at most every 20 s)
     ticketDocs   pass rows by exact ticket ID, for passes the
                  directory leaves out (hidden by staff, booths)
     cms          Sanity sessions, speakers, partners and logo
                  strips from the public CDN (read only, 60 s)
     nominations, forms, brochures, pavilion, staff
                  the collections behind those pages, narrowed by
                  services/adminSearch.js prefilter (indexed exact
                  email, else an escaped accent-insensitive word),
                  at most PREFILTER_LIMIT rows, MAX_TIME_MS each
   Indexes these use: Attendee.ticketId (unique), Brochure
   {email, brochure, createdAt}, FormSubmission {email},
   Nomination {nomineeEmail} and {nominatorEmail} (added for
   this), PavilionApplication {repEmail}. Text words can't use
   an index (a case-insensitive word anywhere in a field); the
   lead collections are small and each read is capped.
========================================================= */

import Attendee from "../models/Attendee.js";
import User from "../models/User.js";
import Nomination from "../models/Nomination.js";
import FormSubmission from "../models/FormSubmission.js";
import Brochure from "../models/Brochure.js";
import PavilionApplication from "../models/PavilionApplication.js";
import { makeAgendaCache } from "./points.js";
import { SANITY_PROJECT } from "./rsvp.js";
import { PREFILTER_LIMIT, accentRegex, prefilter } from "./adminSearch.js";

export const MAX_TIME_MS = 4000;
const NOT_SPAM = { spam: { $ne: true } };

/* Every CMS document the search covers, in one CDN query. */
export const CMS_SEARCH_GROQ = '*[_type in ["session","speaker","partner","sponsor","sponsorMarquee","homeSponsor"] && !(_id in path("drafts.**"))]'
  + '{_id,_type,name,title,company,featured,category,matrixGroup,active,day,time,endTime,stage,type,format,sessionId,'
  + '"speakers":speakers[].name,"moderator":moderator.name}';

/** The CMS source: the last good copy for 60 s; throws when the CMS has never answered (its groups are skipped). */
export function makeCmsSource({ fetchImpl = (...a) => globalThis.fetch(...a), ttlMs = 60 * 1000, log = console } = {}) {
  const cache = makeAgendaCache({
    fetchImpl, ttlMs, retryMs: 30 * 1000, log, label: "ADMIN SEARCH CMS",
    url: `https://${SANITY_PROJECT}.apicdn.sanity.io/v2021-10-21/data/query/production?query=${encodeURIComponent(CMS_SEARCH_GROQ)}`,
    parse: (json) => (Array.isArray(json?.result) ? json.result : null),
  });
  return async () => {
    const docs = await cache.get();
    if (!docs) throw Object.assign(new Error("The CMS didn't answer"), { name: "CmsUnavailable" });
    return docs;
  };
}

/** The ways a ticket ID may be stored: as generated (lower-case hex), upper case, as typed (TECHFEST: and spaces off). */
export function ticketVariants(pq) {
  const typed = String(pq.text || "").replace(/^TECHFEST:/i, "").replace(/\s+/g, "");
  return [...new Set([pq.ticket, pq.ticket.toUpperCase(), typed].filter(Boolean))];
}

/**
 * The sources for runSearch. `directory`: () => Promise of the People directory ({ people, rsvps, … }).
 * `models` and `cms` can be swapped in tests.
 */
export function makeSearchSources({
  directory,
  cms = makeCmsSource(),
  models = { Attendee, User, Nomination, FormSubmission, Brochure, PavilionApplication },
  maxTimeMS = MAX_TIME_MS,
} = {}) {
  const M = models;
  const read = (Model, pq, spec, select, sort = { createdAt: -1 }) => {
    const filter = prefilter(pq, spec);
    if (!filter) return Promise.resolve([]);
    return Model.find(filter).select(select).sort(sort).limit(PREFILTER_LIMIT).maxTimeMS(maxTimeMS).lean();
  };
  return {
    directory: async () => {
      const d = await directory();
      // promoCodes: the coupon codes the volunteer panel masks in people's free text (services/volunteerSafe.js).
      return { people: d?.people || [], rsvps: d?.rsvps || [], promoCodes: d?.promoCodes || null };
    },
    ticketDocs: (pq) => (pq.ticket
      ? M.Attendee.find({ ticketId: { $in: ticketVariants(pq) } })
        .select("name ticketId ticketType checkedIn hiddenByStaff syncDuplicate").limit(5).maxTimeMS(maxTimeMS).lean()
      : Promise.resolve([])),
    cms,
    nominations: (pq) => read(M.Nomination, pq, {
      text: ["nomineeName", "nomineeOrganisation", "nominatorName", "nominatorOrganisation"], emails: ["nomineeEmail", "nominatorEmail"],
    }, "nomineeName nomineeOrganisation nomineeEmail nominatorName nominatorOrganisation nominatorEmail selfNomination "
      + "categoryType pillar sector specialAward status submittedAt createdAt", { submittedAt: -1, createdAt: -1 }),
    forms: (pq) => read(M.FormSubmission, pq, {
      text: ["name", "firstName", "lastName", "company", "jobTitle"], emails: ["email"], base: NOT_SPAM,
    }, "form name firstName lastName email company jobTitle status createdAt"),
    brochures: (pq) => read(M.Brochure, pq, {
      text: ["firstName", "lastName", "company", "jobTitle"], emails: ["email"], base: NOT_SPAM,
    }, "firstName lastName email company jobTitle brochure createdAt"),
    pavilion: (pq) => read(M.PavilionApplication, pq, {
      text: ["legalName", "tradingName", "repName", "reference"], emails: ["repEmail"], base: NOT_SPAM,
    }, "legalName tradingName repName repEmail reference status createdAt"),
    // Staff and volunteers (management only: runSearch never calls this for anyone else).
    staff: (pq) => {
      const role = { role: { $in: ["admin", "volunteer"] } };
      const word = [...pq.words].sort((a, b) => b.length - a.length)[0];
      const filter = pq.email ? { ...role, email: { $in: [...new Set([pq.email, pq.text])] } } : word ? { ...role, name: accentRegex(word) } : null;
      if (!filter) return Promise.resolve([]);
      return M.User.find(filter).select("name email role staffRole").limit(PREFILTER_LIMIT).maxTimeMS(maxTimeMS).lean();
    },
  };
}
