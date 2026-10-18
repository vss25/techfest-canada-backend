import { overridesContact } from "./appRights.js";

/* Who may contact whom 1:1 in the app. Each person's receive rights
   (receiveMessages / receiveRequests) come from their types and the staff
   switches User.messagesOff / User.requestsOff (services/appRights.js).
   Pure rules, used by routes/social.js; unit-tested in
   test/contact-switches.test.js and test/app-rights.test.js.
   Group chats and in-person (badge scan) connections are not affected.

   `targetRights` / `recipientRights` / `senderRights` are effectiveRights()
   objects; left out, only the switches count (no type limits) and only staff
   accounts override. */

const fromSwitches = (u) => ({ receiveMessages: !u?.messagesOff, receiveRequests: !u?.requestsOff });

/** Can `sender` start a new connection request to `target`?
    Existing pending/accepted rows are untouched (the route only asks this before creating one).
    The sender's own sendRequests right is checked separately by the route. */
export function canRequest({ sender, target, senderRights = null, targetRights = null } = {}) {
  const tr = targetRights || fromSwitches(target);
  if (tr.receiveRequests) return true;
  return overridesContact(sender, senderRights);
}

/** Can `sender` send a 1:1 message to `recipient`?
    Without receiveMessages, only staff / moderators, accepted connections, or someone the recipient wrote to first. */
export function canMessage({ sender, recipient, senderRights = null, recipientRights = null, connected = false, theyWroteFirst = false } = {}) {
  const rr = recipientRights || fromSwitches(recipient);
  if (rr.receiveMessages) return true;
  return overridesContact(sender, senderRights) || !!connected || !!theyWroteFirst;
}

/** acceptsMessages / acceptsRequests on a card, as seen by `viewer`: false only
    when the person can't be contacted that way and the server would refuse this viewer. */
export function contactFlags({ viewer, user, viewerRights = null, userRights = null, connected = false, theyWroteFirst = false } = {}) {
  return {
    acceptsMessages: canMessage({ sender: viewer, recipient: user, senderRights: viewerRights, recipientRights: userRights, connected, theyWroteFirst }),
    acceptsRequests: canRequest({ sender: viewer, target: user, senderRights: viewerRights, targetRights: userRights }),
  };
}

// Leading honorifics, so "Hon. Jane Doe" reads as "Jane" in the error.
const HONORIFIC = /^(?:the|rt\.?|right|hon\.?|honourable|honorable|dr\.?|mr\.?|mrs\.?|ms\.?|mx\.?|prof\.?|sir|dame)\s+/i;

/** First name for an error line ("" when there's no usable name). */
export function contactFirstName(user) {
  let n = String(user?.name || "").trim().replace(/\s+/g, " ");
  for (let i = 0; i < 4 && HONORIFIC.test(n); i++) n = n.replace(HONORIFIC, "");
  if (!n || /^guest$/i.test(n)) return "";
  return n.split(" ")[0];
}

const who = (user) => contactFirstName(user) || "This person";

export const requestsOffError = (target) => `${who(target)} isn't taking connection requests in the app.`;
export const messagesOffError = (recipient) => `${who(recipient)} isn't taking messages in the app.`;
