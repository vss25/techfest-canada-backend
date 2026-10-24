/* =========================================================
   Site status: always live (Oct 23 2026)
   ---------------------------------------------------------
   The kill switch (Admin › Kill switch: the website and the
   apps offline from the admin panel, stored in AppContent
   "site.kill") was removed for everyone, management included.
   The organiser: "we don't need kill switch access as a website
   admin too. Remove that. Its risky."

   What's left:
     - GET /api/status, because the website and the apps already
       installed ask it on launch: always { live: true, message: "" },
       whatever an old "site.kill" row in the database says
       (nothing reads that row any more);
     - /api/console/kill-switch answers 410 Gone with KILL_SWITCH_REMOVED
       for staff and management (an admin panel still open in a
       browser from before gets a clear answer; volunteers get the
       console's volunteer_forbidden first);
     - "site.kill" can't be written through the app texts and
       switches (PUT /api/console/app-content/:key → 410).
   The audit log keeps the old kill_switch_on / _off entries as
   history. An emergency take-down is done by the developers on
   the hosting (Vercel for the website, Render for this API).
========================================================= */

/** The AppContent key the kill switch used. Never read, never written. */
export const KILL_SWITCH_KEY = "site.kill";

export const KILL_SWITCH_REMOVED = "The kill switch was removed. To take the website or the apps offline in an emergency, ask the developers (hosting).";
export const KILL_SWITCH_REMOVED_CODE = "kill_switch_removed";

/** Keys no generic settings endpoint may write (compared without case or spaces). */
export const RETIRED_CONTENT_KEYS = Object.freeze([KILL_SWITCH_KEY]);
export const isRetiredContentKey = (key) => RETIRED_CONTENT_KEYS.includes(String(key ?? "").trim().toLowerCase());

/** What GET /api/status always answers. */
export const SITE_STATUS = Object.freeze({ live: true, message: "" });

/** GET /api/status: the website and the apps ask this on launch. Never reads the database. */
export function statusHandler(req, res) {
  res.set("Cache-Control", "no-store");
  res.json({ ...SITE_STATUS });
}

/** /api/console/kill-switch, any method: gone. */
export function killSwitchGone(req, res) {
  res.status(410).json({ error: KILL_SWITCH_REMOVED, code: KILL_SWITCH_REMOVED_CODE });
}
