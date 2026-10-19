import { defineConfig } from "vite";

export default defineConfig({
  server: {
    port: 5187,
    proxy: {
      // Dev server proxies the API to the Fastify server (P0 compose stub).
      "/api": "http://localhost:8087",
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
