const REGIONAL_A = 0x1f1e6;
const ASCII_A = 0x41;

/**
 * Convert a 2-letter ISO country code to its flag emoji.
 * "DE" → "🇩🇪", "us" → "🇺🇸". Returns empty string for non 2-letter input.
 */
export const countryFlagEmoji = (code: string): string => {
  if (code.length !== 2) return "";
  const upper = code.toUpperCase();
  const a = upper.charCodeAt(0) - ASCII_A;
  const b = upper.charCodeAt(1) - ASCII_A;
  if (a < 0 || a > 25 || b < 0 || b > 25) return "";
  return String.fromCodePoint(REGIONAL_A + a, REGIONAL_A + b);
};
