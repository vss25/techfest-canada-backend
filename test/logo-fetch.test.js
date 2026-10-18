import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import {
  isPrivateAddress, checkUrl, makeGuardedLookup, safeFetch, sniffImage, icoLargestPng, checkImage, parseIconLinks,
  serviceCandidates, parseWikimedia, wikimediaSearchUrl, rankCandidates, findLogoCandidates, typeAllowed, MAX_BYTES,
} from "../services/logoFetch.js";
import { prepareLogo, chooseStore, storeLogo, logoSlug, decodeLogoDataUrl } from "../services/logoStore.js";

/* ---------- tiny images ---------- */
const png = (w, h) => {
  const b = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8); b.write("IHDR", 12, "latin1"); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const gif = Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([32, 0, 16, 0]), Buffer.alloc(8)]);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x40, 0x00, 0x80, 0x03, 0, 0, 0, 0, 0, 0]);
const svg = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 40"><rect/></svg>');
/** An .ico holding one PNG entry of w×h. */
const ico = (w, h, inner = png(w, h)) => {
  const head = Buffer.alloc(22);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(1, 4);
  head[6] = w >= 256 ? 0 : w; head[7] = h >= 256 ? 0 : h;
  head.writeUInt32LE(inner.length, 14); head.writeUInt32LE(22, 18);
  return Buffer.concat([head, inner]);
};

test("private, loopback, link-local and reserved addresses are refused, v4 and v6", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "224.0.0.1", "255.255.255.255", "198.18.0.1", "192.0.2.1", "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1",
    "::ffff:10.0.0.1", "::ffff:7f00:1", "64:ff9b::a00:1", "2002:a00:1::", "2001:db8::1", "ff02::1", "not-an-ip", ""]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "93.184.216.34", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:80b::200e", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("only public http(s) links on the default ports, without credentials", () => {
  assert.equal(checkUrl("https://acme.com/logo.png").ok, true);
  assert.equal(checkUrl("http://acme.com:80/x").ok, true);
  for (const bad of ["ftp://acme.com/x", "file:///etc/passwd", "javascript:alert(1)", "data:image/png;base64,AA==", "https://user:pw@acme.com/",
    "https://acme.com:8443/", "http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://169.254.169.254/latest/meta-data",
    "http://2130706433/", "http://0x7f.0.0.1/", "http://intranet/", "http://printer.local/", "http://db.internal/", "not a url"]) {
    assert.equal(checkUrl(bad).ok, false, bad);
  }
});

test("the DNS check runs on every address the host resolves to", async () => {
  const fake = (addresses) => (host, opts, cb) => cb(null, addresses);
  const run = (addresses, opts = {}) => new Promise((resolve) => makeGuardedLookup(fake(addresses))("logo.example.com", opts, (err, a, f) => resolve({ err, a, f })));
  const one = await run([{ address: "93.184.216.34", family: 4 }]);
  assert.deepEqual([one.err, one.a, one.f], [null, "93.184.216.34", 4]);
  const all = await run([{ address: "93.184.216.34", family: 4 }], { all: true });
  assert.deepEqual(all.a, [{ address: "93.184.216.34", family: 4 }]);
  const mixed = await run([{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]);
  assert.equal(mixed.err.code, "EBLOCKED");
  assert.equal((await run([{ address: "::1", family: 6 }])).err.code, "EBLOCKED");
  assert.equal((await run([])).err.code, "EBLOCKED");
  // Wired into the real connection: a host that resolves to loopback never gets a request.
  const toLoopback = makeGuardedLookup(fake([{ address: "127.0.0.1", family: 4 }]));
  await assert.rejects(safeFetch("http://rebind.ttfc-logos.com/x.png", { lookup: toLoopback }), (err) => err.code === "EBLOCKED");
});

/* ---------- safeFetch with a fake transport ---------- */
function transport(routes) {
  const calls = [];
  const mod = {
    request(url, opts) {
      const req = new EventEmitter();
      calls.push({ url: url.href, headers: opts.headers, lookup: opts.lookup });
      req.destroy = (err) => { req.destroyed = true; if (err) req.emit("error", err); };
      req.end = () => setImmediate(() => {
        const r = routes[url.href];
        if (!r) return req.emit("error", Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
        if (r.hang) return undefined;
        const body = Buffer.isBuffer(r.body) ? r.body : Buffer.from(r.body || "");
        const chunks = r.chunks ? Array.from({ length: r.chunks }, () => body) : [body];
        const res = Readable.from(chunks);
        res.statusCode = r.status || 200;
        res.headers = { ...(r.type ? { "content-type": r.type } : {}), ...(r.location ? { location: r.location } : {}), ...(r.length ? { "content-length": String(r.length) } : {}) };
        req.emit("response", res);
        return undefined;
      });
      return req;
    },
  };
  return { t: { "https:": mod, "http:": mod }, calls };
}

test("safeFetch: follows up to 3 redirects, each checked; only the asked-for type; no cookies sent", async () => {
  const { t, calls } = transport({
    "https://a.com/1": { status: 301, location: "/2" },
    "https://a.com/2": { status: 302, location: "https://b.com/3" },
    "https://b.com/3": { status: 307, location: "https://c.com/logo.png" },
    "https://c.com/logo.png": { type: "image/png", body: png(64, 64) },
    "https://a.com/4": { status: 301, location: "/1" },
    "https://a.com/inside": { status: 302, location: "http://169.254.169.254/latest" },
    "https://a.com/page": { type: "text/html; charset=utf-8", body: "<html></html>" },
    "https://a.com/fake.png": { type: "image/png", body: "<html>not really</html>" },
    "https://a.com/404": { status: 404, type: "text/html", body: "nope" },
  });
  const r = await safeFetch("https://a.com/1", { transport: t });
  assert.deepEqual([r.url, r.contentType, r.body.length], ["https://c.com/logo.png", "image/png", 33]);
  assert.ok(calls.every((c) => !("Cookie" in c.headers) && !("cookie" in c.headers) && !c.headers.Authorization));
  assert.equal(calls[0].headers["Accept-Encoding"], "identity");
  assert.equal(typeof calls[0].lookup, "function");
  await assert.rejects(safeFetch("https://a.com/4", { transport: t }), (e) => e.code === "EREDIRECTS");
  await assert.rejects(safeFetch("https://a.com/inside", { transport: t }), (e) => e.code === "EURL");
  await assert.rejects(safeFetch("https://a.com/page", { transport: t }), (e) => e.code === "ETYPE");
  assert.equal((await safeFetch("https://a.com/page", { kind: "html", transport: t })).contentType, "text/html");
  await assert.rejects(safeFetch("https://a.com/404", { kind: "html", transport: t }), (e) => e.code === "ESTATUS");
  // Labelled image/png but isn't one: the sniff catches it.
  const fake = await safeFetch("https://a.com/fake.png", { transport: t });
  assert.equal(checkImage(fake.body, fake.contentType), null);
  await assert.rejects(safeFetch("http://localhost/x", { transport: t }), (e) => e.code === "EURL");
});

test("safeFetch: 2 MB cap (declared or streamed) and a 5 s deadline for the whole chain", async () => {
  const big = Buffer.alloc(512 * 1024, 1);
  const { t } = transport({
    "https://a.com/declared": { type: "image/png", length: MAX_BYTES + 1, body: png(1, 1) },
    "https://a.com/stream": { type: "image/png", body: big, chunks: 5 },
    "https://a.com/slow": { hang: true },
  });
  await assert.rejects(safeFetch("https://a.com/declared", { transport: t }), (e) => e.code === "ETOOBIG");
  await assert.rejects(safeFetch("https://a.com/stream", { transport: t }), (e) => e.code === "ETOOBIG");
  const t0 = Date.now();
  await assert.rejects(safeFetch("https://a.com/slow", { transport: t, timeoutMs: 50 }), (e) => e.code === "ETIMEOUT");
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(typeAllowed("json", "application/json; charset=utf-8"), true);
  assert.equal(typeAllowed("image", "application/octet-stream"), false);
});

test("images are what their bytes say: PNG, JPEG, GIF, WebP, ICO, SVG (with sizes)", () => {
  assert.deepEqual(sniffImage(png(180, 180)), { type: "image/png", width: 180, height: 180 });
  assert.deepEqual(sniffImage(jpeg), { type: "image/jpeg", width: 128, height: 64 });
  assert.deepEqual(sniffImage(gif), { type: "image/gif", width: 32, height: 16 });
  assert.deepEqual(sniffImage(svg), { type: "image/svg+xml", width: 120, height: 40 });
  assert.deepEqual(sniffImage(ico(48, 48)), { type: "image/x-icon", width: 48, height: 48 });
  assert.deepEqual(sniffImage(ico(256, 256)), { type: "image/x-icon", width: 256, height: 256 });
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8X"), Buffer.alloc(8), Buffer.from([99, 0, 0, 49, 0, 0])]);
  assert.deepEqual(sniffImage(webp), { type: "image/webp", width: 100, height: 50 });
  for (const bad of [Buffer.from("<html><body>hi</body></html>"), Buffer.from("%PDF-1.4 ....."), Buffer.alloc(3), Buffer.from("<script>alert(1)</script>xx")]) {
    assert.equal(sniffImage(bad), null);
  }
  assert.deepEqual(sniffImage(icoLargestPng(ico(64, 64))), { type: "image/png", width: 64, height: 64 });
  assert.equal(icoLargestPng(png(1, 1)), null);
});

test("icon links from a page's <head>: apple-touch-icon, icons with sizes, og:image; mask icons skipped", () => {
  const html = `<!doctype html><html><head>
    <link rel="icon" href="/favicon-32.png" sizes="32x32" type="image/png">
    <link rel="apple-touch-icon" sizes="180x180" href="https://cdn.acme.com/apple.png">
    <link rel='shortcut icon' href='/favicon.ico'>
    <link rel="mask-icon" href="/mask.svg" color="#000">
    <link rel="icon" href="/logo.svg" sizes="any" type="image/svg+xml">
    <link rel="icon" href="javascript:alert(1)">
    <meta property="og:image" content="https://acme.com/og.jpg?a=1&amp;b=2">
    </head><body><link rel="icon" href="/body-icon.png"></body></html>`;
  const links = parseIconLinks(html, "https://www.acme.com/en/");
  assert.deepEqual(links.map((l) => [l.kind, l.url, l.size]), [
    ["icon", "https://www.acme.com/favicon-32.png", 32],
    ["apple-touch-icon", "https://cdn.acme.com/apple.png", 180],
    ["icon", "https://www.acme.com/favicon.ico", 0],
    ["icon", "https://www.acme.com/logo.svg", 512],
    ["og:image", "https://acme.com/og.jpg?a=1&b=2", 0],
  ]);
  assert.deepEqual(serviceCandidates("https://www.acme.com").map((c) => c.url), [
    "https://www.google.com/s2/favicons?domain=acme.com&sz=256", "https://icons.duckduckgo.com/ip3/acme.com.ico",
  ]);
  assert.deepEqual(serviceCandidates("localhost"), []);
});

test("Wikimedia Commons: logo files only, upload.wikimedia.org thumbnails, best first", () => {
  assert.match(wikimediaSearchUrl("Dell"), /gsrsearch=Dell\+logo/);
  const json = { query: { pages: {
    1: { index: 2, title: "File:Dell Logo.svg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/thumb/dell.png", mime: "image/svg+xml" }] },
    2: { index: 1, title: "File:Dell logo 2016.svg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/thumb/dell2016.png", mime: "image/svg+xml" }] },
    3: { index: 3, title: "File:Dell office.jpg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/office.jpg", mime: "image/jpeg" }] },
    4: { index: 4, title: "File:Evil logo.png", imageinfo: [{ thumburl: "https://evil.example/x.png", mime: "image/png" }] },
    5: { index: 5, title: "File:Logo.pdf", imageinfo: [{ url: "https://upload.wikimedia.org/x.pdf", mime: "application/pdf" }] },
  } } };
  assert.deepEqual(parseWikimedia(json).map((w) => w.title), ["Dell logo 2016.svg", "Dell Logo.svg"]);
  assert.deepEqual(parseWikimedia({}), []);
});

test("ranking: ours first, then the site's biggest icons, Google, DuckDuckGo, Wikimedia; duplicates dropped", () => {
  const list = rankCandidates([
    { url: "w", source: "wikimedia", width: 256, height: 100, sha: "w" },
    { url: "g", source: "google", width: 256, height: 256, sha: "same" },
    { url: "d", source: "duckduckgo", width: 64, height: 64, sha: "same" },
    { url: "og", source: "site", kind: "og:image", width: 1200, height: 630, sha: "og" },
    { url: "i32", source: "site", kind: "icon", width: 32, height: 32, sha: "i32" },
    { url: "apple", source: "site", kind: "apple-touch-icon", width: 180, height: 180, sha: "a" },
    { url: "tiny", source: "site", kind: "icon", width: 8, height: 8, sha: "t" },
    { url: "cms", source: "cms" },
    { url: "cur", source: "current" },
    { url: "cms", source: "cms" },
  ]);
  assert.deepEqual(list.map((c) => c.url), ["cur", "cms", "apple", "i32", "og", "g", "w"]);
});

test("findLogoCandidates: the site, the services and Wikimedia, each image checked; ours never re-fetched", async () => {
  const pages = {
    "https://acme.com/": { kind: "html", url: "https://www.acme.com/", body: '<head><link rel="apple-touch-icon" href="/apple.png"><meta property="og:image" content="/og.png"></head>' },
    "https://www.acme.com/apple.png": { body: png(180, 180), type: "image/png" },
    "https://www.acme.com/og.png": { body: png(1200, 630), type: "image/png" },
    "https://www.acme.com/favicon.ico": { body: ico(32, 32), type: "image/x-icon" },
    "https://www.google.com/s2/favicons?domain=acme.com&sz=256": { body: png(256, 256), type: "image/png" },
    "https://icons.duckduckgo.com/ip3/acme.com.ico": { body: Buffer.from("<html>"), type: "text/html" },
    [wikimediaSearchUrl("Acme")]: { kind: "json", body: JSON.stringify({ query: { pages: { 1: { index: 1, title: "File:Acme logo.svg", imageinfo: [{ thumburl: "https://upload.wikimedia.org/acme.png", mime: "image/svg+xml" }] } } } }) },
    "https://upload.wikimedia.org/acme.png": { body: png(256, 90), type: "image/png" },
  };
  const asked = [];
  const fetcher = async (url, { kind }) => {
    asked.push(url);
    const p = pages[url];
    if (!p) throw Object.assign(new Error("not found"), { code: "ESTATUS" });
    if ((p.kind || "image") !== kind || (kind === "image" && !String(p.type).startsWith("image/"))) throw Object.assign(new Error("type"), { code: "ETYPE" });
    return { url: p.url || url, contentType: p.type || "text/html", body: Buffer.isBuffer(p.body) ? p.body : Buffer.from(p.body) };
  };
  const out = await findLogoCandidates({ name: "Acme", domain: "acme.com", local: [{ url: "https://cdn.sanity.io/acme.png", source: "cms", label: "Website partner: Acme" }], fetcher });
  assert.equal(out.domain, "acme.com");
  assert.deepEqual(out.candidates.map((c) => [c.source, c.width, c.height]), [
    ["cms", 0, 0], ["site", 180, 180], ["site", 32, 32], ["site", 1200, 630], ["google", 256, 256], ["wikimedia", 256, 90],
  ]);
  assert.match(out.candidates[1].preview, /^data:image\/png;base64,/);
  assert.equal(out.candidates[2].contentType, "image/x-icon");
  assert.ok(!asked.includes("https://cdn.sanity.io/acme.png"));
  assert.ok(out.candidates.every((c) => !("sha" in c)));
  // No domain: Wikimedia only; no name either: nothing at all.
  assert.deepEqual((await findLogoCandidates({ name: "Acme", fetcher })).candidates.map((c) => c.source), ["wikimedia"]);
  assert.deepEqual((await findLogoCandidates({ fetcher })).candidates, []);
});

/* ---------- storing ---------- */

test("prepareLogo: the type comes from the bytes; an .ico with a PNG inside is kept as the PNG; 2 MB max", () => {
  const p = prepareLogo(png(64, 32));
  assert.deepEqual([p.type, p.ext, p.width, p.height, p.sha.length], ["image/png", "png", 64, 32, 64]);
  const fromIco = prepareLogo(ico(48, 48));
  assert.deepEqual([fromIco.type, fromIco.width], ["image/png", 48]);
  assert.equal(prepareLogo(Buffer.from("<html>")).error.length > 0, true);
  assert.match(prepareLogo(Buffer.alloc(MAX_BYTES + 1)).error, /2 MB/);
  assert.match(prepareLogo(Buffer.alloc(0)).error, /empty/);
  assert.equal(prepareLogo(svg).type, "image/svg+xml");
  assert.equal(logoSlug("Société Générale S.A.", "abcdef1234567"), "societe-generale-s-a-abcdef1234");
  assert.deepEqual(decodeLogoDataUrl(`data:image/png;base64,${png(1, 1).toString("base64")}`), png(1, 1));
  assert.equal(decodeLogoDataUrl("data:text/html;base64,PGh0bWw+"), null);
});

test("storeLogo: Cloudinary when configured, else Sanity, else our database", async () => {
  assert.equal(chooseStore({}), "database");
  assert.equal(chooseStore({ SANITY_WRITE_TOKEN: "t" }), "sanity");
  assert.equal(chooseStore({ SANITY_WRITE_TOKEN: "t", CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" }), "cloudinary");
  const logo = prepareLogo(png(64, 64));
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes("cloudinary")) return { ok: true, json: async () => ({ secure_url: "https://res.cloudinary.com/c/image/upload/ttfc/logos/acme.png", public_id: "ttfc/logos/acme" }) };
    return { ok: true, json: async () => ({ document: { _id: "image-abc", url: "https://cdn.sanity.io/images/021qtoci/production/abc.png" } }) };
  };
  const c = await storeLogo({ logo, name: "Acme", env: { CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s" }, fetchImpl });
  assert.deepEqual([c.store, c.ref], ["cloudinary", "ttfc/logos/acme"]);
  const form = new URLSearchParams(calls[0].init.body);
  assert.equal(calls[0].url, "https://api.cloudinary.com/v1_1/c/image/upload");
  assert.deepEqual([form.get("folder"), form.get("api_key"), form.get("public_id")], ["ttfc/logos", "k", `acme-${logo.sha.slice(0, 10)}`]);
  assert.match(form.get("signature"), /^[0-9a-f]{40}$/);
  assert.match(form.get("file"), /^data:image\/png;base64,/);
  const s = await storeLogo({ logo, name: "Acme", env: { SANITY_WRITE_TOKEN: "tok" }, fetchImpl });
  assert.deepEqual([s.store, s.url], ["sanity", "https://cdn.sanity.io/images/021qtoci/production/abc.png"]);
  assert.match(calls[1].url, /^https:\/\/021qtoci\.api\.sanity\.io\/v2021-10-21\/assets\/images\/production\?filename=acme-/);
  assert.equal(calls[1].init.headers.Authorization, "Bearer tok");
  const ic = prepareLogo(ico(16, 16, Buffer.concat([Buffer.alloc(40), Buffer.alloc(16 * 16 * 4)]))); // a BMP-only .ico
  assert.equal(ic.type, "image/x-icon");
  await storeLogo({ logo: ic, name: "Acme", env: { SANITY_WRITE_TOKEN: "tok" }, fetchImpl });
  assert.match(calls[2].url, /\/assets\/files\//);
  const db = await storeLogo({ logo, name: "Acme", env: {}, saveToDb: async () => "65f0a1b2c3d4e5f6a7b8c9d0", apiBase: "https://api.example.com/" });
  assert.deepEqual([db.store, db.url], ["database", "https://api.example.com/api/files/company-logo/65f0a1b2c3d4e5f6a7b8c9d0"]);
  await assert.rejects(storeLogo({ logo, name: "Acme", env: { SANITY_WRITE_TOKEN: "t" }, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ message: "Unauthorized" }) }) }), /Sanity didn't take the logo: Unauthorized/);
});
