/* =========================================================
   Company logos from the internet (Admin → People → profile →
   Company logo → "Find logos"). No API keys: the company's own
   site (apple-touch-icon, <link rel=icon>, og:image, /favicon.ico),
   Google's favicon service at 256 px, DuckDuckGo's icons, and a
   Wikimedia Commons search for "<company> logo".

   Every server-side fetch goes through safeFetch:
     - http(s) only, ports 80/443, no user names in the URL
     - the host is resolved first and refused when ANY address is
       private, loopback, link-local, CGNAT, multicast or reserved;
       the check runs inside the connection's DNS lookup, so the
       address that is checked is the one connected to (no rebinding)
     - at most 3 redirects (each one checked again)
     - 5 s for the whole chain, 2 MB at most, no compression
     - only the content types asked for (images are also sniffed:
       an HTML page labelled image/png is refused)
     - no cookies or other headers of ours are ever sent
   The pure parts (address and URL checks, HTML icon links, image
   sniffing, Wikimedia results, ranking) are unit-tested in
   test/logo-fetch.test.js.
========================================================= */

import http from "node:http";
import https from "node:https";
import dns from "node:dns";
import net from "node:net";
import { createHash } from "node:crypto";
import { cleanDomain } from "./companies.js";

export const MAX_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 5000;
export const MAX_REDIRECTS = 3;
const UA = "TTFC-admin-logo-finder/1.0 (+https://www.thetechfestival.com; enquire@thetechfestival.com)";

/* ---------- Addresses ---------- */

function v4Parts(ip) {
  const p = String(ip).split(".");
  if (p.length !== 4) return null;
  const n = p.map((x) => (/^\d{1,3}$/.test(x) ? Number(x) : NaN));
  return n.every((x) => x >= 0 && x <= 255) ? n : null;
}

function privateV4([a, b, c]) {
  return a === 0 || a === 10 || a === 127 // "this" network, private, loopback
    || (a === 100 && b >= 64 && b <= 127) // carrier-grade NAT
    || (a === 169 && b === 254) // link-local (cloud metadata lives here)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && b === 168)
    || (a === 192 && b === 0 && (c === 0 || c === 2)) // IETF protocol assignments, TEST-NET-1
    || (a === 192 && b === 88 && c === 99) // 6to4 relay
    || (a === 198 && (b === 18 || b === 19)) // benchmarking
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // TEST-NET-2/3
    || a >= 224; // multicast, reserved, broadcast
}

/** Expands an IPv6 address to 8 numbers, or null. */
function v6Words(ip) {
  let s = String(ip).toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  let tail = [];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4Parts(v4[1]);
    if (!p) return null;
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    s = s.slice(0, -v4[1].length);
    if (s.endsWith(":") && !s.endsWith("::")) s = s.slice(0, -1);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const parse = (h) => (h ? h.split(":").map((x) => (/^[0-9a-f]{1,4}$/.test(x) ? parseInt(x, 16) : NaN)) : []);
  const head = parse(halves[0]);
  const back = halves.length === 2 ? parse(halves[1]) : [];
  const fill = 8 - tail.length - head.length - back.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const words = [...head, ...Array(halves.length === 2 ? fill : 0).fill(0), ...back, ...tail];
  return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : null;
}

/**
 * True for any address a server-side fetch must never reach: private, loopback,
 * link-local, CGNAT, multicast, reserved, unspecified, and the IPv6 forms of all of
 * those (unique local fc00::/7, link-local fe80::/10, IPv4-mapped / -compatible / NAT64
 * of a private IPv4, 6to4 of a private IPv4). Anything that isn't a valid IP is refused too.
 */
export function isPrivateAddress(ip) {
  const s = String(ip || "").trim();
  if (net.isIPv4(s)) return privateV4(v4Parts(s));
  if (!net.isIPv6(s.replace(/^\[|\]$/g, "").split("%")[0])) return true;
  const w = v6Words(s);
  if (!w) return true;
  const zeroHead = w.slice(0, 5).every((x) => x === 0);
  if (w.every((x) => x === 0)) return true; // ::
  if (zeroHead && w[5] === 0 && w[6] === 0 && w[7] === 1) return true; // ::1
  const embedded = () => [w[6] >> 8, w[6] & 0xff, w[7] >> 8, w[7] & 0xff];
  if (zeroHead && (w[5] === 0xffff || w[5] === 0)) return privateV4(embedded()); // ::ffff:a.b.c.d, ::a.b.c.d
  if (w[0] === 0x64 && w[1] === 0xff9b) return privateV4(embedded()); // NAT64
  if (w[0] === 0x2002) return privateV4([w[1] >> 8, w[1] & 0xff, w[2] >> 8, w[2] & 0xff]); // 6to4
  if ((w[0] & 0xfe00) === 0xfc00) return true; // unique local
  if ((w[0] & 0xffc0) === 0xfe80 || (w[0] & 0xffc0) === 0xfec0) return true; // link-local, old site-local
  if ((w[0] & 0xff00) === 0xff00) return true; // multicast
  if (w[0] === 0x2001 && w[1] === 0x0db8) return true; // documentation
  if (w[0] === 0x2001 && w[1] < 0x0200) return true; // Teredo and other IETF special purpose
  if (w[0] === 0x0100 && w[1] === 0 && w[2] === 0 && w[3] === 0) return true; // discard-only
  return false;
}

const BLOCKED_HOSTS = /(^|\.)(localhost|local|localdomain|internal|intranet|lan|home|corp|onion|test|invalid|example)$/i;

/**
 * Is this URL one we may fetch? → { ok: true, url: URL } | { ok: false, error }.
 * http(s), default ports only, no credentials, a public-looking host name or a public IP.
 * The host's addresses are checked again when connecting (guardedLookup).
 */
export function checkUrl(raw) {
  let u;
  try { u = raw instanceof URL ? new URL(raw.href) : new URL(String(raw || "").trim()); } catch { return { ok: false, error: "That isn't a web address." }; }
  if (!["http:", "https:"].includes(u.protocol)) return { ok: false, error: "Only http and https links can be used." };
  if (u.username || u.password) return { ok: false, error: "Links with a user name or password can't be used." };
  if (u.port && !((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80"))) {
    return { ok: false, error: "Links to other ports can't be used." };
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!host) return { ok: false, error: "That link has no host." };
  if (net.isIP(host)) {
    if (isPrivateAddress(host)) return { ok: false, error: "That address isn't on the public internet." };
  } else if (!host.includes(".") || BLOCKED_HOSTS.test(host)) {
    return { ok: false, error: "That address isn't on the public internet." };
  }
  u.hash = "";
  return { ok: true, url: u };
}

/** DNS lookup for http(s).request that refuses private addresses (all of them are checked). */
export function makeGuardedLookup(lookupImpl = dns.lookup) {
  return function guardedLookup(hostname, options, callback) {
    const opts = typeof options === "object" && options ? options : { family: options };
    lookupImpl(hostname, { all: true, verbatim: true, family: opts.family || 0 }, (err, addresses) => {
      if (err) return callback(err);
      const list = (Array.isArray(addresses) ? addresses : [{ address: addresses, family: net.isIP(addresses) }])
        .filter((a) => a && a.address);
      if (!list.length || list.some((a) => isPrivateAddress(a.address))) {
        const e = new Error(`${hostname} resolves to an address that isn't on the public internet`);
        e.code = "EBLOCKED";
        return callback(e);
      }
      if (opts.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family || net.isIP(list[0].address));
    });
  };
}
const guardedLookup = makeGuardedLookup();

/* ---------- Content types ---------- */
const ACCEPT = {
  image: "image/avif,image/webp,image/png,image/svg+xml,image/*;q=0.8",
  html: "text/html,application/xhtml+xml;q=0.9",
  json: "application/json",
};
const baseType = (ct) => String(ct || "").split(";")[0].trim().toLowerCase();
export function typeAllowed(kind, contentType) {
  const t = baseType(contentType);
  if (kind === "image") return t.startsWith("image/");
  if (kind === "html") return t === "text/html" || t === "application/xhtml+xml";
  if (kind === "json") return t === "application/json" || t.endsWith("+json");
  return false;
}

class FetchError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

function once(url, { kind, deadline, maxBytes, lookup, transport }) {
  return new Promise((resolve, reject) => {
    const left = deadline - Date.now();
    if (left <= 0) return reject(new FetchError("Took too long", "ETIMEOUT"));
    const lib = transport?.[url.protocol] || (url.protocol === "https:" ? https : http);
    const req = lib.request(url, {
      method: "GET",
      agent: false,
      lookup,
      headers: { "User-Agent": UA, Accept: ACCEPT[kind] || "*/*", "Accept-Encoding": "identity" },
    });
    const timer = setTimeout(() => req.destroy(new FetchError("Took too long", "ETIMEOUT")), left);
    req.on("error", (err) => { clearTimeout(timer); reject(err); });
    req.on("response", (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        clearTimeout(timer);
        return resolve({ status, location: String(res.headers.location) });
      }
      const contentType = String(res.headers["content-type"] || "");
      const declared = Number(res.headers["content-length"] || 0);
      if (declared > maxBytes) {
        clearTimeout(timer); req.destroy();
        return reject(new FetchError("That file is over 2 MB", "ETOOBIG"));
      }
      const chunks = [];
      let size = 0;
      res.on("data", (c) => {
        size += c.length;
        if (size > maxBytes) { clearTimeout(timer); req.destroy(); reject(new FetchError("That file is over 2 MB", "ETOOBIG")); return; }
        chunks.push(c);
      });
      res.on("end", () => { clearTimeout(timer); resolve({ status, contentType, body: Buffer.concat(chunks) }); });
      res.on("error", (err) => { clearTimeout(timer); reject(err); });
    });
    req.end();
  });
}

/**
 * Fetch a public URL safely. `kind`: "image" | "html" | "json".
 * → { url (final), status, contentType, body } ; throws FetchError (code ETIMEOUT, ETOOBIG,
 * EBLOCKED, EREDIRECTS, ESTATUS, ETYPE, EURL) or a network error.
 * `transport` / `lookup` are for tests (fake http modules and DNS).
 */
export async function safeFetch(raw, { kind = "image", timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES, maxRedirects = MAX_REDIRECTS, lookup = guardedLookup, transport = null } = {}) {
  const deadline = Date.now() + timeoutMs;
  let check = checkUrl(raw);
  if (!check.ok) throw new FetchError(check.error, "EURL");
  let url = check.url;
  for (let hop = 0; ; hop++) {
    const r = await once(url, { kind, deadline, maxBytes, lookup, transport });
    if (r.location) {
      if (hop >= maxRedirects) throw new FetchError("Too many redirects", "EREDIRECTS");
      let next;
      try { next = new URL(r.location, url); } catch { throw new FetchError("Bad redirect", "EURL"); }
      check = checkUrl(next);
      if (!check.ok) throw new FetchError(check.error, "EURL");
      url = check.url;
      continue;
    }
    if (r.status < 200 || r.status >= 300) throw new FetchError(`The site answered ${r.status}`, "ESTATUS");
    if (!typeAllowed(kind, r.contentType)) throw new FetchError(`Not ${kind === "image" ? "an image" : kind} (${baseType(r.contentType) || "no type"})`, "ETYPE");
    return { url: url.href, status: r.status, contentType: baseType(r.contentType), body: r.body };
  }
}

/* ---------- Images ---------- */

const u16le = (b, o) => b[o] | (b[o + 1] << 8);
const u16be = (b, o) => (b[o] << 8) | b[o + 1];
const u32be = (b, o) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];

function icoEntries(b) {
  if (b.length < 6 || u16le(b, 0) !== 0 || u16le(b, 2) !== 1) return null;
  const n = u16le(b, 4);
  if (!n || b.length < 6 + n * 16) return null;
  const out = [];
  for (let i = 0; i < n; i++) {
    const o = 6 + i * 16;
    const size = b.readUInt32LE(o + 8);
    const offset = b.readUInt32LE(o + 12);
    if (offset + size > b.length) continue;
    out.push({ width: b[o] || 256, height: b[o + 1] || 256, size, offset });
  }
  return out.length ? out : null;
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * What an image really is, from its bytes → { type, width, height } or null when it isn't
 * one we accept (PNG, JPEG, GIF, WebP, ICO, SVG). Width / height are 0 when unknown.
 */
export function sniffImage(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  if (b.length < 12) return null;
  if (b.subarray(0, 8).equals(PNG_SIG)) return { type: "image/png", width: b.length >= 24 ? u32be(b, 16) : 0, height: b.length >= 24 ? u32be(b, 20) : 0 };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    let o = 2;
    while (o + 9 < b.length) {
      if (b[o] !== 0xff || b[o + 1] === 0xff) { o += 1; continue; }
      const marker = b[o + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { type: "image/jpeg", width: u16be(b, o + 7), height: u16be(b, o + 5) };
      }
      o += 2 + u16be(b, o + 2);
    }
    return { type: "image/jpeg", width: 0, height: 0 };
  }
  const head = b.subarray(0, 6).toString("latin1");
  if (head === "GIF87a" || head === "GIF89a") return { type: "image/gif", width: u16le(b, 6), height: u16le(b, 8) };
  if (b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP") {
    const chunk = b.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X" && b.length >= 30) return { type: "image/webp", width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
    if (chunk === "VP8 " && b.length >= 30) return { type: "image/webp", width: u16le(b, 26) & 0x3fff, height: u16le(b, 28) & 0x3fff };
    if (chunk === "VP8L" && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { type: "image/webp", width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
    }
    return { type: "image/webp", width: 0, height: 0 };
  }
  const ico = icoEntries(b);
  if (ico) {
    const big = ico.reduce((m, e) => (e.width * e.height > m.width * m.height ? e : m), ico[0]);
    return { type: "image/x-icon", width: big.width, height: big.height };
  }
  const text = b.subarray(0, 4096).toString("utf8").replace(/^﻿/, "").trimStart();
  if (/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*(<!doctype svg[^>]*>\s*)?<svg[\s>]/i.test(text)) {
    const tag = text.match(/<svg[^>]*>/i)?.[0] || "";
    const num = (name) => Number((tag.match(new RegExp(`\\b${name}\\s*=\\s*["']?\\s*([\\d.]+)`, "i")) || [])[1]) || 0;
    const vb = (tag.match(/viewBox\s*=\s*["']\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)/i) || []);
    return { type: "image/svg+xml", width: Math.round(num("width") || Number(vb[1]) || 0), height: Math.round(num("height") || Number(vb[2]) || 0) };
  }
  return null;
}

/** The biggest PNG inside an .ico (most modern favicons carry one), or null. */
export function icoLargestPng(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const entries = icoEntries(b);
  if (!entries) return null;
  const pngs = entries.filter((e) => b.subarray(e.offset, e.offset + 8).equals(PNG_SIG))
    .sort((x, y) => y.width * y.height - x.width * x.height);
  return pngs.length ? b.subarray(pngs[0].offset, pngs[0].offset + pngs[0].size) : null;
}

/** An image we'll keep: its sniffed type must agree with an image/* header. → { type, width, height } | null */
export function checkImage(body, contentType) {
  if (!typeAllowed("image", contentType)) return null;
  return sniffImage(body);
}

/* ---------- Where to look ---------- */

const attr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i"));
  return m ? (m[1] ?? m[2] ?? m[3] ?? "").trim() : "";
};
const decodeEntities = (s) => s.replace(/&amp;/g, "&").replace(/&#x2f;/gi, "/").replace(/&#47;/g, "/").replace(/&quot;/g, '"');
const sizeOf = (sizes) => {
  if (/any/i.test(sizes)) return 512;
  return Math.max(0, ...String(sizes || "").split(/\s+/).map((s) => Number(s.split(/x/i)[0]) || 0));
};

/**
 * Icon links in a page's <head> → [{ url, kind: "apple-touch-icon" | "icon" | "og:image", size, type }],
 * absolute, http(s) only, de-duplicated. Mask icons (monochrome outlines) are left out.
 */
export function parseIconLinks(html, baseUrl) {
  const src = String(html || "").slice(0, 400_000);
  const head = src.split(/<\/head>/i)[0];
  const out = [];
  const seen = new Set();
  const add = (href, kind, size = 0, type = "") => {
    if (!href) return;
    let u;
    try { u = new URL(decodeEntities(href), baseUrl); } catch { return; }
    if (!["http:", "https:"].includes(u.protocol) || seen.has(u.href)) return;
    seen.add(u.href);
    out.push({ url: u.href, kind, size, type });
  };
  for (const tag of head.match(/<link\b[^>]*>/gi) || []) {
    const rel = attr(tag, "rel").toLowerCase().split(/\s+/);
    const href = attr(tag, "href");
    if (rel.includes("apple-touch-icon") || rel.includes("apple-touch-icon-precomposed")) add(href, "apple-touch-icon", sizeOf(attr(tag, "sizes")) || 180, attr(tag, "type"));
    else if (rel.includes("icon") && !rel.includes("mask-icon")) add(href, "icon", sizeOf(attr(tag, "sizes")), attr(tag, "type"));
  }
  for (const tag of head.match(/<meta\b[^>]*>/gi) || []) {
    const prop = (attr(tag, "property") || attr(tag, "name")).toLowerCase();
    if (prop === "og:image" || prop === "og:image:url" || prop === "og:image:secure_url") add(attr(tag, "content"), "og:image");
  }
  return out;
}

/** The fixed places to look for a domain: Google at 256 px, DuckDuckGo, and the site's /favicon.ico. */
export function serviceCandidates(domain) {
  const d = cleanDomain(domain)?.domain;
  if (!d) return [];
  return [
    { url: `https://www.google.com/s2/favicons?domain=${encodeURIComponent(d)}&sz=256`, source: "google", label: "Google favicon (256 px)" },
    { url: `https://icons.duckduckgo.com/ip3/${encodeURIComponent(d)}.ico`, source: "duckduckgo", label: "DuckDuckGo icon" },
  ];
}

export const wikimediaSearchUrl = (name) => "https://commons.wikimedia.org/w/api.php?" + new URLSearchParams({
  action: "query", format: "json", generator: "search", gsrnamespace: "6", gsrlimit: "8",
  gsrsearch: `${String(name || "").slice(0, 100)} logo`, prop: "imageinfo", iiprop: "url|mime|size", iiurlwidth: "256",
}).toString();

/** Wikimedia Commons search results → [{ url, title }] (logo files only, best first, at most 3). */
export function parseWikimedia(json) {
  const pages = Object.values(json?.query?.pages || {});
  return pages
    .filter((p) => /logo/i.test(String(p?.title || "")) && Array.isArray(p?.imageinfo) && p.imageinfo[0])
    .sort((a, b) => (a.index || 0) - (b.index || 0))
    .map((p) => {
      const i = p.imageinfo[0];
      const url = i.thumburl || i.url;
      return /^https:\/\/upload\.wikimedia\.org\//.test(String(url || "")) && /^image\/(png|jpeg|svg\+xml|gif|webp)$/.test(String(i.mime || ""))
        ? { url, title: String(p.title).replace(/^File:/, "").slice(0, 120) }
        : null;
    })
    .filter(Boolean)
    .slice(0, 3);
}

const SOURCE_ORDER = { current: 0, cms: 1, site: 2, google: 3, duckduckgo: 4, wikimedia: 5 };
const KIND_ORDER = { "apple-touch-icon": 0, icon: 1, "og:image": 3, favicon: 2 };

/**
 * Checked candidates → the list staff choose from: our own logos first (current default,
 * website partners), then the company's site (biggest icons first), Google, DuckDuckGo,
 * Wikimedia. Duplicates (same final URL or same bytes) and images under 16 px are dropped.
 */
export function rankCandidates(list) {
  const seenUrl = new Set();
  const seenHash = new Set();
  const out = [];
  const area = (c) => (c.width || 0) * (c.height || 0);
  const sorted = [...list].sort((a, b) =>
    (SOURCE_ORDER[a.source] ?? 9) - (SOURCE_ORDER[b.source] ?? 9)
    || (a.source === "site" && b.source === "site" ? (KIND_ORDER[a.kind] ?? 5) - (KIND_ORDER[b.kind] ?? 5) || area(b) - area(a) : 0)
    || area(b) - area(a));
  for (const c of sorted) {
    if (seenUrl.has(c.url) || (c.sha && seenHash.has(c.sha))) continue;
    const local = c.source === "current" || c.source === "cms";
    if (!local && c.width && c.height && Math.max(c.width, c.height) < 16) continue;
    seenUrl.add(c.url);
    if (c.sha) seenHash.add(c.sha);
    out.push(c);
  }
  return out.slice(0, 16);
}

/* ---------- Putting it together ---------- */

const PREVIEW_MAX = 200 * 1024;
const sha = (b) => createHash("sha256").update(b).digest("hex");

/** Fetch one candidate image and describe it (null when it isn't a usable image). */
async function inspect(c, fetcher) {
  try {
    const r = await fetcher(c.url, { kind: "image" });
    const img = checkImage(r.body, r.contentType);
    if (!img) return null;
    return {
      ...c, url: r.url, contentType: img.type, bytes: r.body.length, width: img.width, height: img.height, sha: sha(r.body),
      // Small ones come back as data: URLs, so the staff browser never loads third-party images.
      preview: r.body.length <= PREVIEW_MAX ? `data:${img.type};base64,${r.body.toString("base64")}` : "",
    };
  } catch {
    return null;
  }
}

async function inParallel(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
  });
  await Promise.all(workers);
  return out;
}

/**
 * Logo candidates for a company.
 * @param {object} o
 * @param {string} o.name            company name (for Wikimedia)
 * @param {string} [o.domain]        what staff typed or confirmed ("acme.com")
 * @param {Array}  [o.local]         our own logos first: [{ url, source: "current"|"cms", label }] (not re-checked)
 * @param {boolean} [o.wikimedia]    also search Wikimedia Commons (default true)
 * @param {Function} [o.fetcher]     safeFetch (tests pass a fake)
 * → { domain, candidates: [...], errors: [...] }
 */
export async function findLogoCandidates({ name = "", domain = "", local = [], wikimedia = true, fetcher = safeFetch } = {}) {
  const d = cleanDomain(domain);
  const errors = [];
  const toCheck = [];
  if (d) {
    // The site itself: icons in its <head>, its og:image and /favicon.ico (from wherever it redirected to).
    const pages = [`https://${d.host}/`, ...(d.host === d.domain ? [`https://www.${d.domain}/`] : [])];
    let page = null;
    for (const p of pages) {
      try { page = await fetcher(p, { kind: "html" }); break; } catch (err) { errors.push(`${p}: ${err.message}`); }
    }
    if (page) {
      for (const l of parseIconLinks(page.body.toString("utf8"), page.url)) {
        toCheck.push({ url: l.url, source: "site", kind: l.kind, label: l.kind === "og:image" ? "Website social image" : l.kind === "apple-touch-icon" ? "Website app icon" : "Website icon" });
      }
      toCheck.push({ url: new URL("/favicon.ico", page.url).href, source: "site", kind: "favicon", label: "Website favicon" });
    } else {
      toCheck.push({ url: `https://${d.host}/favicon.ico`, source: "site", kind: "favicon", label: "Website favicon" });
    }
    toCheck.push(...serviceCandidates(d.domain));
  }
  if (wikimedia && String(name || "").trim().length >= 2) {
    try {
      const r = await fetcher(wikimediaSearchUrl(name), { kind: "json" });
      for (const w of parseWikimedia(JSON.parse(r.body.toString("utf8")))) toCheck.push({ url: w.url, source: "wikimedia", label: `Wikimedia Commons: ${w.title}` });
    } catch (err) { errors.push(`Wikimedia: ${err.message}`); }
  }
  const checked = (await inParallel(toCheck.slice(0, 20), 6, (c) => inspect(c, fetcher))).filter(Boolean);
  const ours = local.filter((c) => c && c.url).map((c) => ({ ...c, preview: "", width: c.width || 0, height: c.height || 0 }));
  return { domain: d?.domain || "", candidates: rankCandidates([...ours, ...checked]).map(({ sha: _s, ...c }) => c), errors };
}
