import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.spec.ts"],
    // Keep CI quiet and deterministic; the projection is pure, no timers.
    pool: "forks",
    passWithNoTests: false,
  },
});
