import mongoose from "mongoose";

/* One row per background job that must run on one server at a time
   (services/sessionGroups.js): a server takes the job by moving `until`
   forward while it's in the past, in one atomic update, so with several
   servers on Render each run happens once. `owner` says which process
   holds it (for the logs only). */
const jobLockSchema = new mongoose.Schema({
  _id: { type: String },          // the job's name, e.g. "session-groups"
  until: { type: Date, required: true },
  owner: { type: String, default: "" },
}, { timestamps: true, versionKey: false });

export default mongoose.models.JobLock || mongoose.model("JobLock", jobLockSchema);
