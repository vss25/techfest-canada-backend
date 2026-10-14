import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MANUAL, buildExhibitorManual, cleanBooth, cleanManual, manualFileName } from "../services/exhibitorManual.js";
import { EXHIBITOR_PROMO, defaultExhibitorCopy, exhibitorBooth, exhibitorCopyFor } from "../services/exhibitorPasses.js";
import { issuedPassDoc, issuedPassRow, issuedPassUpdate, issuedVariant, validateIssuedPass } from "../services/issuedPasses.js";

test("cleanManual: defaults fill the gaps, staff text wins, unknown keys dropped", () => {
  assert.deepEqual(cleanManual(undefined), cleanManual({}));
  assert.equal(cleanManual({}).header.dates, DEFAULT_MANUAL.header.dates);
  const m = cleanManual({ header: { dates: "  27-28 Oct  " }, junk: 1, rules: { items: [["Badges", "New rule"], ["Only two"]] } });
  assert.equal(m.header.dates, "27-28 Oct");
  assert.equal(m.header.venue, DEFAULT_MANUAL.header.venue);
  assert.equal("junk" in m, false);
  assert.deepEqual(m.rules.items, [["Badges", "New rule"], ["Only two"]]);
  assert.equal(cleanManual({ header: { dates: 5 } }).header.dates, DEFAULT_MANUAL.header.dates);
  assert.equal(cleanManual({ allocation: { note: "x".repeat(5000) } }).allocation.note.length, 1200);
  assert.equal(cleanManual({ returnForm: { badges: { rows: 99 } } }).returnForm.badges.rows, 12);
  assert.equal(cleanManual({ runOfShow: { days: [{ title: "Day", rows: [["9 am", "Doors"]] }] } }).runOfShow.days[0].rows[0][1], "Doors");
});

test("cleanBooth and the attachment's file name", () => {
  const b = cleanBooth({ company: " Acme  Inc. ", booth: "07", holder: { name: "Jane Doe" } });
  assert.equal(b.company, "Acme Inc.");
  assert.equal(b.zone, "");
  assert.equal(b.holder.name, "Jane Doe");
  assert.equal(manualFileName("Acme Robotics Inc."), "TTFC_2026_Exhibitor_Manual_Acme_Robotics_Inc.pdf");
  assert.equal(manualFileName(""), "TTFC_2026_Exhibitor_Manual.pdf");
});

test("buildExhibitorManual: a 4-page PDF with the return form fields and the booth filled in", async () => {
  const buf = await buildExhibitorManual(DEFAULT_MANUAL, { company: "Acme Robotics", booth: "07", zone: "Zone A", passes: "4", holder: { name: "Jane Doe", email: "jane@acme.com" } });
  const pdf = buf.toString("latin1");
  assert.ok(pdf.startsWith("%PDF-"));
  assert.equal((pdf.match(/\/Type \/Page\b/g) || []).length, 4);
  for (const f of ["b1_name", "b4_mobile", "fascia_text", "extra_notes", "access"]) assert.ok(pdf.includes(`(${f})`), f);
  assert.ok(!pdf.includes("(alloc_company)"), "a filled allocation is printed, not a field");
  const blank = (await buildExhibitorManual()).toString("latin1");
  assert.ok(blank.includes("(alloc_company)"), "an empty allocation stays fillable");
});

test("exhibitor passes: EXHIBITOR promo, booth details, the manual line in the email", () => {
  const v = validateIssuedPass({ name: "Jane Doe", email: "jane@acme.com", tier: "connect", company: "Acme", label: "Exhibitor Pass", booth: "07", zone: "Zone A" }).value;
  assert.deepEqual(v.booth, { booth: "07", zone: "Zone A" });
  const d = issuedPassDoc(v, { ticketId: "abcabcabcabc", promo: EXHIBITOR_PROMO });
  assert.equal(d.promoCode, "EXHIBITOR");
  assert.deepEqual(d.issuedPass.booth, { booth: "07", zone: "Zone A", passes: "" });
  assert.deepEqual(issuedPassUpdate({ booth: { passes: "4" } }, d)["issuedPass.booth"], { booth: "07", zone: "Zone A", passes: "4" });
  assert.equal(issuedPassRow({ _id: "1", ...d }).booth.booth, "07");
  const booth = exhibitorBooth(d);
  assert.deepEqual([booth.company, booth.booth, booth.holder.name, booth.holder.email], ["Acme", "07", "Jane Doe", "jane@acme.com"]);
  assert.match(defaultExhibitorCopy().message, /Exhibitor Manual is attached/);
  const variant = issuedVariant(d, { copyFor: exhibitorCopyFor({ subject: "{firstName}, your booth pack", headline: "" }) });
  assert.equal(variant.subject, "{firstName}, your booth pack");
  assert.equal(variant.headline, defaultExhibitorCopy().headline);
  assert.equal(variant.label, "Exhibitor Pass");
});
