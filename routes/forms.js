import express from "express";
import FormSubmission from "../models/FormSubmission.js";
import { sendFormSubmissionEmail } from "../services/emailService.js";
import { makeFormSubmitHandler } from "../services/formSubmitHandler.js";

/* =========================================================
   Website forms — mounted at /api/forms
   POST /api/forms/:form   form = volunteer | speaker | exhibit | sponsor | partnership | inquiry
     { name? | firstName + lastName, email, phone?, company?, jobTitle?, message?,
       fields?: { …anything else the form collects }, page?, referrer?, _hp, elapsedMs }
   ---------------------------------------------------------
   Saved first (FormSubmission), answered 201 straight away, then
   emailed in the background to FORMS_INBOX (default
   baldeep@thetechfestival.com) with reply-to set to the visitor.
   Replaces EmailJS. Staff list: Admin → Leads → Form submissions
   (routes/console.js). Logic: services/formSubmitHandler.js and
   services/formSubmissions.js.
========================================================= */

const router = express.Router();

const site = String(process.env.FRONTEND_URL || "https://www.thetechfestival.com").replace(/\/+$/, "");

router.post("/:form", makeFormSubmitHandler({
  save: (doc) => FormSubmission.create(doc),
  update: (id, set) => FormSubmission.updateOne({ _id: id }, { $set: set }),
  send: (msg) => sendFormSubmissionEmail(msg),
  adminUrl: `${site}/admin/form-submissions`,
}));

export default router;
