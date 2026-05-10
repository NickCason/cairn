// Pure helpers for variant-aware speaker-id substitution and HTML escaping.
// Mirrors cairn_svc/summarize.py:substitute_speaker_variants so client and
// server agree on what counts as a speaker token.

const VARIANT_PREFIXES = [
  "S",
  "P",
  "S\\s+",
  "P\\s+",
  "Speaker\\s*",
  "Speaker_",
  "Person\\s*",
  "Person_",
  "Spkr\\s*",
  "Spkr_",
  "speaker_",
  "person_",
  "spkr_",
];

export function substituteSpeakerVariants(text: string, sid: string, replacement: string): string {
  const m = sid.match(/^[A-Za-z]+(\d+)$/);
  if (!m) return text;
  const digit = m[1];
  const alternation = VARIANT_PREFIXES.join("|");
  // Note: trailing lookahead is (?![A-Za-z0-9]) — stricter than svc's
  // (?![0-9]). Cairn's SIDs are always letter-prefix + digits (e.g. S1, S2,
  // M3); they never carry alpha suffixes, so being strict here just rules
  // out false positives like "S1A" without losing any real match. If a
  // future SID scheme uses alpha suffixes, both this regex and the svc one
  // need updating in lockstep.
  const re = new RegExp(`(?<![A-Za-z0-9_])(?:${alternation})${digit}(?![A-Za-z0-9])`, "gi");
  return text.replace(re, replacement);
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
