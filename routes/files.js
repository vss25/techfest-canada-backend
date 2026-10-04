import express from "express";
import mongoose from "mongoose";
import User from "../models/User.js";
import { SocialPost } from "../models/Social.js";
import { decodeDataUrl } from "../services/socialHelpers.js";

/* =========================================================
   /api/files — photos the app shows with a plain image URL.
   GET /api/files/post/:postId     a feed post's photo
   GET /api/files/avatar/:userId   a profile photo (?v= busts caches)
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

export default router;
