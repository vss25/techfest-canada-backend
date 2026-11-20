import mongoose from "mongoose";

/* One planned thing on the content calendar (services/contentCalendar.js). Private: MongoDB only. */
const schema = new mongoose.Schema({
  title: { type: String, required: true, maxlength: 200 },
  date: { type: String, required: true },          // planned day, "YYYY-MM-DD"
  channel: { type: String, default: "Other" },
  by: { type: String, default: "" },               // "" = TTFC; else the partner who posts or sends it
  ownerName: { type: String, default: "" },
  notes: { type: String, default: "" },
  eventKey: { type: String, default: "" },
  doneDate: { type: String, default: "" },         // the day it actually went out
  doneUrl: { type: String, default: "" },
  doneByName: { type: String, default: "" },       // the staff member who marked it
  source: { type: String, default: "manual" },     // manual | upload
  batch: { type: String, default: "" },            // one id per uploaded sheet, so an upload can be undone
  createdByName: { type: String, default: "" },
}, { timestamps: true, versionKey: false });
schema.index({ date: 1 });
schema.index({ batch: 1 });

export default mongoose.models.CalendarItem || mongoose.model("CalendarItem", schema);
