import express from "express";
import { exhibitorsPayload } from "../services/exhibitors.js";

/* =========================================================
   /api/app/exhibitors (Oct 24 2026, services/exhibitors.js)
   No sign-in: the website's /programme page shows it.
   GET /exhibitors  { updatedAt, zones: [{ key, name, area, booths }],
                      exhibitors: [{ key, name, booth, booths, zone, logo, website }] }
                    The companies with a booth on an exhibitor pass, one per
                    organisation, by booth number. Never anyone's name,
                    email, phone, pass count, price or order.
                    Cache-Control public, 120 s; built at most once a minute.
========================================================= */

const router = express.Router();

router.get("/exhibitors", async (req, res) => {
  try {
    const body = await exhibitorsPayload();
    res.set("Cache-Control", "public, max-age=120");
    res.json(body);
  } catch (err) {
    console.error("EXHIBITORS ERROR:", err?.message || err);
    res.status(503).json({ error: "The exhibitor list isn't available right now." });
  }
});

export default router;
