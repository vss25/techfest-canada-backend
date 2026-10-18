/* Staff "contact switches" on a person (User.messagesOff / User.requestsOff),
   for VIPs such as ministers who won't reply in the app. Pure rules, used by
   routes/social.js; unit-tested in test/contact-switches.test.js.
   Group chats and in-person (badge scan) connections are not affected. */

const isStaff = (u) => u?.role === "admin";

/** Can `sender` start a new connection request to `target`?
    Existing pending/accepted rows are untouched (the route only asks this before creating one). */
export function canRequest({ sender, target } = {}) {
  if (!target?.requestsOff) return true;
  return isStaff(sender);
}

/** Can `sender` send a 1:1 message to `recipient`?
    With messages off, only staff, accepted connections, or someone the recipient wrote to first. */
export function canMessage({ sender, recipient, connected = false, theyWroteFirst = false } = {}) {
  if (!recipient?.messagesOff) return true;
  return isStaff(sender) || !!connected || !!theyWroteFirst;
}

/** acceptsMessages / acceptsRequests on a card, as seen by `viewer`: false only
    when the person's switch is on and the server would refuse this viewer. */
export function contactFlags({ viewer, user, connected = false, theyWroteFirst = false } = {}) {
  return {
    acceptsMessages: canMessage({ sender: viewer, recipient: user, connected, theyWroteFirst }),
    acceptsRequests: canRequest({ sender: viewer, target: user }),
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
