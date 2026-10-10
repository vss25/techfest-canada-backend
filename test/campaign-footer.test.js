import { test } from "node:test";
import assert from "node:assert/strict";

test("campaign footer shows the postal address when it's configured, escaped", async () => {
  process.env.RESEND_API_KEY ||= "re_test_stub";
  const { campaignSenderLine } = await import("../services/emailService.js");
  assert.equal(campaignSenderLine({}), "The Tech Festival Canada • Toronto, Ontario");
  assert.equal(
    campaignSenderLine({ MAIL_POSTAL_ADDRESS: " AtlasLink <Markets> & Co, Toronto, ON " }),
    "The Tech Festival Canada • AtlasLink &lt;Markets&gt; &amp; Co, Toronto, ON",
  );
});
