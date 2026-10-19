/**
 * Color utilities shared by both renderers — direct port of the standalone
 * snapshot viewer's helpers (render parity is an explicit project goal).
 */

/**
 * Normalizes a snapshot color into CSS "#RRGGBB[AA]".
 *
 * Tolerates three producer quirks:
 *  - hex emitted without '#' (older exports: "BFC2FF")
 *  - YAML parsing digit-only hex as a number ("454654" → 454654, "000000" → 0)
 *  - hex YAML parsed as float/scientific ("3E2652" → Infinity) — unrecoverable,
 *    returns null so callers fall back to palette defaults.
 */
export function hex(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    value = String(value);
  }
  if (typeof value !== "string") return null;
  let text = value.trim();
  if (text.startsWith("#")) text = text.slice(1);
  if (!/^[0-9a-f]+$/i.test(text)) return null;
  if (text.length < 6) text = text.padStart(6, "0"); // leading zeros lost to YAML int parsing
  return `#${text}`;
}

/** Alpha of a normalized hex color: 1 for #RRGGBB, the AA channel for #RRGGBBAA. */
export function colorAlpha(value: unknown): number {
  const normalized = hex(value);
  if (!normalized) return 0;
  return normalized.length >= 9 ? parseInt(normalized.slice(7, 9), 16) / 255 : 1;
}

/** Baked SDF weight names → CSS numeric font-weight. */
export function fontWeight(name: unknown): number | null {
  const map: Record<string, number> = {
    Thin: 100,
    ExtraLight: 200,
    UltraLight: 200,
    Light: 300,
    Normal: 400,
    Regular: 400,
    Medium: 500,
    SemiBold: 600,
    Demi: 600,
    Bold: 700,
    Heavy: 800,
    ExtraBold: 800,
    Black: 900,
  };
  const value = typeof name === "string" ? name : "";
  return map[value] ?? null;
}

export function typeBaseName(type: unknown): string {
  if (!type) return "Unknown";
  const base = String(type).split(".").pop() ?? String(type);
  return base.replace(/`\d+$/, "");
}

export function slug(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

export function camel(text: string): string {
  return text.charAt(0).toLowerCase() + text.slice(1);
}

export function kebab(text: string): string {
  return text.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
}

/** Map a role name ("OnPrimaryContainer") to its palette hex (normalized). */
export function paletteColor(
  palette: Record<string, string>,
  role: string | null | undefined,
): string | null {
  if (!role || role === "Customized") return null;
  return hex(palette[String(role).toLowerCase()] ?? null);
}
