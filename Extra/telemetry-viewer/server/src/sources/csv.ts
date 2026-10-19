/**
 * Parser for InfluxDB "annotated CSV" (the default response format of
 * `POST /api/v2/query` with `Accept: application/csv`).
 *
 * Handles the four leading `#` annotation rows when present (`#datatype`,
 * `#group`, `#default`, plus blank rows), RFC3339 timestamps with full
 * nanosecond precision, quoted cells and empty/missing values. Tolerates the
 * plain (annotation-less) InfluxDB 2.7 output.
 */

export type CsvValue = string | number | boolean | null;

export interface CsvRecord extends Record<string, CsvValue> {}

export interface ParsedCsv {
  columns: string[];
  records: CsvRecord[];
}

const RFC3339_RE =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})?$/;

/** RFC3339 (optionally with up-to-9 fractional digits, `Z` or ±HH:MM) to epoch ns. */
export function rfc3339ToNs(value: string): bigint | null {
  const match = value.trim().match(RFC3339_RE);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = match[7] ?? "";
  const zone = match[8] ?? "Z";

  let offsetMillis = 0;
  const offsetMatch = zone.match(/^([+-])(\d{2}):(\d{2})$/);
  if (offsetMatch) {
    const sign = offsetMatch[1] === "-" ? -1 : 1;
    offsetMillis = sign * (Number(offsetMatch[2]) * 60 + Number(offsetMatch[3])) * 60_000;
  }
  const fractionNanos = BigInt(`${fraction}000000000`.slice(0, 9) || "0");
  const utcMillis =
    Date.UTC(year, month - 1, day, hour, minute, second, 0) - offsetMillis;
  return BigInt(utcMillis) * 1_000_000n + fractionNanos;
}

function convertCell(raw: string, datatype: string | null): CsvValue {
  if (raw === "") return null;
  switch (datatype) {
    case "double":
    case "integer":
    case "unsigned":
    case "long":
      return Number(raw);
    case "boolean":
      return raw === "true";
    case "dateTime:RFC3339":
    case "dateTime:RFC3339Nano":
      return raw; // exact string preserved; ns conversion is caller's concern
    default:
      return raw;
  }
}

/** Split a single CSV line into cells, honoring `"` quoting and `""` escapes. */
export function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"' && cell.length === 0) {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += c;
  }
  cells.push(cell);
  return cells;
}

export function parseAnnotatedCsv(text: string): ParsedCsv {
  // Accept \r\n and \n; a physical row may hold a quoted newline.
  const lines = splitCsvLinesPreservingQuotes(text);
  const datatypes: Array<string | null> = [];
  const defaults: Array<string | null> = [];
  let columns: string[] | null = null;
  let firstColumns: string[] | null = null;

  const records: CsvRecord[] = [];
  const resetAnnotations = (): void => {
    datatypes.length = 0;
    defaults.length = 0;
  };
  for (const line of lines) {
    if (line.startsWith("#")) {
      const cells = splitCsvLine(line.slice(1));
      if (line.startsWith("#datatype")) {
        // InfluxDB precedes every table with the annotation preamble; with
        // annotations on, a repeated "#datatype" row marks the next table.
        columns = null;
        resetAnnotations();
        datatypes.push(...cells);
      } else if (line.startsWith("#default")) {
        defaults.push(...cells);
      }
      continue;
    }
    if (line.trim() === "") {
      // InfluxDB 2.7 OSS separates tables with a blank line, each carrying
      // its own header (annotations are omitted in OSS output).
      columns = null;
      resetAnnotations();
      continue;
    }
    const cells = splitCsvLine(line);
    if (columns === null) {
      columns = cells;
      if (firstColumns === null) firstColumns = cells;
      continue;
    }
    const record: CsvRecord = {};
    for (let i = 0; i < columns.length; i++) {
      const column = columns[i]!;
      if (column === "") continue;
      let cell = cells[i] ?? "";
      if (cell === "" && defaults[i]) cell = defaults[i]!;
      record[column] = i === 0 ? cell : convertCell(cell, datatypes[i] ?? null);
    }
    records.push(record);
  }
  // `columns` reports the first table's header (stable for API consumers).
  return { columns: firstColumns ?? [], records };
}

/** Split whole text into csv "lines", treating quoted newlines as cell content. */
function splitCsvLinesPreservingQuotes(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === '"') {
      if (text[i + 1] === '"') {
        current += '""';
        i++;
        continue;
      }
      inQuotes = !inQuotes;
    }
    if (c === "\n" && !inQuotes) {
      current = current.replace(/\r$/, "");
      lines.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  if (current.length > 0) lines.push(current.replace(/\r$/, ""));
  return lines;
}
