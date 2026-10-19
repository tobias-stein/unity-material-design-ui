/** Server entrypoint: config → app → listen. */
import { loadConfig } from "./config.js";
import { buildApp } from "./api/app.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

interface RunOptions {
  configOverride?: Partial<ReturnType<typeof loadConfig>>;
}

export async function run(options: RunOptions = {}): Promise<{ close: () => Promise<void> }> {
  const config = { ...loadConfig(), ...(options.configOverride ?? {}) };
  const app = await buildApp({ config });

  if (config.webDist && !(await webDistExists(config.webDist))) {
    app.log.warn(
      { webDist: config.webDist },
      "Static web client not found — build it with `corepack pnpm --filter @mdu/telemetry-viewer-web build` (or set WEB_DIST).",
    );
  }

  await app.listen({ port: config.port, host: config.host });
  const close = async (): Promise<void> => {
    await app.close();
  };
  return { close };
}

async function webDistExists(dir: string): Promise<boolean> {
  try {
    const { stat } = await import("node:fs/promises");
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const isMain = process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const server = await run();
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      void server.close().finally(() => process.exit(0));
    });
  }
}
