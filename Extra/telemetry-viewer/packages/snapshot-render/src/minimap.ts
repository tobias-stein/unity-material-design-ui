/**
 * Filmstrip mini-map (plan §9.1): a *simplified* blocky render of a captured
 * snapshot — layout boxes + key color roles only, canvas 2D, never the replica
 * DOM. One block per snapshot capture ("scene change"), bounded work: the
 * precomputed block list is cheap to draw every filmstrip frame.
 */
import type { UISnapshot } from "./model.js";
import { hex } from "./colors.js";
import { resolveTheme } from "./appliedTheme.js";

export interface MiniMapBlock {
  x: number;
  y: number;
  w: number;
  h: number;
  /** CSS color already normalized (missing palette entries → role fallback). */
  color: string;
}

export interface MiniMapData {
  width: number;
  height: number;
  blocks: MiniMapBlock[];
  warnings: string[];
}

/**
 * Precompute the blocky render once per parsed snapshot (the filmstrip cache
 * key is the snapshot hash on the caller side).
 */
export function computeMiniMap(snapshot: UISnapshot, maxDepth = 6): MiniMapData {
  const root = snapshot.nodes.find((node) => node.id === snapshot.rootId) ?? snapshot.nodes[0];
  const width = root?.rect?.width ?? 800;
  const height = root?.rect?.height ?? 600;

  const theme = resolveTheme("default-light", snapshot.theme ?? null);
  const palette: Record<string, string> = {};
  for (const [role, value] of Object.entries(theme.palette)) palette[role.toLowerCase()] = value;

  const blocks: MiniMapBlock[] = [];
  const walk = (nodeId: string, depth: number): void => {
    const node = snapshot.nodes.find((candidate) => candidate.id === nodeId);
    if (!node || depth > maxDepth) return;
    const rect = node.rect;
    if (rect && node.active !== false && (rect.width ?? 0) > 1 && (rect.height ?? 0) > 1) {
      const resolved = node.resolved ?? {};
      // Painted container color only (never foreground roles on boxes).
      const color = hex(resolved.backgroundColor) ?? hex(resolved.fillColor);
      if (!color && node.isView) {
        // Views paint the background role only as an outline card.
      }
      if (color && color.toLowerCase() !== (palette.background ?? "").toLowerCase()) {
        blocks.push({ x: rect.x ?? 0, y: rect.y ?? 0, w: rect.width ?? 0, h: rect.height ?? 0, color });
      }
    }
    for (const childId of snapshot.childrenOf[nodeId] ?? []) walk(childId, depth + 1);
  };
  walk(snapshot.rootId, 0);

  return { width, height, blocks, warnings: snapshot.warnings };
}

/** Draw one precomputed mini-map into a canvas region (aspect-fit, contain). */
export function drawMiniMap(
  ctx: CanvasRenderingContext2D,
  data: MiniMapData,
  dx: number,
  dy: number,
  drawWidth: number,
  drawHeight: number,
  backgroundColor: string,
): void {
  ctx.save();
  ctx.translate(dx, dy);
  ctx.beginPath();
  ctx.rect(0, 0, drawWidth, drawHeight);
  ctx.clip();
  ctx.fillStyle = backgroundColor;
  ctx.fillRect(0, 0, drawWidth, drawHeight);

  const scale = Math.min(drawWidth / data.width, drawHeight / data.height);
  const offsetX = (drawWidth - data.width * scale) / 2;
  const offsetY = (drawHeight - data.height * scale) / 2;
  for (const block of data.blocks) {
    ctx.fillStyle = block.color;
    ctx.fillRect(
      offsetX + block.x * scale,
      offsetY + block.y * scale,
      Math.max(1, block.w * scale),
      Math.max(1, block.h * scale),
    );
  }
  ctx.restore();
}
