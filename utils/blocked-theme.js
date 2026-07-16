/** Hard-reject meme themes by pool/token name keyword (case-insensitive substring). */

export const DEFAULT_BLOCKED_NAME_KEYWORDS = ["trump", "musk", "elon", "barron", "melania", "melani"];

export function findBlockedNameKeyword(text, keywords = DEFAULT_BLOCKED_NAME_KEYWORDS) {
  if (!text || !Array.isArray(keywords) || keywords.length === 0) return null;
  const hay = String(text).toLowerCase();
  for (const raw of keywords) {
    const needle = String(raw || "").trim().toLowerCase();
    if (needle && hay.includes(needle)) return needle;
  }
  return null;
}

export function getBlockedThemeRejectReason(fields = {}, keywords = DEFAULT_BLOCKED_NAME_KEYWORDS) {
  const candidates = [
    ["pool", fields.poolName || fields.name],
    ["symbol", fields.symbol],
    ["token", fields.tokenName],
  ];
  for (const [label, value] of candidates) {
    const hit = findBlockedNameKeyword(value, keywords);
    if (hit) return `blocked theme keyword "${hit}" in ${label} "${value}"`;
  }
  return null;
}