/* Explee hot leads → the admin panel (Nov 20 2026). Explee finds B2B leads, emails them and marks
   the ones who reply with real interest as "hot leads"; every 10 minutes one server fetches the
   new ones and puts each in Sales › Hot leads, with a task so someone replies. Pure parts here;
   routes/explee.js runs it. The key is EXPLEE_API_KEY on the server (never in code);
   EXPLEE_PROJECT_ID (optional) limits it to one Explee project. Private: MongoDB only.

   API (https://api.explee.com/public/api/llms.txt): GET /public/api/v1/autogtm/hot-leads
   ?since=<ISO>&limit=&offset=[&project_id=] with X-API-Key → { leads, has_more, next_offset }.
   A lead who replies again comes back with a newer became_hot_at: matched on person_id. */

export const EXPLEE_BASE = "https://api.explee.com";
export const LEAD_STATUSES = [
  { key: "new", label: "New: nobody has replied yet" },
  { key: "contacted", label: "We replied" },
  { key: "meeting", label: "Meeting booked" },
  { key: "won", label: "Won" },
  { key: "lost", label: "Not going ahead" },
];
const STATUS_KEYS = LEAD_STATUSES.map((s) => s.key);
export const cleanStatus = (v) => (STATUS_KEYS.includes(v) ? v : null);

const str = (v, max) => String(v ?? "").trim().slice(0, max);
const date = (v) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d : null; };
const httpUrl = (v) => { const u = str(v, 300); return /^https?:\/\//i.test(u) ? u : u ? `https://${u.replace(/^\/+/, "")}` : ""; };

export function hotLeadsUrl({ since, offset = 0, limit = 100, projectId = "" } = {}) {
  const q = new URLSearchParams({ limit: String(limit), offset: String(offset), source: "agent" });
  if (since) q.set("since", new Date(since).toISOString());
  if (/^\d+$/.test(String(projectId))) q.set("project_id", String(projectId));
  return `${EXPLEE_BASE}/public/api/v1/autogtm/hot-leads?${q}`;
}

/** One Explee hot lead → our fields, or null when it can't be used (no id). `erased` = they asked to be removed. */
export function fromExplee(h) {
  const personId = str(h?.person_id, 120);
  if (!personId) return null;
  if (h.erased) return { personId, erased: true };
  const name = str(h.name, 160) || str(h.email, 160) || "Hot lead";
  return {
    personId, erased: false,
    contact: {
      leadName: name, email: str(h.email, 200).toLowerCase(), jobTitle: str(h.job_title, 200), companyName: str(h.company_name, 200),
      company_domain: str(h.company_domain, 200), website: h.company_domain ? httpUrl(h.company_domain) : "",
      linkedin: h.linkedin_url ? httpUrl(h.linkedin_url) : "", country: str(h.country, 60), phone: str(h.phone, 40),
    },
    hot: { hotReply: str(h.why_hot, 4000), becameHotAt: date(h.became_hot_at), repliedAt: date(h.replied_at),
      expleeCampaignId: Number.isInteger(h.campaign_id) ? h.campaign_id : null },
  };
}

/** Whether an incoming lead is a new reply from someone we already have. */
export const isNewerReply = (existing, incoming) =>
  !!incoming.hot.becameHotAt && (!existing.becameHotAt || new Date(existing.becameHotAt) < incoming.hot.becameHotAt);

/** The newest became_hot_at seen, as the next `since` (never moving back). */
export function nextCursor(prev, leads) {
  let max = prev ? new Date(prev).getTime() : 0;
  for (const l of leads) { const t = date(l?.became_hot_at)?.getTime() || 0; if (t > max) max = t; }
  return max ? new Date(max).toISOString() : null;
}

export function leadDTO(l) {
  const iso = (d) => (d ? new Date(d).toISOString() : null);
  return {
    id: String(l._id), name: l.leadName, email: l.email || "", jobTitle: l.jobTitle || "", company: l.companyName || "",
    website: l.website || "", linkedin: l.linkedin || "", country: l.country || "", phone: l.phone || "",
    reply: l.hotReply || "", becameHotAt: iso(l.becameHotAt), repliedAt: iso(l.repliedAt),
    status: cleanStatus(l.status) || "new", ownerId: l.assignedTo || "", ownerName: l.assignedToName || "",
    notes: l.notes || "", hidden: !!l.hiddenFromStaff, replies: (l.contactLog || []).filter((c) => c.method === "Explee reply").length,
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
/** One email to the sales inbox for a sync that found new hot leads. */
export function hotLeadsEmail(leads, link) {
  const n = leads.length;
  const rows = leads.map((l) => `<p style="margin:14px 0 4px"><strong>${esc(l.leadName)}</strong>${l.jobTitle || l.companyName ? ` · ${esc([l.jobTitle, l.companyName].filter(Boolean).join(", "))}` : ""}</p>
<p style="margin:0;padding:8px 12px;background:#F6F5FA;border-radius:8px;white-space:pre-wrap">${esc(String(l.hotReply || "").slice(0, 600))}</p>`).join("");
  return {
    subject: n === 1 ? `Hot lead: ${leads[0].leadName}${leads[0].companyName ? ` (${leads[0].companyName})` : ""}`.slice(0, 150) : `${n} new hot leads from Explee`,
    html: `<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:22px;color:#151035;max-width:560px"><h2 style="font-size:18px;margin:0 0 4px">${n === 1 ? "A lead replied with interest" : `${n} leads replied with interest`}</h2>${rows}
<p style="margin:20px 0 0"><a href="${esc(link)}" style="display:inline-block;background:#D6308C;color:#fff;text-decoration:none;font-weight:bold;padding:10px 16px;border-radius:8px">Open Hot leads</a></p></div>`,
    text: leads.map((l) => `${l.leadName}${l.companyName ? ` (${l.companyName})` : ""}:\n${String(l.hotReply || "").slice(0, 600)}`).join("\n\n") + `\n\n${link}`,
  };
}
