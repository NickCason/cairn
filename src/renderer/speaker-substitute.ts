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

export type SpeakerInfo = { id: string; name: string | null; color: string };

const REGEX_META = /[.*+?^${}()|[\]\\]/g;
function escapeRegex(s: string): string {
  return s.replace(REGEX_META, "\\$&");
}

/**
 * HTML-escape ``text``, then for each speaker in ``registry`` wrap every
 * variant of its SID (and, if the speaker has a user-assigned name, every
 * bare occurrence of the name) in a colored <span class="spkref">. Returns
 * safe HTML.
 *
 * Two-pass to avoid double-wrapping:
 *   1. Substitute SID variants → wrapped spans.
 *   2. For each named speaker, split the result on existing .spkref span
 *      boundaries and only apply name-substitution to the non-span chunks.
 */
export function renderWithSpeakerTokens(text: string, registry: SpeakerInfo[]): string {
  let out = escapeHtml(text);

  // Pass 1: SID variants → spans.
  for (const spk of registry) {
    const display = spk.name ?? spk.id;
    const span = `<span class="spkref" data-spk="${spk.id}" style="color:${spk.color};font-weight:600">${escapeHtml(display)}</span>`;
    out = substituteSpeakerVariants(out, spk.id, span);
  }

  // Pass 2: bare user-name occurrences → spans, skipping inside existing spans.
  for (const spk of registry) {
    if (!spk.name) continue;
    const span = `<span class="spkref" data-spk="${spk.id}" style="color:${spk.color};font-weight:600">${escapeHtml(spk.name)}</span>`;
    const nameRe = new RegExp(`(?<![A-Za-z0-9_])${escapeRegex(escapeHtml(spk.name))}(?![A-Za-z0-9_])`, "gi");
    const parts = out.split(/(<span class="spkref"[^>]*>[^<]*<\/span>)/g);
    out = parts
      .map((p) => (p.startsWith('<span class="spkref"') ? p : p.replace(nameRe, span)))
      .join("");
  }

  return out;
}
