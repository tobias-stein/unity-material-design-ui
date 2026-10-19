/**
 * Theme handling for the shared replica renderer.
 *
 * - `injectTheme` materializes a snapshot's captured palette/typography as
 *   `--m3-*` CSS custom properties on a style root (the standalone viewer's
 *   behavior; the viewer.css consumed classes read the kebab-case tokens).
 * - `DEFAULT_LIGHT_THEME` is the *hardcoded* synthetic default light Material
 *   3 palette (plan §3.8): aggregate/tool rendering must never adopt captured
 *   theme colors implicitly — default-light is the baseline, `raw` mode is an
 *   explicit user toggle (per-node colors are re-derived from color *roles*,
 *   never copied from captured resolved values).
 */
import type { SnapshotTheme } from "./model.js";
import { camel, hex, kebab } from "./colors.js";

const M3_DEFAULT_LIGHT_TOKENS: Record<string, string> = {
  Primary: "#6750A4",
  OnPrimary: "#FFFFFF",
  PrimaryContainer: "#EADDFF",
  OnPrimaryContainer: "#21005D",
  Secondary: "#625B71",
  OnSecondary: "#FFFFFF",
  SecondaryContainer: "#E8DEF8",
  OnSecondaryContainer: "#1D192B",
  Tertiary: "#7D5260",
  OnTertiary: "#FFFFFF",
  TertiaryContainer: "#FFD8E4",
  OnTertiaryContainer: "#31111D",
  Error: "#B3261E",
  OnError: "#FFFFFF",
  ErrorContainer: "#F9DEDC",
  OnErrorContainer: "#410E0B",
  Background: "#FEF7FF",
  OnBackground: "#1D1B20",
  Surface: "#FEF7FF",
  OnSurface: "#1D1B20",
  SurfaceVariant: "#E7E0EC",
  OnSurfaceVariant: "#49454F",
  SurfaceDim: "#DED8E1",
  SurfaceBright: "#FEF7FF",
  SurfaceContainerLowest: "#FFFFFF",
  SurfaceContainerLow: "#F7F2FA",
  SurfaceContainer: "#F3EDF7",
  SurfaceContainerHigh: "#ECE6F0",
  SurfaceContainerHighest: "#E6E0E9",
  Surface1: "#F6F2FA",
  Surface2: "#F2EDF7",
  Surface3: "#ECE6F0",
  Surface4: "#E9E3EE",
  Surface5: "#E4DEE9",
  Outline: "#79747E",
  OutlineVariant: "#CAC4D0",
  Shadow: "#000000",
  Scrim: "#000000",
  InverseSurface: "#322F35",
  InverseOnSurface: "#F5EFF7",
  InversePrimary: "#D0BCFF",
};

export interface ThemeShape {
  isDark?: boolean;
  palette?: Record<string, string>;
  typography?: Record<string, { fontSize?: number; fontWeight?: string; fontStyle?: string; fontName?: string; characterSpacing?: number; lineSpacing?: number }>;
}

/** The synthetic baseline passed wherever a captured theme should be ignored. */
export function defaultLightTheme(): SnapshotTheme {
  return {
    seedColor: M3_DEFAULT_LIGHT_TOKENS.Primary ?? "#6750A4",
    isDark: false,
    deviceType: "Desktop",
    palette: M3_DEFAULT_LIGHT_TOKENS,
  };
}

/**
 * Decide which palette/typography the renderer should use:
 * `raw` → captured, `default-light` → the hardcoded synthetic baseline.
 */
export function resolveTheme(
  mode: "default-light" | "raw",
  captured: SnapshotTheme | null | undefined,
): { isDark: boolean; palette: Record<string, string>; typography: SnapshotTheme["typography"] | null } {
  if (mode === "raw" && captured?.palette) {
    return {
      isDark: captured.isDark === true,
      palette: captured.palette,
      typography: captured.typography ?? null,
    };
  }
  const baseline = defaultLightTheme();
  return { isDark: false, palette: baseline.palette ?? {}, typography: (captured?.typography as SnapshotTheme["typography"]) ?? null };
}

/**
 * Materialize a theme on a style root as `--m3-*` custom properties (both
 * camelCase and kebab-case — the rendering stylesheet reads kebab tokens).
 */
export function injectTheme(theme: SnapshotTheme | null | undefined, styleRoot: HTMLElement): void {
  const style = styleRoot.style;
  if (!theme || !theme.palette) return;
  for (const [role, rawValue] of Object.entries(theme.palette)) {
    const value = hex(rawValue);
    if (!value) continue;
    style.setProperty(`--m3-${camel(role)}`, value);
    style.setProperty(`--m3-${kebab(role)}`, value);
  }
}

/**
 * Materialize a raw palette table (already resolved) — used by the tool when
 * the *default light* baseline must be applied regardless of the captured
 * theme (plan §3.8: re-derive from roles, never copy captured values).
 */
export function injectPalette(palette: Record<string, string>, styleRoot: HTMLElement): void {
  injectTheme({ palette }, styleRoot);
}
