/**
 * A small CSV reader and writer for the hand-labelling sheet, which people open and save in
 * Excel. It writes RFC 4180 (quoting only where needed) and reads what Excel saves: a
 * byte-order mark, CRLF line ends and, in some locales, semicolons instead of commas.
 */

export type CsvDelimiter = "," | ";";
export type CsvCell = string | number | boolean | null | undefined;

/** One cell as written: quoted only when it holds the delimiter, a quote or a line break. */
export function csvCell(value: CsvCell, delimiter: CsvDelimiter = ","): string {
  const text = value === null || value === undefined ? "" : String(value);
  return text.includes(delimiter) || /["\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** One row, without a line end. A row of a single empty cell is written as "" so it reads back as a row. */
export function toCsvRow(cells: readonly CsvCell[], delimiter: CsvDelimiter = ","): string {
  if (cells.length === 1 && csvCell(cells[0], delimiter) === "") return '""';
  return cells.map((c) => csvCell(c, delimiter)).join(delimiter);
}

/** Whole rows, each ending with a line break. CRLF by default, as RFC 4180 and Excel expect. */
export function toCsv(
  rows: ReadonlyArray<readonly CsvCell[]>,
  { delimiter = ",", newline = "\r\n" }: { delimiter?: CsvDelimiter; newline?: string } = {},
): string {
  return rows.map((row) => toCsvRow(row, delimiter) + newline).join("");
}

/** The byte-order mark Excel puts at the start of "CSV UTF-8" files, and needs to read them as UTF-8. */
export const BOM = "\uFEFF";

export function stripBom(text: string): string {
  return text.startsWith(BOM) ? text.slice(BOM.length) : text;
}

/**
 * Comma or semicolon, judged from the first line that isn't blank: whichever appears more
 * often outside quotes. Excel in some locales saves "CSV" with semicolons.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  for (const ch of stripBom(text).replace(/^[\r\n]+/, "")) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && (ch === "\n" || ch === "\r")) break;
    else if (!inQuotes && ch === ",") commas++;
    else if (!inQuotes && ch === ";") semicolons++;
  }
  return semicolons > commas ? ";" : ",";
}

/**
 * Reads CSV text into rows of cells. Handles quoted cells with line breaks and doubled
 * quotes, CRLF, LF or CR line ends, and a leading byte-order mark. It never throws: stray
 * quotes inside an unquoted cell are kept as written, and an unclosed quote runs to the end.
 * A blank line comes back as a row of one empty cell; the line break at the very end adds no row.
 */
export function parseCsv(text: string, delimiter?: CsvDelimiter): { rows: string[][]; delimiter: CsvDelimiter } {
  const body = stripBom(text);
  const d = delimiter ?? detectDelimiter(body);
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false; // this cell started with a quote
  let inQuotes = false;

  const endField = () => {
    row.push(field);
    field = "";
    quoted = false;
  };
  const endRow = () => {
    endField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (inQuotes) {
      if (ch !== '"') field += ch;
      else if (body[i + 1] === '"') {
        field += '"';
        i++;
      } else inQuotes = false;
    } else if (ch === '"' && field === "" && !quoted) {
      inQuotes = true;
      quoted = true;
    } else if (ch === d) {
      endField();
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && body[i + 1] === "\n") i++;
      endRow();
    } else {
      field += ch;
    }
  }
  if (field !== "" || quoted || row.length > 0) endRow();
  return { rows, delimiter: d };
}
