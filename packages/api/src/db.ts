/** Quote a value for a Postgres array literal (text-array, "{...}") */
const quoteForTextArray = (s: string): string =>
  `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

export const toPgTextArray = (xs: readonly string[]): string =>
  `{${xs.map(quoteForTextArray).join(",")}}`;
