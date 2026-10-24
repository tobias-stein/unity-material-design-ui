/**
 * Line-protocol parsing for `.lp` session files produced by the Unity runtime
 * (`Assets/Runtime/Telemetry/Events/LineProtocolSerializer.cs`). The parser is
 * a deliberate twin of that serializer: it unescapes exactly the four
 * sequences the runtime emits (`\s`, `\,`, `\=`, `\\`) plus the field-string
 * escapes (`\"`, `\\`), and tolerates the shapes InfluxDB itself writes.
 */
import { Measurements } from "../domain.js";
import type {
  MeasurementName,
  RawEvent,
  RawEventFields,
  RawEventResult,
  SourceError,
} from "../domain.js";

/** Known measurements; anything else is skipped (counted, not fatal). */
const KNOWN_MEASUREMENTS: ReadonlySet<string> = new Set(Object.values(Measurements));

interface ParsedLine {
  measurement: string;
  tags: Array<[string, string]>;
  fields: Array<[string, FieldValue]>;
  timestampNs: bigint;
}

export type FieldValue =
  | { kind: "float"; value: number }
  | { kind: "int"; value: number }
  | { kind: "uint"; value: number }
  | { kind: "bool"; value: boolean }
  | { kind: "string"; value: string };

/** Unescape a tag key/value: `\s`,`\,`,`\=`,`\\`; unknown escapes stay verbatim. */
export function unescapeTagValue(raw: string): string {
  if (!raw.includes("\\")) return raw;
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    switch (next) {
      case "s": out += " "; i++; break;
      case ",": out += ","; i++; break;
      case "=": out += "="; i++; break;
      case "\\": out += "\\"; i++; break;
      default: out += c; // no fitting escape: keep the backslash
    }
  }
  return out;
}

/** Unescape a quoted field-string body: `\"` → `"`, `\\` → `\`; rest verbatim. */
export function unescapeFieldString(raw: string): string {
  let out = "";
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = raw[i + 1];
    if (next === '"' || next === "\\") {
      out += next;
      i++;
    } else {
      out += c;
    }
  }
  return out;
}

/**
 * Find the positions of unescaped spaces in `line`. Every escape pair
 * (`\x`) is skipped as a unit, so `\ `, `\,` etc. never split sections.
 */
function findSectionBreaks(line: string): number[] {
  const breaks: number[] = [];
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === " ") breaks.push(i);
  }
  return breaks;
}

export function parseFieldValue(key: string, raw: string): FieldValue | null {
  if (raw.endsWith("i") && /^-?\d+i$/.test(raw)) {
    return { kind: "int", value: Number(raw.slice(0, -1)) };
  }
  if (raw.endsWith("u") && /^\d+u$/.test(raw)) {
    return { kind: "uint", value: Number(raw.slice(0, -1)) };
  }
  if (raw === "true") return { kind: "bool", value: true };
  if (raw === "false") return { kind: "bool", value: false };
  if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
    return { kind: "string", value: unescapeFieldString(raw.slice(1, -1)) };
  }
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(raw)) {
    return { kind: "float", value: Number(raw) };
  }
  return null; // unknown scalar syntax
}

/** Parse one physical line (already trimmed). Returns reasons when malformed. */
export function parseLpLine(line: string): ParsedLine | string {
  if (line.length === 0 || line.startsWith("#")) {
    return "empty line";
  }

  const breaks = findSectionBreaks(line);
  if (breaks.length === 0) return "missing field section";

  const head = line.slice(0, breaks[0]!);

  // measurement = up to the first comma; tags follow.
  const firstTagOrFieldComma = head.indexOf(",");
  let measurement: string;
  let tagPart: string;
  let fieldPart: string;
  const tailParts = breaks.length > 1 ? line.slice(breaks[0]! + 1, breaks[1]!) : line.slice(breaks[0]! + 1);
  const tsPart = breaks.length > 1 ? line.slice(breaks[1]! + 1) : "";

  if (firstTagOrFieldComma === -1) {
    measurement = unescapeTagValue(head);
    tagPart = "";
    fieldPart = tailParts;
  } else {
    measurement = unescapeTagValue(head.slice(0, firstTagOrFieldComma));
    tagPart = head.slice(firstTagOrFieldComma + 1);
    fieldPart = tailParts;
  }

  if (measurement.length === 0) return "empty measurement";
  if (fieldPart.length === 0) return "missing fields";

  const tags: Array<[string, string]> = [];
  if (tagPart.length > 0) {
    for (const pair of splitUnescaped(tagPart, ",")) {
      const eq = pair.indexOf("=");
      if (eq <= 0) return `malformed tag: ${pair}`;
      tags.push([unescapeTagValue(pair.slice(0, eq)), unescapeTagValue(pair.slice(eq + 1))]);
    }
  }

  const fields: Array<[string, FieldValue]> = [];
  for (const pair of splitUnescaped(fieldPart, ",")) {
    const eq = pair.indexOf("=");
    if (eq <= 0) return `malformed field: ${pair}`;
    const value = parseFieldValue(pair.slice(0, eq), pair.slice(eq + 1));
    if (value === null) return `malformed field value: ${pair}`;
    fields.push([pair.slice(0, eq), value]);
  }

  if (tsPart.length === 0) return "missing timestamp";
  // Line protocol timestamps are integer nanoseconds; accept RFC3339 as fallback.
  if (/^-?\d+$/.test(tsPart)) {
    const ts = BigInt(tsPart);
    return { measurement, tags, fields, timestampNs: ts };
  }
  const ms = Date.parse(tsPart);
  if (!Number.isFinite(ms)) return `malformed timestamp: ${tsPart}`;
  return { measurement, tags, fields, timestampNs: BigInt(ms) * 1_000_000n };
}

/** Split on `sep`, honoring backslash escapes (an escape pair is atomic). */
function splitUnescaped(text: string, sep: string): string[] {
  const parts: string[] = [];
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (c === "\\") {
      current += c + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (c === sep) {
      parts.push(current);
      current = "";
      continue;
    }
    current += c;
  }
  parts.push(current);
  return parts;
}

/** Map parsed field values to the normalized {@link RawEventFields}. */
function toRawFields(parsed: ParsedLine): RawEventFields {
  const fields: RawEventFields = {};
  for (const [key, value] of parsed.fields) {
    switch (key) {
      case "value": if (value.kind === "int" || value.kind === "float" || value.kind === "uint") fields.value = value.value; break;
      case "on": if (value.kind === "bool") fields.on = value.value; break;
      case "dwell": if (value.kind === "float" || value.kind === "int") fields.dwell = value.value; break;
      case "key": if (value.kind === "string") fields.key = value.value; break;
      case "hash": if (value.kind === "string") fields.hash = value.value; break;
      case "nodes": if (value.kind === "int" || value.kind === "uint") fields.nodes = value.value; break;
      case "width": if (value.kind === "float" || value.kind === "int") fields.width = value.value; break;
      case "height": if (value.kind === "float" || value.kind === "int") fields.height = value.value; break;
      case "owner": if (value.kind === "string") fields.owner = value.value; break;
      case "platform": if (value.kind === "string") fields.platform = value.value; break;
      case "screen": if (value.kind === "string") fields.screen = value.value; break;
      case "source": if (value.kind === "string") fields.source = value.value; break;
      default: break; // unknown fields (§4.4): tolerated, not projected
    }
  }
  return fields;
}

export function parsedLineToRawEvent(parsed: ParsedLine): RawEvent | null {
  if (!KNOWN_MEASUREMENTS.has(parsed.measurement)) return null;
  const tags: Record<string, string | undefined> = {};
  for (const [key, value] of parsed.tags) {
    if (key === "session" || key === "type" || key === "view" || key === "view_id" || key === "element" || key === "element_type" || key === "layer") {
      tags[key] = value;
    }
  }
  return {
    measurement: parsed.measurement as MeasurementName,
    timestampNs: parsed.timestampNs,
    tags: {
      session: tags.session ?? "",
      ...(tags.type !== undefined ? { type: tags.type } : {}),
      ...(tags.view !== undefined ? { view: tags.view } : {}),
      ...(tags.view_id !== undefined ? { view_id: tags.view_id } : {}),
      ...(tags.element !== undefined ? { element: tags.element } : {}),
      ...(tags.element_type !== undefined ? { element_type: tags.element_type } : {}),
      ...(tags.layer !== undefined ? { layer: tags.layer } : {}),
    },
    fields: toRawFields(parsed),
  };
}

export function parseMeasurementName(name: string): MeasurementName | null {
  return KNOWN_MEASUREMENTS.has(name) ? (name as MeasurementName) : null;
}

/**
 * Parse the concatenated content of one or more `.lp` documents.
 * Returns every event plus a structured per-line error list.
 */
export function parseLpDocuments(
  documents: Array<{ file: string; content: string }>,
): RawEventResult {
  const events: RawEvent[] = [];
  const errors: SourceError[] = [];
  let malformedCount = 0;

  for (const { file, content } of documents) {
    // Normalize CRLF; keep physical order for stable tie-breaking.
    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.replace(/\r$/, "").trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const parsed = parseLpLine(line);
      if (typeof parsed === "string") {
        malformedCount++;
        if (errors.length < 50) {
          errors.push({
            code: "MALFORMED_LINE",
            message: `${file}:${i + 1} — ${parsed}`,
            httpStatus: 502,
          });
        }
        continue;
      }
      const event = parsedLineToRawEvent(parsed);
      if (event === null) {
        malformedCount++;
        if (errors.length < 50) {
          errors.push({
            code: "UNKNOWN_MEASUREMENT",
            message: `${file}:${i + 1} — unknown measurement "${parsed.measurement}"`,
            httpStatus: 502,
          });
        }
        continue;
      }
      events.push(event);
    }
  }

  // nanosecond-ascending, with file/line order as a stable tie-break: parser
  // emits in read order, and Array.prototype.sort is stable in modern engines.
  events.sort((a, b) => (a.timestampNs < b.timestampNs ? -1 : a.timestampNs > b.timestampNs ? 1 : 0));
  return { events, malformedCount, error: errors.length > 0 ? errors[0] : undefined };
}
