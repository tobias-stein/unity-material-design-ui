/**
 * @mdu/snapshot-render — shared UI-snapshot rendering core.
 *
 * Consumers:
 * - the telemetry viewer web client (replica playhead panel + filmstrip minimaps)
 * - the standalone `Extra/snapshot-viewer` (switches over in P5; until then it
 *   keeps its vendored copy with identical behavior)
 */
export * from "./model.js";
export * from "./colors.js";
export * from "./appliedTheme.js";
export * from "./replica.js";
export * from "./minimap.js";
