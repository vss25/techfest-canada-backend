import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import { SocialPost } from "../models/Social.js";
import CompanyLogo from "../models/CompanyLogo.js";
import { decodeDataUrl } from "../services/socialHelpers.js";

/* =========================================================
   /api/files — photos the app shows with a plain image URL.
   GET /api/files/post/:postId     a feed post's photo
   GET /api/files/avatar/:userId   a profile photo (?v= busts caches)
   GET /api/files/company-logo/:id a company logo kept in the database
                                   (services/logoStore.js, when neither
                                   Cloudinary nor Sanity is configured)
   IDs are unguessable ObjectIds; hidden posts and suspended
   people return 404.
========================================================= */

const router = express.Router();

function send(res, dataUrl, maxAge) {
  const img = decodeDataUrl(dataUrl);
  if (!img) return res.status(404).end();
  res.set("Content-Type", img.contentType);
  res.set("Cache-Control", `public, max-age=${maxAge}`);
  res.send(img.buffer);
}

router.get("/post/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  const post = await SocialPost.findById(req.params.id).select("imageData status").lean();
  if (!post || post.status === "hidden" || !post.imageData) return res.status(404).end();
  send(res, post.imageData, 86400);
});

router.get("/avatar/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  const user = await User.findById(req.params.id).select("+avatarData banned").lean();
  if (!user || user.banned || !user.avatarData) return res.status(404).end();
  send(res, user.avatarData, req.query.v ? 31536000 : 300);
});

// One row per image (content-addressed), so it can be cached for good. SVGs can't run scripts:
// the CSP allows nothing but inline styles and data: images.
router.get("/company-logo/:id", async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) return res.status(404).end();
  // Not lean: a hydrated document gives the bytes as a Buffer.
  const logo = await CompanyLogo.findById(req.params.id).select("contentType data");
  if (!logo?.data?.length) return res.status(404).end();
  res.set("Content-Type", logo.contentType);
  res.set("Cache-Control", "public, max-age=31536000, immutable");
  res.set("X-Content-Type-Options", "nosniff");
  res.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.set("Cross-Origin-Resource-Policy", "cross-origin");
  res.send(Buffer.from(logo.data));
});

export default router;
