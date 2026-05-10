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

test("wraps SID variants in colored spans with display name", async () => {
  const { renderWithSpeakerTokens } = await import("../../dist/renderer/speaker-substitute.js");
  const html = renderWithSpeakerTokens("S1 said hi to S2", [
    { id: "S1", name: "Peter", color: "#79c0ff" },
    { id: "S2", name: null, color: "#e3b341" },
  ]);
  assert.match(html, /<span class="spkref" data-spk="S1" style="color:#79c0ff;font-weight:600">Peter<\/span> said hi to <span class="spkref" data-spk="S2" style="color:#e3b341;font-weight:600">S2<\/span>/);
});

test("html-escapes the input before wrapping", async () => {
  const { renderWithSpeakerTokens } = await import("../../dist/renderer/speaker-substitute.js");
  const html = renderWithSpeakerTokens('S1 said "<hi>"', [{ id: "S1", name: "Peter", color: "#79c0ff" }]);
  assert.ok(html.includes("&lt;hi&gt;"));
  assert.ok(html.includes("&quot;"));
  assert.ok(html.includes(">Peter</span>"));
});

test("also wraps bare user-name occurrences", async () => {
  const { renderWithSpeakerTokens } = await import("../../dist/renderer/speaker-substitute.js");
  const html = renderWithSpeakerTokens("Peter mentioned scaling laws", [
    { id: "S1", name: "Peter", color: "#79c0ff" },
  ]);
  assert.ok(html.includes('<span class="spkref" data-spk="S1" style="color:#79c0ff;font-weight:600">Peter</span> mentioned'));
});

test("empty registry returns escaped text only", async () => {
  const { renderWithSpeakerTokens } = await import("../../dist/renderer/speaker-substitute.js");
  assert.equal(renderWithSpeakerTokens("hello <world>", []), "hello &lt;world&gt;");
});

test("name with regex metacharacters is treated literally", async () => {
  const { renderWithSpeakerTokens } = await import("../../dist/renderer/speaker-substitute.js");
  const html = renderWithSpeakerTokens("Dr. O'Hara spoke", [{ id: "S1", name: "Dr. O'Hara", color: "#79c0ff" }]);
  assert.ok(html.includes(">Dr. O&#39;Hara</span>") || html.includes(">Dr. O'Hara</span>"));
});
