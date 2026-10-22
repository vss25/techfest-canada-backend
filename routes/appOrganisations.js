import express from "express";
import { requireAdmin } from "../middleware/adminAuth.js";
import { AdminAudit } from "../models/Admin.js";
import OrgSetting from "../models/OrgSetting.js";
import { companyKey, cleanCompanyName } from "../services/companies.js";
import {
  organisations, organisationsPayload, forgetOrganisations, resolveKey, BUILTIN_ALIASES,
} from "../services/organisations.js";

/* =========================================================
   The organisations list (Oct 21 2026, services/organisations.js)

   /api/app/organisations (no sign-in)
     GET /organisations   { updatedAt, featured: [Org], attending: [Org] }
                          Org = { key, name, logo (https URL | ""), logoSource: "website"|"company"|"auto"|"",
                                  website, kind (the CMS category key | ""), topics: [full names],
                                  description, scale (CMS logoScale %, 100 default),
                                  attendeeCount, speakerCount, aliases: [other keys merged in] }
                          Cache-Control public, 120 s; rebuilt at most once a minute.

   /api/console/organisations (staff: Admin › Attending organisations)
     GET  /               ?fresh=1 rebuilds now.
                          { updatedAt, cmsOk, orgs: [Row], aliases: [Alias] }
                          Row = Org + { section: "featured"|"attending", hidden, hiddenBy:
                                "staff"|"partner"|"", partnerId, mergedKeys: [keys counted as this one],
                                company: { name, logoUrl, logoSource, updatedBy } | null,
                                autoLogo: { checkedAt, domain, result } | null, autoDomain }
                          Alias = { from, into, builtin, off, by, at }
     POST /hide           { key, hidden: true|false }   left out of the apps' list, or back
     POST /alias          { from, into }                 "merge X into Y" (names or keys)
     DELETE /alias/:from                                 undo a merge (a built-in one is switched off)
     POST /lookup         { key }                        search for a logo again at the next build
     Logos: the existing GET /api/console/companies/candidates?name=&domain= and
     POST /api/console/companies/logo { name, … } (logoSource "company"); a partner's
     logo is edited on the partner (it's the website's). Every change is audited and
     reaches the apps within a minute.
========================================================= */

export const appOrganisationsRouter = express.Router();

appOrganisationsRouter.get("/organisations", async (req, res) => {
  try {
    const body = await organisationsPayload();
    res.set("Cache-Control", "public, max-age=120");
    res.json(body);
  } catch (err) {
    console.error("ORGANISATIONS ERROR:", err?.message || err);
    res.status(503).json({ error: "The organisations list isn't available right now." });
  }
});

export const consoleOrganisationsRouter = express.Router();
consoleOrganisationsRouter.use(requireAdmin);

const wrap = (fn) => (req, res) => fn(req, res).catch((err) => {
  console.error("ORGANISATIONS ADMIN ERROR:", err?.message || err);
  res.status(500).json({ error: "Something went wrong. Try again." });
});
const staffBy = (req) => ({ updatedBy: String(req.user.name || "").slice(0, 120), updatedById: String(req.user._id) });
async function audit(req, action, key, detail) {
  await AdminAudit.create({ adminId: req.user._id, adminName: req.user.name, action, targetType: "organisation",
                            targetId: String(key).slice(0, 120), detail: String(detail).slice(0, 500) }).catch(() => {});
}
/** A key or a name from the panel → its key ("" when there's nothing). */
const keyOf = (v) => companyKey(cleanCompanyName(v));

consoleOrganisationsRouter.get("/", wrap(async (req, res) => {
  const [v, settings] = await Promise.all([organisations({ fresh: req.query.fresh === "1" }), OrgSetting.find({}).lean()]);
  const mine = new Map(settings.map((s) => [s.key, s]));
  const aliases = [];
  for (const [from, into] of Object.entries(BUILTIN_ALIASES)) {
    const s = mine.get(from);
    if (!s?.aliasOf) aliases.push({ from, into, builtin: true, off: !!s?.aliasOff, by: s?.aliasOff ? s.updatedBy || "" : "", at: s?.aliasOff ? s.updatedAt : null });
  }
  for (const s of settings) if (s.aliasOf) aliases.push({ from: s.key, into: s.aliasOf, builtin: false, off: false, by: s.updatedBy || "", at: s.updatedAt || null });
  res.json({ updatedAt: v.updatedAt, cmsOk: v.cmsOk, orgs: v.rows, aliases });
}));

consoleOrganisationsRouter.post("/hide", wrap(async (req, res) => {
  const key = keyOf(req.body?.key);
  const hidden = req.body?.hidden;
  if (!key) return res.status(400).json({ error: "Which organisation?", field: "key" });
  if (typeof hidden !== "boolean") return res.status(400).json({ error: "hidden must be true or false", field: "hidden" });
  const name = cleanCompanyName(req.body?.name || "");
  await OrgSetting.updateOne({ key }, { $set: { hidden, ...(name ? { name } : {}), ...staffBy(req) } }, { upsert: true });
  await audit(req, hidden ? "org_hide" : "org_unhide", key, `${name || key}: ${hidden ? "hidden from" : "shown in"} the apps' organisations`);
  forgetOrganisations();
  res.json({ ok: true, key, hidden });
}));

consoleOrganisationsRouter.post("/alias", wrap(async (req, res) => {
  const from = keyOf(req.body?.from);
  const intoRaw = keyOf(req.body?.into);
  if (!from) return res.status(400).json({ error: "Which organisation should be merged?", field: "from" });
  if (!intoRaw) return res.status(400).json({ error: "Which organisation should it be merged into?", field: "into" });
  // Where "into" ends up without this organisation's own merge: back at it would be a loop.
  const { aliases } = await organisations();
  const without = { ...aliases };
  delete without[from];
  const into = resolveKey(intoRaw, without);
  if (into === from) return res.status(400).json({ error: "That would merge an organisation into itself.", field: "into" });
  const name = cleanCompanyName(req.body?.from);
  await OrgSetting.updateOne({ key: from }, { $set: { aliasOf: into, aliasOff: false, name, ...staffBy(req) } }, { upsert: true });
  await audit(req, "org_alias", from, `${name || from} merged into ${cleanCompanyName(req.body?.into) || into}`);
  forgetOrganisations();
  res.json({ ok: true, from, into });
}));

consoleOrganisationsRouter.delete("/alias/:from", wrap(async (req, res) => {
  const from = keyOf(req.params.from);
  if (!from) return res.status(400).json({ error: "Which merge?", field: "from" });
  const builtin = Object.prototype.hasOwnProperty.call(BUILTIN_ALIASES, from);
  const s = await OrgSetting.findOne({ key: from }).lean();
  if (!s?.aliasOf && !builtin) {
    const { aliases } = await organisations();
    if (!aliases[from]) return res.status(404).json({ error: "That organisation isn't merged into another." });
  }
  // aliasOff also switches off a built-in merge or a partner's short name.
  await OrgSetting.updateOne({ key: from }, { $set: { aliasOf: "", aliasOff: true, ...staffBy(req) } }, { upsert: true });
  await audit(req, "org_alias_remove", from, `${from}: no longer merged`);
  forgetOrganisations();
  res.json({ ok: true, from });
}));

consoleOrganisationsRouter.post("/lookup", wrap(async (req, res) => {
  const key = keyOf(req.body?.key);
  if (!key) return res.status(400).json({ error: "Which organisation?", field: "key" });
  await OrgSetting.updateOne({ key }, { $unset: { logoCheckedAt: 1, logoCheckDomain: 1, logoCheckResult: 1 } });
  await audit(req, "org_logo_lookup", key, `${key}: automatic logo search again`);
  forgetOrganisations();
  res.json({ ok: true, key });
}));
