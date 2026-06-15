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
    watch: { ignored: ["**/src-tauri/**", "**/target/**"] },
  },
  // Pin the dep optimizer to the Tauri frontend's entry. Otherwise Vite 8
  // auto-discovers every *.html in the project (including
  // target/release/build/*/out/tauri-codegen-assets/*.html scaffolds and
  // server/admin-ui/index.html), crawls their imports, and asks chokidar
  // to watch tens of thousands of files under target/ — blowing through
  // the inotify watcher limit (ENOSPC) on Linux. server.watch.ignored
  // does not help here because the offending paths are added as explicit
  // watch targets rather than via project-tree traversal.
  optimizeDeps: {
    entries: ["index.html"],
  },
});
