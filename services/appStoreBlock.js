/* =========================================================
   "Get the TTFC app": the App Store + Google Play block in every email (Oct 23 2026)
   ---------------------------------------------------------
   The organiser: "make sure all emails now have details of
   downloading apps whether android or iOS". One fixed block (not a
   staff-editable field): the headline, one short line, then the two
   official-style badges of the app invite (services/appInviteEmail.js,
   which draws its own badges with storeBadgeTable below): black, a
   1px #a6a6a6 edge, the store's logo as a lossless PNG on the website
   (public/email/) with alt text, the stores' own words as live text,
   tables and inline styles only, no SVG and no gradients.
   Side by side when there's room, stacked on a phone: each badge sits
   in an inline-block, so it wraps by itself even where a mail app drops
   the <style> block; appStoreBlockCss() also stacks them under 620px,
   and Outlook on Windows (mso) gets a two-cell table.
     - full     200 × 58 badges, the app invite's panel (pass, RSVP, digest, profile…)
     - compact  160 × 46 badges in a lighter panel (under a sign-in code, the
                Catalyst Awards, form confirmations, calendar invites)
     - theme    "dark" for the purple TTFC emails (#0d0620, 2px #7a3fd1 edge, as in
                the app invite), "light" for the white ones
   Plain text: appStoreBlockText(), "GET THE TTFC APP", the line, then
   "iPhone (App Store): …" and "Android (Google Play): …".
   The badges link straight to the stores: no tracking of their own
   (an email's own open pixel is untouched). The links come from
   services/ticketInfo.js (IOS_APP_STORE_URL with the APP_STORE_URL
   override, PLAY_STORE_URL); no App Store link = Google Play alone.
   Pure, unit-tested (test/app-store-block.test.js).
========================================================= */

import { EVENT, PLAY_STORE_URL, appStoreUrl, escapeHtml as esc } from "./ticketInfo.js";

const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";

/** The store badges' words (the stores' own) and logos: small lossless PNGs on the website (public/email/, 56 px for
    28 px), white Apple logo and the four-colour Play triangle. */
export const STORE_BADGES = Object.freeze({
  appStore: Object.freeze({ id: "appStore", top: "Download on the", name: "App Store", text: "iPhone (App Store)", alt: "Apple", glyph: `${EVENT.website}/email/store-apple@2x.png` }),
  play: Object.freeze({ id: "play", top: "GET IT ON", name: "Google Play", text: "Android (Google Play)", alt: "Play", glyph: `${EVENT.website}/email/store-play@2x.png` }),
});

/** The block's words (fixed, not editable). */
export const APP_BLOCK = Object.freeze({
  headline: "Get the TTFC app",
  line: "Your pass, the schedule, live polls and messages, on your phone. Free on iPhone and Android.",
});

/** The badges to show, App Store first: [{ ...STORE_BADGES.x, href }]. No App Store link = Google Play alone. */
export function storeLinks({ storeUrl = appStoreUrl() } = {}) {
  return [
    ...(storeUrl ? [{ ...STORE_BADGES.appStore, href: storeUrl }] : []),
    { ...STORE_BADGES.play, href: PLAY_STORE_URL },
  ];
}

/* Badge sizes. `full` is the app invite's badge exactly (its test pins the markup). */
const SIZES = Object.freeze({
  full: { w: 200, h: 58, cellW: 62, cellH: 56, logo: 28, logoPad: "14px 10px 14px 24px", textPad: "9px 10px 9px 0",
    top: [11, 14], name: [21, 25], nameSpacing: "-0.3px", cls: ' class="sbt"' },
  compact: { w: 160, h: 46, cellW: 48, cellH: 44, logo: 22, logoPad: "11px 8px 11px 18px", textPad: "7px 8px 7px 0",
    top: [9, 11], name: [16, 19], nameSpacing: "-0.2px", cls: ' class="sbt-c"' },
});

/**
 * One badge: a black table with the store's logo and its two lines of live text. Every part is a link; with images
 * off it still reads "Download on the App Store". `indent`: the markup's line indent (the app invite's by default).
 */
export function storeBadgeTable({ href, top, name, glyph, alt }, { compact = false, indent = " ".repeat(18) } = {}) {
  const s = compact ? SIZES.compact : SIZES.full;
  return `<table role="presentation"${s.cls} width="${s.w}" height="${s.h}" cellpadding="0" cellspacing="0" border="0" bgcolor="#000000" style="width:${s.w}px;height:${s.h}px;margin:0 auto;background:#000000;border:1px solid #a6a6a6;border-radius:${compact ? 10 : 12}px;border-collapse:separate;"><tr>
${indent}  <td width="${s.cellW}" height="${s.cellH}" align="right" valign="middle" style="width:${s.cellW}px;height:${s.cellH}px;padding:0;"><a href="${esc(href)}" target="_blank" style="display:block;padding:${s.logoPad};text-decoration:none;"><img src="${esc(glyph)}" width="${s.logo}" height="${s.logo}" alt="${esc(alt)}" style="display:block;width:${s.logo}px;height:${s.logo}px;border:0;outline:none;font-family:${SANS};font-size:9px;line-height:${s.logo}px;color:#ffffff;"></a></td>
${indent}  <td align="left" valign="middle" style="padding:0;"><a href="${esc(href)}" target="_blank" style="display:block;padding:${s.textPad};font-family:${SANS};color:#ffffff;text-decoration:none;white-space:nowrap;"><span style="display:block;font-size:${s.top[0]}px;line-height:${s.top[1]}px;font-weight:500;letter-spacing:${top === top.toUpperCase() ? "0.6px" : "0.1px"};color:#ffffff;">${esc(top)}</span><span style="display:block;font-size:${s.name[0]}px;line-height:${s.name[1]}px;font-weight:600;letter-spacing:${s.nameSpacing};color:#ffffff;">${esc(name)}</span></a></td>
${indent}</tr></table>`;
}

/* The panel: the app invite's look on the purple emails, white on the white ones. */
const THEMES = Object.freeze({
  dark: { bg: "#0d0620", head: "#ffffff", text: "#ddd5ef" },
  light: { bg: "#ffffff", head: "#140a26", text: "#3a2f55" },
});

/**
 * The block's HTML: one table, 100% wide, for a cell of the email's own layout.
 * @param {object} [p]
 * @param {boolean} [p.compact]  smaller badges and panel (under a code, the awards, confirmations)
 * @param {"dark"|"light"} [p.theme]
 * @param {string} [p.storeUrl]  the App Store link ("" = Google Play alone)
 */
export function appStoreBlockHtml({ compact = false, theme = "dark", storeUrl = appStoreUrl() } = {}) {
  const P = THEMES[theme] || THEMES.dark;
  const stores = storeLinks({ storeUrl });
  const cellW = (compact ? SIZES.compact.w : SIZES.full.w) + 12;
  const cell = (x) => `
        <div class="ab-sb" style="display:inline-block;vertical-align:top;width:${cellW}px;max-width:100%;padding:0 0 10px;">
          ${storeBadgeTable(x, { compact, indent: " ".repeat(10) })}
        </div>`;
  const badges = stores.map(cell).join(`
        <!--[if mso]></td><td width="${cellW}" valign="top"><![endif]-->`);
  return `<!-- Get the TTFC app: App Store and Google Play -->
<table role="presentation" class="ab-panel" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${P.bg}" style="width:100%;background:${P.bg};border:${compact ? 1 : 2}px solid #7a3fd1;border-radius:${compact ? 14 : 18}px;border-collapse:separate;">
  <tr>
    <td align="center" style="padding:${compact ? "16px 12px 6px" : "24px 16px 14px"};">
      <div class="ab-hd" style="font-family:${SANS};font-size:${compact ? 17 : 22}px;line-height:${compact ? 22 : 28}px;font-weight:800;color:${P.head};margin:0 0 ${compact ? 4 : 6}px;">${esc(APP_BLOCK.headline)}</div>
      <div class="ab-tx" style="font-family:${SANS};font-size:${compact ? 13 : 15}px;line-height:${compact ? 19 : 22}px;color:${P.text};margin:0 0 ${compact ? 12 : 18}px;">${esc(APP_BLOCK.line)}</div>
      <div style="font-size:0;line-height:0;text-align:center;">
        <!--[if mso]><table role="presentation" cellpadding="0" cellspacing="0" border="0" align="center"><tr><td width="${cellW}" valign="top"><![endif]-->${badges}
        <!--[if mso]></td></tr></table><![endif]-->
      </div>
    </td>
  </tr>
</table>`;
}

/**
 * Rules for the email's <style> block: stack the badges under 620px, and (`adapt`) restyle the panel for the
 * email's other colour scheme: "light" (a dark email's light version) or "dark" (a white email's dark version).
 */
export function appStoreBlockCss({ adapt = "" } = {}) {
  const rules = ["  @media only screen and (max-width:620px) { .ab-sb { display:block !important; width:100% !important; } }"];
  if (adapt === "light") rules.push("  @media (prefers-color-scheme: light) { .ab-panel { background:#ffffff !important; } .ab-hd { color:#140a26 !important; } .ab-tx { color:#3a2f55 !important; } }");
  if (adapt === "dark") rules.push("  @media (prefers-color-scheme: dark) { .ab-panel { background:#0d0620 !important; } .ab-hd { color:#ffffff !important; } .ab-tx { color:#ddd5ef !important; } }");
  return rules.join("\n");
}

/** The plain-text part's lines: the headline, the line and both store links (no trailing blank line). */
export function appStoreBlockLines({ storeUrl = appStoreUrl() } = {}) {
  return [APP_BLOCK.headline.toUpperCase(), APP_BLOCK.line, ...storeLinks({ storeUrl }).map((x) => `  ${x.text}: ${x.href}`)];
}

/** The same as one string. */
export const appStoreBlockText = (opts) => appStoreBlockLines(opts).join("\n");

/**
 * The block for a staff-built email (Audience campaigns, automation, test sends): a centred 560px box, white like the
 * campaign wrapper's card, for just before the footer (services/emailService.js generateCampaignFooter).
 */
export function campaignAppBlock({ storeUrl = appStoreUrl() } = {}) {
  return `
    <div style="padding:20px 16px 0;">
      <div style="max-width:560px;margin:0 auto;">
${appStoreBlockHtml({ theme: "light", storeUrl })}
      </div>
    </div>`;
}
