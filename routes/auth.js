import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import axios from "axios";

import User from "../models/User.js";
import { sendResetPasswordEmail } from "../services/emailService.js";
import { makeLimiter } from "../services/ticketAccess.js";
import Attendee from "../models/Attendee.js";
import { withCheckoutProfile } from "../services/onboardingProfile.js";

// Request bodies are untrusted: only plain strings reach a query (no {"$ne": …}).
const cleanEmail = (v) => (typeof v === "string" ? v.trim().toLowerCase().slice(0, 200) : "");
const loginPerIp = makeLimiter({ max: 30, windowMs: 15 * 60 * 1000 });
const loginPerEmail = makeLimiter({ max: 8, windowMs: 15 * 60 * 1000 });
const BAD_LOGIN = "Incorrect email or password.";
// The website's Google client is public (it's in the page source); the env list
// adds the apps' clients. Tokens minted for any other app are refused.
const WEB_GOOGLE_CLIENT_ID = "676399067827-8rri9ibgjqonjfs5ov6laul096rj1m7o.apps.googleusercontent.com";

const router = express.Router();

/* ================= REGISTER ================= */

router.post("/register", async (req, res) => {
  try {

    // Everyone who registers is an attendee. Staff are only ever made from the
    // admin panel (Staff accounts), never by whatever a request asks for.
    const name = typeof req.body?.name === "string" ? req.body.name.trim().slice(0, 120) : "";
    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;
    if (!name || !email || typeof password !== "string" || password.length < 6) {
      return res.status(400).json({ error: "Name, email and a password of at least 6 characters are required" });
    }

    const existingUser = await User.findOne({ email });

    if (existingUser) {
      return res.status(400).json({ error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await User.create({
      name,
      email,
      password: hashedPassword,
      provider: "local",
      role: "user"
    });

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });

  } catch (err) {

    console.error("REGISTER ERROR:", err);
    res.status(500).json({ error: "Registration failed" });

  }
});


/* ================= LOGIN ================= */

router.post("/login", async (req, res) => {

  try {

    const email = cleanEmail(req.body?.email);
    const password = req.body?.password;
    if (!email || typeof password !== "string" || !password) {
      return res.status(400).json({ error: BAD_LOGIN });
    }
    // Slow down password guessing (per address and per account).
    if (!loginPerIp.hit(`ip:${req.ip}`) || !loginPerEmail.hit(`e:${email}`)) {
      return res.status(429).json({ error: "Too many sign-in attempts. Please wait 15 minutes and try again." });
    }

    const user = await User.findOne({ email });

    // One message for "no account" and "wrong password" so emails can't be probed.
    const validPassword = !!user?.password && await bcrypt.compare(password, user.password);
    if (!user || !validPassword) {
      return res.status(400).json({ error: BAD_LOGIN });
    }
    loginPerEmail.reset(`e:${email}`);

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });

  } catch (err) {

    console.error("LOGIN ERROR:", err);
    res.status(500).json({ error: "Login failed" });

  }
});


/* ================= GET CURRENT USER ================= */

router.get("/me", async (req, res) => {

  try {

    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];

    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const user = await User.findById(decoded.id).select("-password -resetPasswordToken -resetPasswordExpires");

    if (!user) {
      return res.status(401).json({ error: "Invalid token" });
    }

    // Fill profile gaps from the website checkout answers (incl. guest tickets
    // they've since claimed) so the apps never ask for them twice.
    const claimed = await Attendee.find({ claimedBy: user._id, details: { $exists: true } }).select("details purchaseDate").lean();
    res.json(withCheckoutProfile(user.toObject(), claimed));

  } catch (err) {

    res.status(401).json({ error: "Invalid token" });

  }
});


/* ================= GOOGLE LOGIN ================= */

router.post("/google", async (req, res) => {

  try {

    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: "credential required" });

    const googleRes = await axios.get(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(credential)}`
    );

    const { email, name, aud, email_verified } = googleRes.data;

    // Only tokens minted for our own OAuth clients (website + apps). Without
    // this, a token any other app collected for the person would sign them in.
    // GOOGLE_CLIENT_IDS (comma-separated) adds the app clients.
    const allowed = [WEB_GOOGLE_CLIENT_ID, ...(process.env.GOOGLE_CLIENT_IDS || "").split(",")]
      .map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(aud)) {
      console.error("GOOGLE AUTH: token audience not allowed:", aud);
      return res.status(401).json({ error: "Google token not issued for this app" });
    }
    if (email_verified === "false" || email_verified === false || !email) {
      return res.status(401).json({ error: "Google email not verified" });
    }

    let user = await User.findOne({ email: String(email).toLowerCase() });

    if (!user) {

      user = await User.create({
        name,
        email,
        provider: "google"
      });

    }

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    res.json({ token });

  } catch (err) {

    console.error("GOOGLE AUTH ERROR:", err);
    res.status(500).json({ error: "Google login failed" });

  }

});


/* ================= LINKEDIN AUTH ================= */

router.get("/linkedin", (req, res) => {

  const state = crypto.randomBytes(16).toString("hex");

  const linkedinAuthURL =
    "https://www.linkedin.com/oauth/v2/authorization" +
    "?response_type=code" +
    `&client_id=${process.env.LINKEDIN_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(process.env.LINKEDIN_REDIRECT_URI)}` +
     "&scope=openid%20profile%20email" +
    `&state=${state}`;
console.log("LinkedIn auth URL:", linkedinAuthURL);
  res.redirect(linkedinAuthURL);

});


router.get("/linkedin/callback", async (req, res) => {

  console.log("LinkedIn callback query:", req.query);

  try {

    const { code } = req.query;

    if (!code) {
      console.error("LinkedIn OAuth failed: missing code");
      return res.redirect(`${process.env.FRONTEND_URL}/auth-error`);
    }

    /* ===== Exchange authorization code for access token ===== */

    const tokenRes = await axios.post(
      "https://www.linkedin.com/oauth/v2/accessToken",
      new URLSearchParams({
        grant_type: "authorization_code",
        code: code,
        redirect_uri: process.env.LINKEDIN_REDIRECT_URI,
        client_id: process.env.LINKEDIN_CLIENT_ID,
        client_secret: process.env.LINKEDIN_CLIENT_SECRET
      }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const accessToken = tokenRes.data.access_token;

    /* ===== Get LinkedIn user info (OpenID endpoint) ===== */

    const userInfoRes = await axios.get(
      "https://api.linkedin.com/v2/userinfo",
      {
        headers: {
          Authorization: `Bearer ${accessToken}`
        }
      }
    );

    const { name, email } = userInfoRes.data;

    /* ===== Find or create user ===== */

    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name,
        email,
        provider: "linkedin"
      });
    }

    /* ===== Create JWT ===== */

    const token = jwt.sign(
      { id: user._id, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    /* ===== Redirect to frontend ===== */

    res.redirect(`${process.env.FRONTEND_URL}/auth-success?token=${token}`);

  } catch (err) {

    console.error(
      "LinkedIn OAuth Error:",
      err.response?.data || err.message
    );

    res.redirect(`${process.env.FRONTEND_URL}/auth-error`);

  }

});
/* ================= UPDATE PROFILE ================= */

router.put("/profile", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { name, email } = req.body;

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (name) user.name = name;
    if (email) {
      const emailExists = await User.findOne({ email, _id: { $ne: user._id } });
      if (emailExists) {
        return res.status(400).json({ error: "Email already in use" });
      }
      user.email = email.toLowerCase();
    }

    await user.save();

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
    });
  } catch (err) {
    console.error("PROFILE UPDATE ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= CHANGE PASSWORD ================= */

router.put("/change-password", async (req, res) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({ error: "Unauthorized" });
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      return res.status(400).json({ error: "Current and new password required" });
    }

    const user = await User.findById(decoded.id);

    if (!user) {
      return res.status(404).json({ error: "User not found" });
    }

    if (user.provider !== "local") {
      return res.status(400).json({ error: "Password change not available for OAuth accounts" });
    }

    const validPassword = await bcrypt.compare(currentPassword, user.password);

    if (!validPassword) {
      return res.status(400).json({ error: "Current password is incorrect" });
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    user.password = hashedPassword;
    await user.save();

    res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    console.error("CHANGE PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= FORGOT PASSWORD ================= */

router.post("/forgot-password", async (req, res) => {

  try {

    const email = cleanEmail(req.body?.email);

    const user = email ? await User.findOne({ email }) : null;

    if (!user) {
      return res.json({
        message: "If that email exists, a reset link has been sent."
      });
    }

    const token = crypto.randomBytes(32).toString("hex");

    user.resetPasswordToken = token;
    user.resetPasswordExpires = Date.now() + 3600000;

    await user.save();

    const resetLink = `${process.env.FRONTEND_URL}/reset-password/${token}`;

    await sendResetPasswordEmail(user.email, resetLink);

    res.json({ message: "If that email exists, a reset link has been sent." });

  } catch (err) {

    console.error("FORGOT PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });

  }

});


/* ================= RESET PASSWORD ================= */

router.post("/reset-password/:token", async (req, res) => {

  try {

    const { token } = req.params;
    const { password } = req.body;

    const user = await User.findOne({
      resetPasswordToken: token,
      resetPasswordExpires: { $gt: Date.now() }
    });

    if (!user) {
      return res.status(400).json({ error: "Invalid or expired token" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    user.password = hashedPassword;
    user.resetPasswordToken = undefined;
    user.resetPasswordExpires = undefined;

    await user.save();

    res.json({ message: "Password reset successful" });

  } catch (err) {

    console.error("RESET PASSWORD ERROR:", err);
    res.status(500).json({ error: "Server error" });

  }

});

/* (The temporary PUT /set-role route was removed: it let any token that claimed
   "admin" hand out admin rights. Staff are managed in the admin panel.) */

export default router;
