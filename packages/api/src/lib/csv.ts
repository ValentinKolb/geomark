/**
 * Tiny RFC-4180 CSV line parser. Mirrors the writer in @geomark/data
 * (we don't depend on @geomark/data, so the parser is duplicated).
 *
 * STRICT: throws on unclosed quote at end of line — multi-line quoted
 * records are not supported. The data builder doesn't emit them.
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
      `unterminated quoted CSV field: ${JSON.stringify(line.slice(0, 80))}`,
    );
  }
  out.push(cur);
  return out;
};

/** Build a column-name → index map from the header line (uppercased keys). */
export const parseCsvHeader = (line: string): Map<string, number> => {
  const map = new Map<string, number>();
  parseCsvLine(line).forEach((name, i) => {
    map.set(name.trim().toUpperCase(), i);
  });
  return map;
};
