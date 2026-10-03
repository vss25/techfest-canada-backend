import test from "node:test";
import assert from "node:assert/strict";
import { threadKey, bestTierKey, tierName, userCard, postDTO, tally, cleanImageData } from "../services/socialHelpers.js";

test("threadKey is order-independent", () => {
  assert.equal(threadKey("b", "a"), threadKey("a", "b"));
  assert.equal(threadKey("a", "b"), "a:b");
});

test("bestTierKey picks the highest ticket", () => {
  assert.equal(bestTierKey({ tickets: [{ type: "connect" }, { type: "power" }, { type: "discover" }] }), "power");
  assert.equal(bestTierKey({ tickets: [] }), "");
  assert.equal(tierName("influence"), "Influence Pass");
});

test("userCard never leaks email or role", () => {
  const c = userCard({ _id: "1", name: "A", email: "a@x.com", role: "admin", jobTitle: "CTO", tickets: [{ type: "connect" }] });
  assert.equal(c.name, "A");
  assert.equal(c.tier, "Connect Pass");
  assert.equal("email" in c, false);
  assert.equal("role" in c, false);
});

test("postDTO computes likedByMe", () => {
  const p = { _id: "p1", authorId: "u1", authorName: "A", body: "hi", likes: ["u2"], likeCount: 1, createdAt: new Date() };
  assert.equal(postDTO(p, "u2").likedByMe, true);
  assert.equal(postDTO(p, "u3").likedByMe, false);
});

test("tally ignores out-of-range options", () => {
  assert.deepEqual(tally([{ optionIndex: 0 }, { optionIndex: 2 }, { optionIndex: 9 }], 3), [1, 0, 1]);
});

test("cleanImageData rejects non-images and oversized payloads", () => {
  assert.equal(cleanImageData("data:text/html;base64,xx"), "");
  assert.equal(cleanImageData("data:image/jpeg;base64," + "a".repeat(10), 100), "data:image/jpeg;base64," + "a".repeat(10));
  assert.equal(cleanImageData("data:image/jpeg;base64," + "a".repeat(1000), 100), "");
});
