import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Tauri injects this when building for mobile / network dev hosts.
// Vite doesn't ship Node types by default, so reach for the global directly.
const host = (globalThis as any).process?.env?.TAURI_DEV_HOST as string | undefined;

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? { protocol: "ws", host, port: 1421 }
      : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
