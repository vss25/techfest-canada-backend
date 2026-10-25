import test from "node:test";
import assert from "node:assert/strict";
import { appLogoUrl, vectorOrIconKind, CLOUDINARY_PNG, SANITY_PNG } from "../services/logoRaster.js";
import { appOrg, buildOrganisations } from "../services/organisations.js";

/* App logos as raster images (Oct 24 2026): the native apps can't draw SVG or ICO, so the apps' organisations list
   sends a PNG of an SVG / ICO logo that's on our Cloudinary or Sanity, and the stored URL as logoOriginal.
   Pure; the route is covered in organisations-awards-db. The URLs are shaped like production's, with made-up ids. */

const CLD = "https://res.cloudinary.com/pyizshnb/image/upload";
const SAN = "https://cdn.sanity.io/images/021qtoci/production";

test("the transformations: vectors drawn up to 512 px, icons never enlarged; Sanity asked for a PNG", () => {
  assert.equal(CLOUDINARY_PNG.svg, "f_png,w_512,h_512,c_fit");
  assert.equal(CLOUDINARY_PNG.ico, "f_png,w_512,h_512,c_limit");
  assert.deepEqual({ ...SANITY_PNG }, { fm: "png", w: "512", h: "512", fit: "clip" });
  assert.throws(() => { CLOUDINARY_PNG.svg = "x"; });
});

test("vectorOrIconKind: the path's extension, any case", () => {
  assert.equal(vectorOrIconKind("/a/b/logo.svg"), "svg");
  assert.equal(vectorOrIconKind("/a/b/logo.SVG"), "svg");
  assert.equal(vectorOrIconKind("/favicon.ico"), "ico");
  for (const p of ["/logo.png", "/logo.svgz", "/logo.svg/x", "/svg", "", undefined, null]) assert.equal(vectorOrIconKind(p), "", String(p));
});

test("Cloudinary SVG → a PNG of the same file, crisp at any size", () => {
  assert.equal(appLogoUrl(`${CLD}/v1792711171/ttfc/logos/speer-64ccf75870.svg`),
    `${CLD}/f_png,w_512,h_512,c_fit/v1792711171/ttfc/logos/speer-64ccf75870.png`);
  assert.equal(appLogoUrl(`${CLD}/v1792640172/ttfc/logos/university-of-waterloo-b181d659d7.SVG`),
    `${CLD}/f_png,w_512,h_512,c_fit/v1792640172/ttfc/logos/university-of-waterloo-b181d659d7.png`);
  // A query (a cache-buster) is kept; spaces around the URL dropped.
  assert.equal(appLogoUrl(`  ${CLD}/v1/ttfc/logos/a.svg?x=1 `), `${CLD}/f_png,w_512,h_512,c_fit/v1/ttfc/logos/a.png?x=1`);
  // An existing transformation stays after ours.
  assert.equal(appLogoUrl(`${CLD}/e_trim/v1/ttfc/logos/a.svg`), `${CLD}/f_png,w_512,h_512,c_fit/e_trim/v1/ttfc/logos/a.png`);
});

test("Cloudinary ICO → a PNG at its own size", () => {
  assert.equal(appLogoUrl(`${CLD}/v1792640035/ttfc/logos/deloitte-canada-334ae0b965.ico`),
    `${CLD}/f_png,w_512,h_512,c_limit/v1792640035/ttfc/logos/deloitte-canada-334ae0b965.png`);
});

test("Sanity SVG → the image pipeline's PNG (the apps use a link with a query as it is)", () => {
  assert.equal(appLogoUrl(`${SAN}/fd455447f53da971734602aeacb3edd7766d5fe2-246x44.svg`),
    `${SAN}/fd455447f53da971734602aeacb3edd7766d5fe2-246x44.svg?fm=png&w=512&h=512&fit=clip`);
  // Its own parameters are replaced, others kept.
  assert.equal(appLogoUrl(`${SAN}/abc-10x10.svg?h=160&fit=max&dl=1`), `${SAN}/abc-10x10.svg?h=512&fit=clip&dl=1&fm=png&w=512`);
});

test("everything else is unchanged", () => {
  for (const u of [
    `${CLD}/v1/ttfc/logos/a.png`, `${CLD}/v1/ttfc/logos/a.webp`, `${CLD}/v1/ttfc/logos/a.jpg`,
    `${SAN}/abc-860x860.png`, `${SAN}/abc-900x900.jpg`,
    `${CLD}/f_png,w_512,h_512,c_fit/v1/ttfc/logos/a.png`,                    // already converted
    "https://res.cloudinary.com/pyizshnb/image/fetch/https://example.com/a.svg", // not an upload
    "https://res.cloudinary.com/pyizshnb/raw/upload/v1/a.svg",
    "https://cdn.sanity.io/files/021qtoci/production/abc.svg",                  // Sanity files: no image pipeline
    "https://cdn.sanity.io/images/021qtoci/production/abc.ico",                 // the pipeline doesn't read ICO
    "https://example.com/logo.svg", "https://upload.wikimedia.org/a/b/Logo.svg", // other hosts
    "https://api.example.test/api/files/company-logo/65f0c0ffee0123456789abcd",  // kept in our database
    "http://res.cloudinary.com/pyizshnb/image/upload/v1/a.svg",                  // not https: as stored
    "not a url",
  ]) assert.equal(appLogoUrl(u), u, u);
  assert.equal(appLogoUrl(""), "");
  assert.equal(appLogoUrl("   "), "");
  for (const v of [undefined, null, 42, {}, []]) assert.equal(appLogoUrl(v), "", String(v));
});

test("appOrg: logo drawable by the apps, logoOriginal right after it, every other field as built", () => {
  const svg = `${CLD}/v1/ttfc/logos/acme-1.svg`;
  const o = { key: "acme", name: "Acme", logo: svg, logoSource: "company", website: "", kind: "", topics: [], description: "",
              scale: 100, attendeeCount: 2, speakerCount: 0, aliases: [] };
  const a = appOrg(o);
  assert.deepEqual(Object.keys(a), ["key", "name", "logo", "logoOriginal", "logoSource", "website", "kind", "topics", "description",
    "scale", "attendeeCount", "speakerCount", "aliases"]);
  assert.equal(a.logo, `${CLD}/f_png,w_512,h_512,c_fit/v1/ttfc/logos/acme-1.png`);
  assert.equal(a.logoOriginal, svg);
  assert.equal(o.logo, svg);                                     // the built list isn't touched
  assert.equal(o.logoOriginal, undefined);
  const none = appOrg({ ...o, logo: "" });
  assert.deepEqual([none.logo, none.logoOriginal], ["", ""]);
  const png = appOrg({ ...o, logo: `${SAN}/acme-10x10.png` });
  assert.deepEqual([png.logo, png.logoOriginal], [`${SAN}/acme-10x10.png`, `${SAN}/acme-10x10.png`]);
});

test("a built list → the apps' entries: SVG / ICO converted, PNG as is, the admin rows keep the stored URL", () => {
  const svg = `${SAN}/acme-246x44.svg`;
  const ico = `${CLD}/v1/ttfc/logos/globex-1.ico`;
  const built = buildOrganisations({
    partners: [{ _id: "p-acme", name: "Acme", category: "corporateEnterprisePartners", order: 1, logo: svg }],
    companies: [
      { nameKey: "globex", name: "Globex", logoUrl: ico, logoSource: "upload", updatedBy: "Staff" },
      { nameKey: "initech", name: "Initech", logoUrl: `${CLD}/v1/ttfc/logos/initech-1.png`, logoSource: "auto", updatedBy: "Automatic" },
    ],
    people: [
      { id: "u1", name: "Person One", org: "Globex", domain: "" },
      { id: "u2", name: "Person Two", org: "Initech", domain: "" },
      { id: "u3", name: "Person Three", org: "Acme", domain: "" },
    ],
  });
  const all = [...built.featured, ...built.attending].map(appOrg);
  const by = (k) => all.find((x) => x.key === k);
  assert.equal(by("acme").logo, `${svg}?fm=png&w=512&h=512&fit=clip`);
  assert.equal(by("acme").logoOriginal, svg);
  assert.equal(by("globex").logo, `${CLD}/f_png,w_512,h_512,c_limit/v1/ttfc/logos/globex-1.png`);
  assert.equal(by("globex").logoOriginal, ico);
  assert.equal(by("initech").logo, `${CLD}/v1/ttfc/logos/initech-1.png`);
  // The admin panel's rows are the stored URLs.
  assert.equal(built.rows.find((r) => r.key === "globex").logo, ico);
  assert.equal(built.rows.find((r) => r.key === "acme").logo, svg);
});
