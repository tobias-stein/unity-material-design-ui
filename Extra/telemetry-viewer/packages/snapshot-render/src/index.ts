/**
 * @mdu/snapshot-render — shared UI-snapshot rendering core.
 *
 * Single source of truth for everything that turns a parsed snapshot into
 * pixels, consumed by:
 * - the telemetry viewer web client (replica playhead panel + filmstrip minimaps)
 * - the standalone `Extra/snapshot-viewer` page (P5: runs on the shared
 *   package through the built IIFE bundle, `dist/snapshot-render.global.js`)
 * - the telemetry viewer server (pure normalization pipeline via the
 *   `./normalize` subpath — no DOM dependencies)
 */
export * from "./model.js";
export * from "./colors.js";
export * from "./appliedTheme.js";
export * from "./normalize.js";
export * from "./replica.js";
export * from "./flex.js";
export * from "./minimap.js";
