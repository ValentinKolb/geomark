/**
 * Tiny RFC-4180-ish CSV writer. Handles quoting of fields that contain
 * commas, double quotes, or newlines. Null/empty becomes an empty field.
 */

const NEEDS_QUOTE = /[,"\n\r]/;

export const csvEscape = (s: string | null | undefined): string => {
  if (s === null || s === undefined || s === "") return "";
  if (NEEDS_QUOTE.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

export const csvRow = (cols: (string | null | undefined)[]): string =>
  cols.map(csvEscape).join(",") + "\n";

/**
 * Parse a single CSV line into fields. Handles RFC-4180 quoting:
 *   - Commas separate fields
 *   - Double quotes wrap a field
 *   - "" inside a quoted field becomes a literal "
 *
 * STRICT: throws on an unclosed quote at end of line. We don't support
 * newlines inside quoted fields — if you see this error, either your CSV
 * has multi-line records (handle them with a record-level parser before
 * calling this) or the source data is malformed.
 */
export const parseCsvLine = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  if (inQuotes) {
    throw new Error(
      `unterminated quoted CSV field — multiline records are not supported: ${JSON.stringify(line.slice(0, 80))}`,
    );
  }
  out.push(cur);
  return out;
};

/**
 * Build a column-name → index lookup from a CSV header line. Names are
 * uppercased so callers can use `idx.get("LON")` regardless of source casing.
 */
export const parseCsvHeader = (line: string): Map<string, number> => {
  const map = new Map<string, number>();
  parseCsvLine(line).forEach((name, i) => {
    map.set(name.trim().toUpperCase(), i);
  });
  return map;
};
