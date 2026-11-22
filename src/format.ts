/** Plain-text output for people. Scripts should use `--json`: this format may change between versions. */

export type Cell = string | number | boolean | null | undefined;

/** Left-aligned columns separated by two spaces, with an upper-case header row. */
export function table(headers: string[], rows: Cell[][]): string {
  const text = [headers.map((h) => h.toUpperCase()), ...rows.map((row) => row.map(cell))];
  const widths = headers.map((_, i) => Math.max(...text.map((row) => width(row[i] ?? ""))));
  return text
    .map((row) =>
      row
        .map((value, i) => (i === row.length - 1 ? value : value + " ".repeat(widths[i]! - width(value))))
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
}

/** `key: value` lines with the keys aligned. Empty values are left out. */
export function fields(entries: [string, Cell][]): string {
  const shown = entries.filter(([, value]) => value !== undefined && value !== null && value !== "");
  const pad = Math.max(0, ...shown.map(([key]) => key.length)) + 1;
  return shown.map(([key, value]) => `${`${key}:`.padEnd(pad + 1)}${cell(value)}`).join("\n");
}

export function cell(value: Cell): string {
  if (value === null || value === undefined || value === "") return "-";
  if (typeof value === "boolean") return value ? "yes" : "no";
  return String(value);
}

/** One line of at most `max` characters, for a text column. */
export function oneLine(text: string | null | undefined, max = 48): string {
  const flat = (text ?? "").replace(/\s+/g, " ").trim();
  const chars = Array.from(flat);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : flat;
}

/** `2026-12-01 09:00 UTC`. Dates stay UTC so output does not depend on the machine's time zone. */
export function date(iso: string | null | undefined): string {
  if (!iso) return "-";
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return iso;
  return `${parsed.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function number(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return value.toLocaleString("en-US");
}

export function signed(value: number | null | undefined): string {
  if (value === null || value === undefined) return "-";
  return `${value > 0 ? "+" : ""}${value.toLocaleString("en-US")}`;
}

/** Footer for one page of a list. */
export function pageNote(
  pagination: { offset: number; total: number; hasMore: boolean },
  shown: number,
  noun: string,
  plural = `${noun}s`,
): string {
  if (!pagination.hasMore) return shown === 1 ? `1 ${noun}` : `${shown} ${plural}`;
  const from = pagination.offset + 1;
  const to = pagination.offset + shown;
  return `${from}-${to} of ${pagination.total} ${plural}. Next page: --offset ${to}, or --all for every one`;
}

/** Display width: wide characters (CJK, most emoji) take two columns. */
const WIDE_RANGES: [number, number][] = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0xa4cf], // CJK radicals to Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // full-width forms
  [0xffe0, 0xffe6],
  [0x20000, 0x3fffd], // CJK extensions
];
const EMOJI = /\p{Extended_Pictographic}/u;

function width(text: string): number {
  let total = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    total += EMOJI.test(char) || WIDE_RANGES.some(([from, to]) => code >= from && code <= to) ? 2 : 1;
  }
  return total;
}
