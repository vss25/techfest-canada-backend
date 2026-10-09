import express from "express";
import jwt from "jsonwebtoken";
import Lead from "../models/Lead.js";
import { generateLeadsFromApify, transformApifyLead } from "../services/apifyLeads.js";
import { requireAdmin } from "../middleware/adminAuth.js";

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

// The sales CRM is staff-only. Routes check the database, not the token's "role" claim, so
// removing someone's staff access takes effect immediately.
const adminMiddleware = (req, res, next) => requireAdmin(req, res, next);

// ================= GET ALL LEADS =================
router.get("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { page = 1, limit = 100, status, assignedTo, search } = req.query;
    
    const query = {};
    
    if (status && status !== "all") {
      query.status = String(status);
    }
    
    if (assignedTo) {
      if (assignedTo === "unassigned") {
        query.assignedTo = { $exists: false };
      } else {
        query.assignedTo = assignedTo;
      }
    }
    
    if (search) {
      // Escaped: a search is text, never a pattern (no ReDoS / operator tricks).
      const rx = new RegExp(String(search).slice(0, 100).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      query.$or = [{ leadName: rx }, { companyName: rx }, { email: rx }];
    }
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const [leads, total] = await Promise.all([
      Lead.find(query).sort({ createdAt: -1 }).skip(skip).limit(parseInt(limit)),
      Lead.countDocuments(query)
    ]);
    
    res.json({
      leads,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (err) {
    console.error("GET leads error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ================= CREATE LEAD =================
router.post("/", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const lead = new Lead(req.body);
    await lead.save();
    res.status(201).json(lead);
  } catch (err) {
    console.error("CREATE lead error:", err);
    res.status(500).json({ error: "Failed to create lead" });
  }
});

// ================= UPDATE LEAD =================
router.patch("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const lead = await Lead.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }
    res.json(lead);
  } catch (err) {
    console.error("UPDATE lead error:", err);
    res.status(500).json({ error: "Failed to update lead" });
  }
});

// ================= DELETE LEAD =================
router.delete("/:id", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const lead = await Lead.findByIdAndDelete(req.params.id);
    if (!lead) {
      return res.status(404).json({ error: "Lead not found" });
    }
    res.json({ success: true });
  } catch (err) {
    console.error("DELETE lead error:", err);
    res.status(500).json({ error: "Failed to delete lead" });
  }
});

// ================= BULK IMPORT =================
router.post("/bulk-import", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { leads } = req.body;
    
    if (!Array.isArray(leads) || leads.length === 0) {
      return res.status(400).json({ error: "No leads provided" });
    }
    
    const inserted = await Lead.insertMany(leads, { ordered: false });
    
    res.json({ imported: inserted.length });
  } catch (err) {
    console.error("BULK IMPORT error:", err);
    res.status(500).json({ error: "Failed to import leads" });
  }
});

// ================= BULK UPDATE =================
router.post("/bulk-update", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const { ids, updates } = req.body;
    
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: "No lead IDs provided" });
    }
    
    const result = await Lead.updateMany(
      { _id: { $in: ids } },
      { $set: updates }
    );
    
    res.json({ updated: result.modifiedCount });
  } catch (err) {
    console.error("BULK UPDATE error:", err);
    res.status(500).json({ error: "Failed to update leads" });
  }
});

// ================= GENERATE LEADS FROM APIFY =================
router.post("/generate", authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const {
      jobTitle,
      functionalLevel,
      companyDomain,
      companySize,
      contactLocation,
      contactCity,
      industry,
      fetchCount
    } = req.body;

    const filters = {
      personTitle: jobTitle ? [jobTitle] : [],
      seniority: [],
      functional: functionalLevel || [],
      companyEmployeeSize: companySize ? [companySize] : [],
      personCountry: contactLocation ? [contactLocation] : [],
      personState: [],
      companyCountry: contactLocation ? [contactLocation] : [],
      companyState: [],
      industry: industry ? [industry] : [],
      industryKeywords: [],
      revenue: [],
      businessModel: [],
      companyDomain: companyDomain ? [companyDomain] : [],
      totalResults: fetchCount || 5000,
      includeEmails: true,
    };

    console.log("🎯 Generating leads with filters:", JSON.stringify(filters, null, 2));

    const apifyLeads = await generateLeadsFromApify(filters);

    if (!apifyLeads || apifyLeads.length === 0) {
      return res.json({ generated: 0, message: "No leads found" });
    }

    const leadsToSave = apifyLeads.map(transformApifyLead);

    const inserted = await Lead.insertMany(leadsToSave, { ordered: false });

    console.log(`✅ Saved ${inserted.length} leads to database`);

    res.json({
      generated: inserted.length,
      message: `Successfully generated ${inserted.length} leads`
    });
  } catch (err) {
    console.error("GENERATE error:", err);
    res.status(500).json({ error: "Failed to generate leads: " + err.message });
  }
});

export default router;