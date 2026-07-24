// vite.demo.config.ts — builds the REAL app frontend (src/**, untouched) into
// a static, self-contained bundle for the kove.nz interactive demo, with the
// interactive mock backend inlined into the HTML so it runs before the app
// bundle on every load. Output: demo/site-dist/. No Tauri, no network calls
// at runtime — base:'./' so it serves from any subpath.
//
// Run from the flightdeck project root:
//   npx vite build --config demo/vite.demo.config.ts
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Inlines the interactive mock (window.__TAURI_INTERNALS__ + the scripted
// backend) directly into the built HTML, ahead of the app's module script.
// Also forces the boot flags the mock's boot session needs BEFORE main.tsx
// runs: dark theme regardless of visitor OS (the in-app toggle stays live
// after boot), and flightdeck-startup=reopen so session.ts silently hydrates
// the seeded workspaces instead of asking "reopen last session?".
function injectMock(): Plugin {
  return {
    name: "flightdeck-demo-inject-mock",
    transformIndexHtml(html) {
      const mockJs = fs.readFileSync(path.join(__dirname, "mock-tauri-interactive.js"), "utf8");
      const bootFlags = [
        'try {',
        '  localStorage.setItem("flightdeck-theme-id", "dark");',
        '  localStorage.setItem("flightdeck-theme", "dark");', // legacy fallback key, belt & braces
        '  localStorage.setItem("flightdeck-startup", "reopen");',
        '} catch (e) { /* non-persistent */ }',
      ].join("\n");
      const inline = `<script>\n${bootFlags}\n${mockJs}\n</script>`;
      return html.replace("<!--DEMO_MOCK_INJECT-->", inline);
    },
  };
}

export default defineConfig({
  // Root is demo/site/ (where index.html lives) so the built HTML lands
  // directly at site-dist/index.html with correct relative asset paths — the
  // index.html itself reaches into the real app via a relative
  // "../../src/main.tsx" script src rather than a root-absolute "/src/...".
  root: path.resolve(__dirname, "site"),
  base: "./",
  plugins: [react(), injectMock()],
  build: {
    outDir: path.resolve(__dirname, "site-dist"),
    emptyOutDir: true,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: [
            "@xterm/xterm",
            "@xterm/addon-fit",
            "@xterm/addon-search",
            "@xterm/addon-web-links",
            "@xterm/addon-ligatures",
          ],
          react: ["react", "react-dom", "react-dom/client"],
        },
      },
    },
  },
});
