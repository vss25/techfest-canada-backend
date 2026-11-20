import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanStatus, fromExplee, hotLeadsEmail, hotLeadsUrl, isNewerReply, nextCursor } from "../services/explee.js";

test("the request: since as ISO, the project only when it's a number, never a key in the address", () => {
  const u = hotLeadsUrl({ since: "2026-11-20T10:00:00-05:00", projectId: "25641", offset: 100 });
  assert.ok(u.startsWith("https://api.explee.com/public/api/v1/autogtm/hot-leads?"));
  const q = new URL(u).searchParams;
  assert.equal(q.get("since"), "2026-11-20T15:00:00.000Z"); assert.equal(q.get("project_id"), "25641"); assert.equal(q.get("offset"), "100");
  assert.equal(new URL(hotLeadsUrl({ projectId: "1 or 1" })).searchParams.get("project_id"), null);
  assert.ok(!/key/i.test(u));
});

test("a hot lead becomes our fields; erased ones carry nothing personal; no id is skipped", () => {
  const l = fromExplee({ person_id: "p1", name: " Omar Haddad ", email: "Omar@Northern.example", job_title: "Lead", company_name: "Northern Compute",
    company_domain: "northern.example", linkedin_url: "linkedin.com/in/omar", country: "CA", phone: "+1 604", why_hot: "Yes, send details", became_hot_at: "2026-11-20T15:00:00Z", campaign_id: 7 });
  assert.deepEqual(l.contact, { leadName: "Omar Haddad", email: "omar@northern.example", jobTitle: "Lead", companyName: "Northern Compute",
    company_domain: "northern.example", website: "https://northern.example", linkedin: "https://linkedin.com/in/omar", country: "CA", phone: "+1 604" });
  assert.equal(l.hot.hotReply, "Yes, send details"); assert.equal(l.hot.expleeCampaignId, 7);
  assert.deepEqual(fromExplee({ person_id: "p2", erased: true, name: "X" }), { personId: "p2", erased: true });
  assert.equal(fromExplee({ name: "No id" }), null);
  assert.equal(fromExplee({ person_id: "p3" }).contact.leadName, "Hot lead");
});

test("a second reply is newer; the cursor only moves forward", () => {
  const inc = fromExplee({ person_id: "p1", became_hot_at: "2026-11-21T10:00:00Z" });
  assert.equal(isNewerReply({ becameHotAt: "2026-11-20T10:00:00Z" }, inc), true);
  assert.equal(isNewerReply({ becameHotAt: "2026-11-21T10:00:00Z" }, inc), false);
  assert.equal(nextCursor("2026-11-22T00:00:00Z", [{ became_hot_at: "2026-11-21T00:00:00Z" }]), "2026-11-22T00:00:00.000Z");
  assert.equal(nextCursor(null, [{ became_hot_at: "2026-11-21T00:00:00Z" }, { became_hot_at: "bad" }]), "2026-11-21T00:00:00.000Z");
  assert.equal(nextCursor(null, []), null);
});

test("statuses from the list only; the email escapes the reply", () => {
  assert.equal(cleanStatus("meeting"), "meeting"); assert.equal(cleanStatus("deleted"), null);
  const m = hotLeadsEmail([{ leadName: "Omar", companyName: "N<C>", hotReply: "<img onerror=x>" }], "https://x.test");
  assert.equal(m.subject, "Hot lead: Omar (N<C>)");
  assert.ok(m.html.includes("&lt;img onerror=x&gt;") && !m.html.includes("<img"));
});
