// Static model-id → hard context-window map.
// Source: each vendor's published docs. Hard ctx only — no soft caps.
// Match is prefix-by-regex; first hit wins, so order matters
// (more-specific patterns must precede broader ones).
//
// All patterns use the /i flag so capitalisation variants (e.g. `GLM-4.7`)
// match the same as their lowercase form.
//
// When a node's `model` field doesn't match, callers fall back to
// `session.summary.peak_context_tokens` as the 100% denominator.
const TABLE: Array<[RegExp, number]> = [
  // Opus 4.6+ ships with a 1M-token context window by default.
  // Match minor version >= 6 (covers 4-6, 4-7, ..., 4-10, ...).
  [/^claude-opus-4-([6-9]|\d{2,})/i, 1_000_000],
  [/^claude-(opus|sonnet)-4/i,         200_000],
  [/^claude-haiku-4/i,                 200_000],
  [/^claude-3-7/i,             200_000],
  [/^claude-3-5/i,             200_000],
  [/^claude-3/i,               200_000],
  [/^gpt-4o/i,                 128_000],
  [/^gpt-4-turbo/i,            128_000],
  [/^gpt-4/i,                   32_768],
  [/^o1-(preview|mini)/i,      128_000],
  [/^o1/i,                     200_000],
  [/^gpt-3\.5/i,                16_385],
  // Zhipu GLM. More-specific patches go above the bare-major fallback so
  // future models with different windows can be pinned without reshuffling.
  [/^glm-5\.1/i,               200_000],
  [/^glm-5/i,                  200_000],
  [/^glm-4\.7/i,               200_000],
];

export function lookupContextWindow(model: string | null | undefined): number | null {
  if (!model) return null;
  for (const [re, n] of TABLE) {
    if (re.test(model)) return n;
  }
  return null;
}
