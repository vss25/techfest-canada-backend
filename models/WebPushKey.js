import mongoose from "mongoose";

/* The server's VAPID key pair for Web Push (services/webPush.js), made once and kept forever, so
   the organiser never has to set anything up (env VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY win when
   both are set). One row, _id "vapid": the _id index makes the first-start race safe on every
   server at once. The private key is select: false and never leaves services/webPush.js: no
   answer carries it and nothing logs it. */
const webPushKeySchema = new mongoose.Schema({
  _id:        { type: String },
  publicKey:  { type: String, required: true },
  privateKey: { type: String, required: true, select: false },
}, { timestamps: true });

export default mongoose.model("WebPushKey", webPushKeySchema);
