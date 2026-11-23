/* MOU drafts (Nov 23 2026): the pure rules in services/mou.js and the Word file writer. */
import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import {
  STARTER_ITEMS, cleanItem, cleanSchedule, scheduleText, fillWording, lineFrom, lineText, cleanTerms, cleanSigners,
  reviewChecks, mouNumber, mouDocument, exportName,
} from "../services/mou.js";
import { mouDocx, mouDocumentXml, zip } from "../services/mouExport.js";

test("every starter item cleans, has wording and no em-dash", () => {
  for (const s of STARTER_ITEMS) {
    const { value, error } = cleanItem(s);
    assert.equal(error, undefined, s.name);
    assert.ok(value.wording.includes(s.side === "ttfc" ? "TTFC" : "{partner}"), s.name);
    assert.doesNotMatch(value.wording, /[—–]/);
  }
});

test("cleanItem refuses a missing side or name and a bad number, and drops unknown fields", () => {
  assert.ok(cleanItem({ name: "x" }).error);
  assert.ok(cleanItem({ side: "ttfc" }).error);
  assert.ok(cleanItem({ side: "ttfc", name: "x", qty: 1.5 }).error);
  const { value } = cleanItem({ side: "partner", name: "Podcast mention", fields: ["qty", "bogus"], wording: "A — B", code: "ab12" });
  assert.deepEqual(value.fields, ["qty"]);
  assert.equal(value.wording, "A, B");
  assert.equal(value.code, "AB12");
  assert.equal(value.category, "other");
});

test("schedules in words", () => {
  assert.equal(scheduleText({ mode: "dates", dates: ["2027-01-20", "2027-01-05", "bad"] }), " on January 5, 2027 and January 20, 2027");
  assert.equal(scheduleText({ mode: "repeat", every: "2weeks", from: "2027-01-05", to: "2027-02-02" }), " every 2 weeks from January 5, 2027 to February 2, 2027");
  assert.equal(scheduleText({ mode: "repeat" }), " every month");
  assert.equal(scheduleText({ mode: "note", note: "in the week before the event" }), " in the week before the event");
  assert.equal(scheduleText({ mode: "none", dates: ["2027-01-05"] }), "");
  assert.deepEqual(cleanSchedule({ mode: "weird" }).mode, "none");
});

test("wording placeholders: plurals, codes, schedule, no double spaces", () => {
  const w = "TTFC will feature {partner} in {qty} LinkedIn post{s}{when}.";
  assert.equal(fillWording(w, { partner: "Acme", qty: 1 }), "TTFC will feature Acme in 1 LinkedIn post.");
  assert.equal(fillWording(w, { partner: "Acme", qty: 3, schedule: { mode: "dates", dates: ["2027-01-05"] } }),
    "TTFC will feature Acme in 3 LinkedIn posts on January 5, 2027.");
  assert.equal(fillWording("give {qty} pass{es}, code {code}", { qty: 2 }), "give 2 passes, code [code to be set]");
  assert.equal(fillWording("stor{ies}", { qty: 1 }), "story");
});

test("a line takes the catalogue defaults, keeps its own wording and only TTFC lines unlock with ticket sales", () => {
  const item = { _id: "i1", side: "ttfc", name: "Free passes", category: "passes", fields: ["qty", "value", "code"], wording: "TTFC will give {partner} {qty} free pass{es} ({value}).", qty: 2, value: "Connect Pass" };
  const { value } = lineFrom({ itemId: "i1", unlockAt: 50 }, item);
  assert.equal(value.qty, 2);
  assert.equal(value.value, "Connect Pass");
  assert.equal(value.unlockAt, 50);
  assert.equal(lineText(value, { partner: "Acme" }), "Once ticket sales with Acme's code reach 50: TTFC will give Acme 2 free passes (Connect Pass).");
  const own = lineFrom({ itemId: "i1", qty: "4", wording: "Four passes for Acme's board." }, item).value;
  assert.equal(lineText(own, { partner: "Acme" }), "Four passes for Acme's board.");
  assert.equal(lineFrom({ itemId: "p", unlockAt: 5 }, { ...item, side: "partner" }).value.unlockAt, null);
  assert.ok(lineFrom({ qty: -1 }, item).error);
  assert.ok(lineFrom({}, null).error);
});

test("terms: defaults non-binding and non-financial, money in cents, every clause listed", () => {
  const t = cleanTerms({});
  assert.equal(t.binding, false);
  assert.equal(t.financial, false);
  assert.equal(t.amount, null);
  assert.ok(t.clauses.length >= 5 && t.clauses.every((c) => c.on));
  const f = cleanTerms({ financial: true, amount: "2,500", clauses: [{ key: "exclusivity", on: false }], startDate: "2027-13-01" });
  assert.equal(f.amount, 250000);
  assert.equal(f.clauses.find((c) => c.key === "exclusivity").on, false);
  assert.equal(f.startDate, "");
  assert.equal(cleanTerms({ financial: false, amount: "100" }).amount, null);
});

test("partner signers: at most three, blanks dropped", () => {
  assert.equal(cleanSigners([{ name: "A" }, {}, { name: "B" }, { name: "C" }, { name: "D" }]).length, 2);
});

test("review checks block what's missing and warn about the rest", () => {
  const sig = [{ id: "s1", name: "Dana Director" }];
  const empty = reviewChecks({ partner: {}, lines: [] }, { signatories: sig });
  assert.equal(empty.filter((c) => c.level === "block").length, 4);
  const ok = reviewChecks({
    partner: { name: "Acme" }, ttfcSignatoryIds: ["s1"], partnerSigners: [{ name: "Pat" }],
    lines: [{ side: "partner", name: "Ticket sales target", fields: ["qty", "code"], qty: 25, code: "" }],
    terms: { financial: true, amount: null },
  }, { signatories: sig });
  assert.equal(ok.filter((c) => c.level === "block").length, 0);
  assert.ok(ok.some((c) => /no code/.test(c.text)));
  assert.ok(ok.some((c) => /TTFC offers nothing/.test(c.text)));
  assert.ok(ok.some((c) => /no amount/.test(c.text)));
});

const sample = () => ({
  number: mouNumber("2027", 3), eventName: "Vancouver Briefing", status: "draft",
  partner: { name: "Acme Tech Network", website: "acme.example.com" }, contact: { name: "Pat Lee", title: "Director" },
  terms: cleanTerms({ financial: false, clauses: [{ key: "law", on: false }] }),
  partnerSigners: [{ name: "Pat Lee", title: "Director" }],
  lines: [
    { side: "ttfc", name: "LinkedIn", baseWording: "TTFC will feature {partner} in {qty} LinkedIn post{s}{when}.", qty: 2, fields: ["qty"], schedule: { mode: "none" } },
    { side: "ttfc", name: "Free passes", baseWording: "TTFC will give {partner} {qty} free pass{es}.", qty: 2, fields: ["qty"], unlockAt: 25, schedule: {} },
    { side: "partner", name: "Newsletter", baseWording: "{partner} will feature {event} in {qty} email newsletter{s}{when}.", qty: 1, fields: ["qty"], schedule: { mode: "note", note: "in January" } },
  ],
});

test("the document: sections in order, milestones apart, non-binding wording, signatures only when final", () => {
  const issuer = { company: { legalName: "The Tech Festival Canada" }, signatories: [{ name: "Dana Director", title: "Director", signature: "data:image/png;base64,AAAA" }] };
  const d = mouDocument(sample(), issuer);
  assert.equal(d.number, "MOU-2027-0003");
  assert.equal(d.banner, "DRAFT");
  const titles = d.sections.map((s) => s.title);
  assert.deepEqual(titles, ["PURPOSE", "WHAT TTFC WILL DO", "WHAT ACME TECH NETWORK WILL DO", "TICKET SALES MILESTONES", "FINANCIAL TERMS", "GENERAL"]);
  assert.match(d.sections[0].paras[1].text, /not legally binding/);
  assert.match(d.sections[2].paras[0].text, /Acme Tech Network will feature Vancouver Briefing in 1 email newsletter in January\./);
  assert.match(d.sections[3].paras[1].text, /reach 25/);
  assert.match(d.sections[4].paras[0].text, /No money changes hands/);
  assert.ok(!d.sections[5].paras.some((p) => /Ontario/.test(p.text)), "the switched-off clause is left out");
  assert.ok(!d.sections[5].paras.some((p) => /pays its own costs of doing/.test(p.text)), "costs already said");
  assert.equal(d.signers.length, 2);
  assert.equal(d.signers[1].signature, null);
  assert.equal(mouDocument({ ...sample(), status: "exported" }, issuer, { final: true }).signers[1].signature, "data:image/png;base64,AAAA");
  for (const s of d.sections) for (const p of s.paras) assert.doesNotMatch(p.text, /[—–]/);
});

test("financial terms say who pays whom", () => {
  const d = mouDocument({ ...sample(), terms: cleanTerms({ financial: true, amount: 1500, payer: "partner", paymentNote: "On signing." }) }, {});
  const fin = d.sections.find((s) => s.title === "FINANCIAL TERMS");
  assert.equal(fin.paras[0].text, "Acme Tech Network will pay TTFC $1,500.00 (CAD, plus any applicable tax).");
  assert.equal(fin.paras[1].text, "On signing.");
});

test("the Word file is a real zip with the three parts, escaped text and a signature table", () => {
  const d = mouDocument({ ...sample(), partner: { name: "A & B <Co>" } }, {});
  const xml = mouDocumentXml(d);
  assert.match(xml, /A &amp; B &lt;Co&gt;/);
  assert.match(xml, /<w:tbl>/);
  const buf = mouDocx(d);
  assert.equal(buf.readUInt32LE(0), 0x04034b50);
  const names = [];
  for (let i = 0; i < buf.length - 4; i++) {
    if (buf.readUInt32LE(i) === 0x02014b50) names.push(buf.subarray(i + 46, i + 46 + buf.readUInt16LE(i + 28)).toString());
  }
  assert.deepEqual(names, ["[Content_Types].xml", "_rels/.rels", "word/document.xml"]);
  // the stored data and its crc agree
  const z = zip({ "a.txt": "hello" });
  assert.equal(z.readUInt32LE(14), zlib.crc32(Buffer.from("hello")) >>> 0);
  assert.equal(z.subarray(30 + 5, 30 + 5 + 5).toString(), "hello");
});

test("file names", () => {
  assert.equal(exportName({ number: "MOU-2027-0003", partner: { name: "Acme & Co." } }, "pdf"), "MOU-2027-0003-Acme-Co.pdf");
});
