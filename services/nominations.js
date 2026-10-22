/* =========================================================
   Catalyst Awards nominations
   ---------------------------------------------------------
   The website form (thetechfestival.com/awards/nominations,
   POST /api/nominations) is saved here as well as emailed to
   baldeep@ and nicole@. Before Oct 2026 it was only emailed: those
   come back from the email service's log (Resend keeps what it
   sent), parsed from the "[Catalyst Nomination]" emails, with
   source "email". Admin → Catalyst Awards → Nominations lists them
   (routes/console.js). Pure parts here; unit-tested in
   test/nominations.test.js.
========================================================= */

export const NOMINATION_STATUSES = ["pending", "shortlisted", "winner", "rejected"];

export const SPECIAL_AWARDS = Object.freeze({
  lifetime: "Lifetime Achievement Award",
  rising: "Rising Innovator Award",
  crossborder: "Cross-Border Impact Award",
});

/** "The Catalyst Award for AI & Machine Learning in Healthcare" / "Rising Innovator Award". */
export function categoryLabel(n = {}) {
  if (n.categoryType === "matrix") return `The Catalyst Award for ${n.pillar || "?"} in ${n.sector || "?"}`;
  return SPECIAL_AWARDS[n.specialAward] || "Special Recognition";
}

/** "AI & Machine Learning × Healthcare" / "Rising Innovator". */
export function categoryShort(n = {}) {
  if (n.categoryType === "matrix") return `${n.pillar || "?"} × ${n.sector || "?"}`;
  return (SPECIAL_AWARDS[n.specialAward] || "Special Recognition").replace(/ Award$/, "");
}

/* ---------- the canonical categories (5 pillars × 5 sectors + 3 special awards) ----------
   Exactly the names the website's nomination form offers (website src/lib/catalystCategories.js,
   used by src/components/NominationForm.jsx): what nominations store, the jury ranks by and the
   apps count. Staff changes (below) must use one of these. */

export const PILLARS = Object.freeze([
  "AI & Machine Learning",
  "Quantum Computing",
  "Cybersecurity & Digital Trust",
  "Robotics & Automation",
  "CleanTech & Sustainability",
]);

export const SECTORS = Object.freeze([
  "Financial Services & Banking",
  "Healthcare & Life Sciences",
  "Energy & Critical Infrastructure",
  "Manufacturing, Supply Chain & Mobility",
  "Public Sector, Defence & Security",
]);

/** For the admin form: { pillars, sectors, specialAwards: [{ key, label }] }. */
export const CATEGORY_OPTIONS = Object.freeze({
  pillars: PILLARS,
  sectors: SECTORS,
  specialAwards: Object.freeze(Object.entries(SPECIAL_AWARDS).map(([key, label]) => Object.freeze({ key, label }))),
});

/** "AI & Machine Learning · Healthcare & Life Sciences" / "FinTech" / "" (the nominee's focus pillar and sector). */
export function focusLabel(n = {}) {
  return [n.nomineePillar, n.nomineeSector].map((v) => String(v ?? "").trim()).filter(Boolean).join(" · ");
}

/* ---------- staff changes to the category and the nominee's focus ----------
   The live fields (categoryType, pillar, sector, specialAward, nomineeSector, nomineePillar) are changed in
   place, so the jury, the results, the apps' category count, the CSV and the filters follow; the first change
   copies what was submitted into `submitted` (once, never overwritten). */

export const CATEGORY_FIELDS = Object.freeze(["categoryType", "pillar", "sector", "specialAward"]);
export const FOCUS_FIELDS = Object.freeze(["nomineeSector", "nomineePillar"]);
export const SUBMITTED_FIELDS = Object.freeze([...CATEGORY_FIELDS, ...FOCUS_FIELDS]);
export const NOTE_MAX = 500;
export const RESTORE_WHAT = Object.freeze(["category", "focus", "both"]);

const str = (v) => String(v ?? "");
const pick = (n, keys) => Object.fromEntries(keys.map((k) => [k, str(n?.[k])]));

/** The six values as they are now: what `submitted` is set to at the first change. */
export const snapshotOf = (n = {}) => pick(n, SUBMITTED_FIELDS);
export const categoryOf = (n = {}) => pick(n, CATEGORY_FIELDS);
export const focusOf = (n = {}) => pick(n, FOCUS_FIELDS);

/** What the nominator submitted (the six values), or null while nothing has been changed. */
export const submittedOf = (n = {}) => (n?.submitted && typeof n.submitted === "object" ? snapshotOf(n.submitted) : null);

const sameIn = (keys) => (a = {}, b = {}) => keys.every((k) => str(a[k]) === str(b[k]));
export const sameCategory = sameIn(CATEGORY_FIELDS);
export const sameFocus = sameIn(FOCUS_FIELDS);

/** Does the live category / focus differ from what was submitted? */
export function changedParts(n = {}) {
  const sub = submittedOf(n);
  return { category: !!sub && !sameCategory(sub, n), focus: !!sub && !sameFocus(sub, n) };
}

/** A name from `list`, matched without regard to case or extra spaces → the canonical name, else null. */
function canonical(list, v) {
  if (typeof v !== "string") return null;
  const want = v.replace(/\s+/g, " ").trim().toLowerCase();
  return list.find((x) => x.toLowerCase() === want) ?? null;
}

const noteOf = (v) => (typeof v === "string" ? v : "").replace(/[^\P{Cc}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, NOTE_MAX);

/**
 * PATCH /:id/category { categoryType, pillar?, sector?, specialAward?, note? } → { ok, set, note } | { ok: false, error }.
 * Matrix: a pillar and a sector from the lists (specialAward cleared). Special: one of the three awards
 * (pillar and sector cleared). Anything else is refused.
 */
export function cleanCategoryChange(body = {}) {
  const type = body?.categoryType;
  if (type === "matrix") {
    const pillar = canonical(PILLARS, body.pillar);
    if (!pillar) return { ok: false, error: `Pillar must be one of: ${PILLARS.join("; ")}.` };
    const sector = canonical(SECTORS, body.sector);
    if (!sector) return { ok: false, error: `Sector must be one of: ${SECTORS.join("; ")}.` };
    return { ok: true, set: { categoryType: "matrix", pillar, sector, specialAward: "" }, note: noteOf(body.note) };
  }
  if (type === "special") {
    const key = typeof body.specialAward === "string" ? body.specialAward.trim() : "";
    if (!Object.hasOwn(SPECIAL_AWARDS, key)) return { ok: false, error: `Special award must be one of: ${Object.keys(SPECIAL_AWARDS).join(", ")}.` };
    return { ok: true, set: { categoryType: "special", pillar: "", sector: "", specialAward: key }, note: noteOf(body.note) };
  }
  return { ok: false, error: 'categoryType must be "matrix" or "special".' };
}

/**
 * PATCH /:id/focus { nomineeSector?, nomineePillar?, note? } → { ok, set, note } | { ok: false, error }.
 * Either may be "" (none). The pillar comes from the pillar list; the sector from the sector list, or stays
 * exactly as it is now (the form took it as free text, so "FinTech" can be kept while the pillar changes).
 * `set` has both fields (the one not sent stays as it is).
 */
export function cleanFocusChange(body = {}, current = {}) {
  const b = body && typeof body === "object" ? body : {};
  const set = {};
  if ("nomineePillar" in b) {
    const v = b.nomineePillar;
    if (v === "" || v === null) set.nomineePillar = "";
    else {
      const p = canonical(PILLARS, v);
      if (!p) return { ok: false, error: `Focus pillar must be one of: ${PILLARS.join("; ")} (or none).` };
      set.nomineePillar = p;
    }
  }
  if ("nomineeSector" in b) {
    const v = b.nomineeSector;
    if (v === "" || v === null) set.nomineeSector = "";
    else if (typeof v === "string" && v.trim() && v === str(current.nomineeSector)) set.nomineeSector = v;
    else {
      const s = canonical(SECTORS, v);
      if (!s) return { ok: false, error: `Focus sector must be one of: ${SECTORS.join("; ")} (or none).` };
      set.nomineeSector = s;
    }
  }
  if (!Object.keys(set).length) return { ok: false, error: "Send nomineeSector and/or nomineePillar." };
  return { ok: true, set: { ...focusOf(current), ...set }, note: noteOf(b.note) };
}

/** POST /:id/restore-submitted { what } → "category" | "focus" | "both", else null. */
export const cleanRestoreWhat = (v) => (RESTORE_WHAT.includes(v) ? v : null);

/** Audit lines: labels only, never a person ("AI & Machine Learning × Healthcare & Life Sciences → Rising Innovator"). */
export const categoryChangeText = (a, b) => `${categoryShort(a)} → ${categoryShort(b)}`;
export const focusChangeText = (a, b) => `${focusLabel(a) || "none"} → ${focusLabel(b) || "none"}`;

const TEXT_FIELDS = {
  pillar: 120, sector: 120,
  nomineeName: 200, nomineeTitle: 200, nomineeOrganisation: 200, nomineeSector: 200, nomineeLocation: 200,
  nomineeWebsite: 500, nomineeLinkedIn: 500, nomineeEmail: 200, nomineePhone: 60,
  nominatorName: 200, nominatorTitle: 200, nominatorOrganisation: 200, nominatorRelationship: 200,
  nominatorEmail: 200, nominatorPhone: 60,
  statementOverview: 8000, statementImpact: 8000, statementAchievements: 8000, statementEvidence: 8000,
  signatureName: 200,
};
const line = (v, max) => String(v ?? "").replace(/[ \t]+/g, " ").trim().slice(0, max);

/** The website form body → the fields we store (trimmed, capped). */
export function nominationFromForm(body = {}) {
  const doc = {};
  for (const [k, max] of Object.entries(TEXT_FIELDS)) doc[k] = line(body[k], max);
  doc.nomineeEmail = doc.nomineeEmail.toLowerCase();
  doc.nominatorEmail = doc.nominatorEmail.toLowerCase();
  doc.categoryType = body.categoryType === "special" ? "special" : "matrix";
  doc.specialAward = SPECIAL_AWARDS[body.specialAward] ? body.specialAward : "";
  doc.nomineeType = ["Individual", "Organisation", "Team / Project"].includes(body.nomineeType) ? body.nomineeType : "Individual";
  doc.selfNomination = body.selfNomination === true || body.selfNomination === "true";
  for (const k of ["declaration1", "declaration2", "declaration3", "declaration4"]) doc[k] = !!body[k];
  return doc;
}

/** One row of Admin → Catalyst Awards → Nominations. */
export function nominationRow(n) {
  const changed = changedParts(n);
  return {
    id: String(n._id),
    category: categoryShort(n),
    categoryType: n.categoryType || "matrix",
    pillar: n.pillar || "",
    sector: n.sector || "",
    specialAward: n.specialAward || "",
    nomineeName: n.nomineeName || "",
    nomineeType: n.nomineeType || "",
    nomineeOrganisation: n.nomineeOrganisation || "",
    nominatorName: n.nominatorName || "",
    nominatorOrganisation: n.nominatorOrganisation || "",
    selfNomination: !!n.selfNomination,
    status: n.status || "pending",
    hasNotes: !!n.adminNotes,
    source: n.source || "website",
    submittedAt: n.submittedAt || n.createdAt || null,
    nomineeSector: n.nomineeSector || "",
    nomineePillar: n.nomineePillar || "",
    focus: focusLabel(n),
    // Staff changed the category / the nominee's focus (it differs from what was submitted).
    categoryChanged: changed.category,
    focusChanged: changed.focus,
  };
}

/** What was submitted, with its labels, for the admin panel (null while nothing has been changed). */
function submittedDto(n) {
  const sub = submittedOf(n);
  return sub ? { ...sub, category: categoryShort(sub), categoryLabel: categoryLabel(sub), focus: focusLabel(sub) } : null;
}

/**
 * Everything, for the detail drawer. `jury`: { assigned, scored } (allocations to jurors and assessments
 * saved for it), for the warning before a category change.
 */
export function nominationDetail(n, { jury } = {}) {
  const out = { ...nominationRow(n), categoryLabel: categoryLabel(n), adminNotes: n.adminNotes || "", updatedBy: n.updatedBy || "",
    statusChangedAt: n.statusChangedAt || null };
  for (const k of Object.keys(TEXT_FIELDS)) out[k] = n[k] || "";
  Object.assign(out, {
    submitted: submittedDto(n),
    categoryChangedBy: n.categoryChangedBy || "",
    categoryChangedAt: n.categoryChangedAt || null,
    categoryNote: n.categoryNote || "",
    focusChangedBy: n.focusChangedBy || "",
    focusChangedAt: n.focusChangedAt || null,
    focusNote: n.focusNote || "",
  });
  if (jury) out.jury = { assigned: Number(jury.assigned) || 0, scored: Number(jury.scored) || 0 };
  return out;
}

/** Staff edits: { status?, adminNotes? } → { ok, set } | { ok: false, error }. */
export function cleanNominationPatch(body = {}) {
  const set = {};
  if ("status" in body) {
    if (!NOMINATION_STATUSES.includes(body.status)) return { ok: false, error: `Status must be one of: ${NOMINATION_STATUSES.join(", ")}.` };
    set.status = body.status;
  }
  if ("adminNotes" in body) set.adminNotes = String(body.adminNotes ?? "").slice(0, 5000);
  return { ok: true, set };
}

/* ---------- CSV ---------- */

const cell = (v) => {
  const s = v instanceof Date ? v.toISOString() : String(v ?? "");
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? `'${s}` : s).replace(/"/g, '""')}"` : s;
};
const CSV_COLUMNS = [
  ["Submitted", (n) => n.submittedAt || n.createdAt], ["Status", (n) => n.status || "pending"], ["Category", categoryLabel],
  ["Submitted category", (n) => categoryLabel(submittedOf(n) || n)], ["Focus", focusLabel], ["Submitted focus", (n) => focusLabel(submittedOf(n) || n)],
  ["Nominee", (n) => n.nomineeName], ["Nominee type", (n) => n.nomineeType], ["Nominee title", (n) => n.nomineeTitle],
  ["Nominee organisation", (n) => n.nomineeOrganisation], ["Nominee location", (n) => n.nomineeLocation],
  ["Nominee email", (n) => n.nomineeEmail], ["Nominee phone", (n) => n.nomineePhone], ["Nominee website", (n) => n.nomineeWebsite],
  ["Nominee LinkedIn", (n) => n.nomineeLinkedIn], ["Self-nomination", (n) => (n.selfNomination ? "yes" : "no")],
  ["Nominator", (n) => n.nominatorName], ["Nominator title", (n) => n.nominatorTitle], ["Nominator organisation", (n) => n.nominatorOrganisation],
  ["Relationship", (n) => n.nominatorRelationship], ["Nominator email", (n) => n.nominatorEmail], ["Nominator phone", (n) => n.nominatorPhone],
  ["Overview", (n) => n.statementOverview], ["Innovation & impact", (n) => n.statementImpact], ["Key achievements", (n) => n.statementAchievements],
  ["Supporting evidence", (n) => n.statementEvidence], ["Signed by", (n) => n.signatureName], ["Notes", (n) => n.adminNotes],
  ["Source", (n) => n.source || "website"],
];
export function nominationsCsv(docs = []) {
  return [CSV_COLUMNS.map(([h]) => cell(h)).join(","), ...docs.map((n) => CSV_COLUMNS.map(([, f]) => cell(f(n))).join(","))].join("\r\n");
}

/* ---------- recovering emailed nominations ---------- */

export const NOMINATION_SUBJECT = "[Catalyst Nomination]";
export const isNominationEmail = (e) => String(e?.subject || "").startsWith(NOMINATION_SUBJECT);

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", times: "×" };
function htmlText(s) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e) => {
      if (e[0] === "#") return String.fromCodePoint(e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .split("\n").map((l) => l.replace(/[ \t]+/g, " ").trim()).join("\n").trim();
}

/** The label/value rows of the table after a section heading ("Nominee", "Nominator"). */
function sectionRows(html, heading) {
  const start = html.search(new RegExp(`>\\s*${heading}\\b`));
  if (start < 0) return { name: "", rows: {}, head: "" };
  const rest = html.slice(start);
  const end = rest.indexOf("</table>");
  const block = end >= 0 ? rest.slice(0, end) : rest;
  const head = htmlText(block.slice(0, block.indexOf("</p>") + 4));
  const name = htmlText((block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/) || [])[1]);
  const rows = {};
  for (const m of block.matchAll(/<tr>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g)) rows[htmlText(m[1])] = htmlText(m[2]);
  return { name, rows, head };
}

/** The statement paragraph under a heading ("Overview", "Innovation & Impact", ...). */
function statement(html, heading) {
  const esc = heading.replace(/&/g, "&(?:amp;)?").replace(/ /g, "\\s+");
  const m = html.match(new RegExp(`<p[^>]*>\\s*${esc}\\s*</p>\\s*<p[^>]*>([\\s\\S]*?)</p>`));
  return m ? htmlText(m[1]) : "";
}

/**
 * A "[Catalyst Nomination]" admin email (routes/nominations.js buildAdminEmail) → the nomination
 * fields, or null when it doesn't look like one. `email`: Resend's { id, html, created_at, reply_to }.
 */
export function parseNominationEmail(email = {}) {
  const html = String(email.html || "");
  if (!html.includes("The Catalyst Awards")) return null;
  const cat = htmlText((html.match(/<h2[^>]*>([\s\S]*?)<\/h2>/) || [])[1]);
  const doc = { categoryType: "special", pillar: "", sector: "", specialAward: "" };
  const matrix = cat.match(/^The Catalyst Award for (.+) in (.+)$/);
  if (matrix) Object.assign(doc, { categoryType: "matrix", pillar: matrix[1].trim(), sector: matrix[2].trim() });
  else doc.specialAward = Object.keys(SPECIAL_AWARDS).find((k) => SPECIAL_AWARDS[k] === cat) || "";
  const nominee = sectionRows(html, "Nominee");
  const nominator = sectionRows(html, "Nominator");
  if (!nominee.name) return null;
  const replyTo = [].concat(email.reply_to || [])[0] || "";
  Object.assign(doc, {
    nomineeName: nominee.name,
    nomineeTitle: nominee.rows.Title || "",
    nomineeOrganisation: nominee.rows.Organisation || "",
    nomineeType: ["Individual", "Organisation", "Team / Project"].includes(nominee.rows.Type) ? nominee.rows.Type : "Individual",
    nomineeLocation: nominee.rows.Location || "",
    nomineeSector: nominee.rows.Sector || "",
    nomineeEmail: (nominee.rows.Email || "").toLowerCase(),
    nomineePhone: nominee.rows.Phone || "",
    nomineeWebsite: nominee.rows.Website || "",
    nomineeLinkedIn: nominee.rows.LinkedIn || "",
    selfNomination: /Self-nomination/i.test(nominator.head),
    nominatorName: nominator.name,
    nominatorTitle: nominator.rows.Title || "",
    nominatorOrganisation: nominator.rows.Organisation || "",
    nominatorRelationship: nominator.rows.Relationship || "",
    nominatorEmail: (nominator.rows.Email || String(replyTo).replace(/^.*<|>.*$/g, "")).toLowerCase(),
    nominatorPhone: nominator.rows.Phone || "",
    statementOverview: statement(html, "Overview"),
    statementImpact: statement(html, "Innovation & Impact"),
    statementAchievements: statement(html, "Key Achievements"),
    statementEvidence: statement(html, "Supporting Evidence"),
    signatureName: htmlText((html.match(/Signed by\s*<strong>([\s\S]*?)<\/strong>/) || [])[1]),
    source: "email",
    resendId: String(email.id || ""),
    submittedAt: email.created_at ? new Date(email.created_at) : new Date(),
  });
  return doc;
}
