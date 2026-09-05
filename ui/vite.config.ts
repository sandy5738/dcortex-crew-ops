import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// The repo root, one level up from ui/.
const root = path.resolve(__dirname, "..");

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      // Single source of truth: the frontend imports the SAME fixture the
      // harness validates against. No copy to drift out of date.
      "@fixtures": path.join(root, "fixtures"),
      "@": path.resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5173,
    // Allow reading fixtures/ from outside ui/.
    fs: { allow: [root] },
    // So the frontend calls /api/* with no CORS config.
    // src/api.ts listens on 3000 (see PORT there).
    proxy: {
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ""),
      },
    },
  },
});
