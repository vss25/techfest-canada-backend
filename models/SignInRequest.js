import mongoose from "mongoose";

/* One "email me a sign-in link" request (routes/emailLink.js).
   Only hashes are stored. Mongo deletes the row once expiresAt passes
   (TTL index), so used and stale requests clean themselves up. */
const signInRequestSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, lowercase: true, index: true },
    tokenHash: { type: String, required: true, unique: true },
    codeHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    attempts: { type: Number, default: 0 },
    // pending → used | replaced (a newer link was sent) | locked (too many wrong codes)
    status: { type: String, enum: ["pending", "used", "replaced", "locked"], default: "pending" },
    usedAt: { type: Date },
    client: { type: String, default: "web" }, // ios | android | web — where it was requested
    ip: { type: String, default: "" },
  },
  { timestamps: true }
);

signInRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const SignInRequest = mongoose.model("SignInRequest", signInRequestSchema);

export default SignInRequest;
