const TABLE: Array<[RegExp, number]> = [
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
  [/^glm-5\.1/i,               200_000],
  [/^glm-5/i,                  200_000],
  [/^cac-glm-4\.7-cj/i,        128_000],
  [/^glm-4\.7/i,               200_000],
  [/^deepseek-v4/i,            1_000_000],
];

export function lookupContextWindow(model: string | null | undefined): number | null {
  if (!model) return null;
  for (const [re, n] of TABLE) {
    if (re.test(model)) return n;
  }
  return null;
}
