import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// Backend (Express + Mission Engine API) always runs on 4310 — see ../README.md.
const API_TARGET = "http://127.0.0.1:4310";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    // Fixed port: the API only accepts browser requests from :5173 (src/api/localOnly.ts),
    // and the dev banner points here. Fail loudly instead of drifting to 5174.
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API_TARGET, changeOrigin: true },
    },
  },
  build: {
    // Express serves this directly (see ../src/server.ts).
    outDir: "../dist-web",
    emptyOutDir: true,
  },
})
