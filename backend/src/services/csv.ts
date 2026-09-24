import { parse } from "csv-parse/sync";

const EMAIL_RE = /^[^@\s,;]+@[^@\s,;]+\.[^@\s,;]+$/;

export function extractEmails(raw: string): string[] {
  let cells: string[] = [];

  try {
    const rows = parse(raw, {
      skip_empty_lines: true,
      relax_column_count: true,
      relax_quotes: true,
      bom: true,
    }) as string[][];
    cells = rows.flat();
  } catch {
    cells = raw.split(/[\r\n,;]+/);
  }

  const seen = new Set<string>();
  const out: string[] = [];

  for (const cell of cells) {
    const value = String(cell).trim().toLowerCase();
    if (!EMAIL_RE.test(value)) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }

  return out;
}
