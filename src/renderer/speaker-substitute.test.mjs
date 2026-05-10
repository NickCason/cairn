import { test } from "node:test";
import assert from "node:assert/strict";
import { substituteSpeakerVariants, escapeHtml } from "../../dist/renderer/speaker-substitute.js";

test("replaces S1 with name", () => {
  assert.equal(substituteSpeakerVariants("S1 said hello", "S1", "Peter"), "Peter said hello");
});

test("replaces all SID variants case-insensitively", () => {
  for (const variant of ["S1", "s1", "P1", "p1", "Speaker 1", "Speaker_1", "Spkr 1", "Spkr_1", "Person 1", "Person_1"]) {
    assert.equal(
      substituteSpeakerVariants(`${variant} mentioned`, "S1", "Peter"),
      "Peter mentioned",
      `failed on variant '${variant}'`,
    );
  }
});

test("does not match S10 or S1A", () => {
  assert.equal(substituteSpeakerVariants("S10 said S1A is", "S1", "Peter"), "S10 said S1A is");
});

test("does not match inside a word", () => {
  assert.equal(substituteSpeakerVariants("CASS1ON", "S1", "Peter"), "CASS1ON");
});

test("idempotent on already-substituted text", () => {
  const once = substituteSpeakerVariants("S1 spoke", "S1", "Peter");
  const twice = substituteSpeakerVariants(once, "S1", "Peter");
  assert.equal(twice, once);
});

test("handles multiple sids in one call", () => {
  let t = "S1 and S2 talked";
  t = substituteSpeakerVariants(t, "S1", "Peter");
  t = substituteSpeakerVariants(t, "S2", "Elon");
  assert.equal(t, "Peter and Elon talked");
});

test("escapeHtml escapes the four core chars", () => {
  assert.equal(escapeHtml('<a href="x">a&b</a>'), "&lt;a href=&quot;x&quot;&gt;a&amp;b&lt;/a&gt;");
});
