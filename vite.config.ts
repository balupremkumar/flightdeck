/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  resolve: {
    alias: [
      // @xterm/addon-ligatures ships only the ESM build (lib/addon-ligatures.mjs)
      // but its package `main` still points at lib/addon-ligatures.js, which is
      // not in the tarball. Vite's build follows `module` so the bundle is fine,
      // but Vitest resolves `main` and dies with "Failed to resolve entry" on any
      // import of Terminal.tsx. Pin the specifier to the file that actually
      // exists — same module the production bundle already picks, so this is a
      // no-op for `vite build` and only unblocks the test resolver.
      { find: /^@xterm\/addon-ligatures$/, replacement: "@xterm/addon-ligatures/lib/addon-ligatures.mjs" },
    ],
  },

  // UI-225: split the vendor weight out of the app chunk. xterm + its addons
  // are the bulk and change rarely, so they cache independently of app code
  // and the first paint doesn't wait on one ~930KB bundle.
  build: {
    // xterm plus its addons is ~695KB (the webgl renderer added the bulk of
    // that in QL wave 1) and is deliberately its own cached vendor chunk; the
    // app chunk is what we keep small. Limit set just above that so the warning
    // means something again.
    chunkSizeWarningLimit: 720,
    rollupOptions: {
      // The drag ghost is its own tiny page (no React, no store), see src/ghost.ts.
      input: {
        main: "index.html",
        ghost: "ghost.html",
      },
      output: {
        manualChunks: {
          xterm: [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-search",
            "@xterm/addon-web-links",
            "@xterm/addon-ligatures",
            "@xterm/addon-webgl",
            "@xterm/addon-unicode11",
          ],
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      // Agent worktrees under this checkout's .claude/ are whole repo copies;
      // watching them made their edits full-reload this server's pages mid-e2e.
      // Anchored to the root so a server started inside a worktree (whose own
      // path contains .claude/) still watches its own files.
      // @ts-expect-error process is a nodejs global
      ignored: ["**/src-tauri/**", `${process.cwd().replace(/\\/g, "/")}/.claude/**`],
    },
  },

  // Agent worktrees live under .claude/worktrees inside the repo; without this
  // every `vitest run` also runs each worktree's copy of the suite.
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**", "demo/**", "e2e/**"],
  },
}));
