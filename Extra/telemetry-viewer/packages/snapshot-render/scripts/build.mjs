/**
 * Build `@mdu/snapshot-render` for no-build consumers: the standalone
 * `Extra/snapshot-viewer` page has no bundler, so the package ships a single
 * IIFE bundle exposing the whole render API as `window.MduSnapshotRender`.
 *
 * The TS sources stay the single source of truth — the telemetry-viewer web
 * client (Vite) and the server tests import them directly; this artifact must
 * never drift from them, which `test/standaloneParity.spec.ts` locks in by
 * rendering through the exact bundle loaded into the real viewer page.
 */
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pkgDir = dirname(scriptDir);
const outDir = join(pkgDir, "dist");
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(pkgDir, "src/index.ts")],
  bundle: true,
  format: "iife",
  globalName: "MduSnapshotRender",
  outfile: join(outDir, "snapshot-render.global.js"),
  target: "es2020",
  sourcemap: true,
  minify: false,
  logLevel: "warning",
});
