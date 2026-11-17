import express from "express";
import jwt from "jsonwebtoken";
import AdminSetting from "../models/AdminSetting.js";
import { requireAdmin, requireManagement } from "../middleware/adminAuth.js";
import { CONTENT_KEYS, CONTENT_LABELS } from "../services/adminHelpers.js";
import { recordAudit } from "../services/auditLog.js";

const router = express.Router();

const authMiddleware = (req, res, next) => {
  try {
    const header = req.headers.authorization;
    if (!header || !header.startsWith("Bearer ")) {
      return res.status(401).json({ error: "No token provided" });
    }
    const token = header.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    res.status(401).json({ error: "Invalid token" });
  }
};

// Settings are staff-only, like events and ticket types. Routes check the
// database, not the token's "role" claim (middleware/adminAuth.js).
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

/* ================= THE REGISTRY =================
   The keys staff may set through this API — exactly the keys the codebase
   reads today. The source of truth is CONTENT_KEYS (services/adminHelpers.js):
   every app-content / site / flag / offer / swag / stay / app-version /
   review key the apps, the website and the live switches read (today via
   AppContent rows, services/liveSwitches.js). Deriving the registry from
   CONTENT_KEYS means a key the code learns to read is automatically a key
   staff can set here, with the same default.

   valueType comes from the default's own type. Two honest exceptions to
   know about: "offer.guest_discount" and "swag.kits" are numeric STRINGS
   ("50", "3") because that's how the code reads them, and "stay.journey"
   is a string holding a JSON list (validated by services/stayJourney.js
   when served). "review.enabled" is likewise the string "true"/"false".

   Writes go to AdminSetting (models/AdminSetting.js). The apps still read
   AppContent for these keys — this registry coexists with it as the typed
   write path for new Admin modules; moving the live reads over is a later
   step, deliberately not bundled into this change. */
const MODULE_BY_PREFIX = {
  site: "site",
  flag: "flags",
  offer: "offers",
  swag: "swag",
  stay: "stay-updated",
  app: "app-version",
  review: "app-review",
};

function moduleOf(key) {
  return MODULE_BY_PREFIX[key.split(".")[0]] || "app-content";
}

function valueTypeOf(def) {
  if (typeof def === "boolean") return "boolean";
  if (typeof def === "number") return "number";
  if (typeof def === "string") return "string";
  return "json";
}

export const KNOWN_KEYS = Object.freeze(
  Object.fromEntries(
    Object.entries(CONTENT_KEYS).map(([key, def]) => [
      key,
      Object.freeze({
        module: moduleOf(key),
        valueType: valueTypeOf(def),
        default: def,
        description: CONTENT_LABELS[key]?.description || "",
      }),
    ])
  )
);

const MODULES = Object.freeze(
  [...new Set(Object.values(KNOWN_KEYS).map((s) => s.module))].sort()
);

// Returns { value } (normalised) or { error }.
function validateValue(spec, value) {
  switch (spec.valueType) {
    case "boolean":
      if (value === true || value === "true") return { value: true };
      if (value === false || value === "false") return { value: false };
      return { error: "must be a boolean (true or false)" };
    case "number": {
      const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
      if (typeof n === "number" && Number.isFinite(n)) return { value: n };
      return { error: "must be a number" };
    }
    case "string":
      if (typeof value === "string") return { value };
      return { error: "must be a string" };
    case "json": {
      if (value !== null && typeof value === "object") return { value };
      if (typeof value === "string") {
        try {
          return { value: JSON.parse(value) };
        } catch {
          return { error: "must be valid JSON" };
        }
      }
      return { error: "must be a JSON object or array" };
    }
    default:
      return { error: "unsupported value type" };
  }
}

function view(key, spec, row) {
  return {
    key,
    module: spec.module,
    valueType: spec.valueType,
    description: spec.description,
    default: spec.default,
    value: row ? row.value : null,
    effectiveValue: row ? row.value : spec.default,
    isSet: Boolean(row),
    updatedBy: row?.updatedBy || "",
    updatedAt: row?.updatedAt || null,
  };
}

// ================= LIST SETTINGS =================
// Every registered key with its default and (if set) its stored value.
// Optional ?module= filter (site, flags, offers, swag, stay-updated,
// app-version, app-review, app-content).
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const module = typeof req.query.module === "string" ? req.query.module : "";
    const rows = await AdminSetting.find(module ? { module } : {}).lean();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    const settings = Object.entries(KNOWN_KEYS)
      .filter(([, spec]) => !module || spec.module === module)
      .map(([key, spec]) => view(key, spec, byKey.get(key)));
    res.json({ settings, modules: MODULES });
  } catch (err) {
    console.error("GET admin settings error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= GET ONE SETTING =================
router.get("/:key", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const spec = KNOWN_KEYS[req.params.key];
    if (!spec) {
      return res.status(404).json({ error: `Unknown setting key "${req.params.key}"` });
    }
    const row = await AdminSetting.findOne({ key: req.params.key }).lean();
    res.json({ setting: view(req.params.key, spec, row) });
  } catch (err) {
    console.error("GET admin setting error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= SET A SETTING =================
// Upsert. Unknown keys are refused (400) and values are type-checked
// against the registry (400) — staff can only set what the code reads.
// Management only (Nov 2026): the registry holds selling switches too.
router.put("/:key", authMiddleware, adminMiddleware, requireManagement, async (req, res) => {
  try {
    const key = req.params.key;
    const spec = KNOWN_KEYS[key];
    if (!spec) {
      return res.status(400).json({ error: `Unknown setting key "${key}"` });
    }
    const body = req.body || {};
    if (!Object.prototype.hasOwnProperty.call(body, "value")) {
      return res.status(400).json({ error: "value is required" });
    }
    const { value, error } = validateValue(spec, body.value);
    if (error) {
      return res.status(400).json({ error: `Setting "${key}" ${error}` });
    }

    const existing = await AdminSetting.findOne({ key });
    const row = await AdminSetting.findOneAndUpdate(
      { key },
      {
        $set: {
          module: spec.module,
          value,
          valueType: spec.valueType,
          description: spec.description,
          updatedBy: String(req.user?.email || req.user?.name || ""),
        },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    recordAudit(req, existing ? "update" : "create", "setting", key,
      `${existing ? "Updated" : "Set"} setting ${key}`, { module: spec.module });
    res.json({ setting: view(key, spec, row.toObject()) });
  } catch (err) {
    console.error("PUT admin setting error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

export default router;
