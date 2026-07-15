// vitest/config, not vite: it extends the config type with `test`. Vitest must
// stay on a major that matches Vite's — vitest 2 carries Vite 5's plugin types
// and fails typecheck against Vite 6.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],

  // app/ is the webview side and holds index.html, so it is Vite's root
  // (ADR-012). Everything cargo builds lives in native/.
  root: "app",

  // Both default to somewhere under `root`, which would scatter a
  // node_modules/.vite and a coverage/ inside app/ next to the source.
  cacheDir: "../node_modules/.vite",

  build: {
    // Relative to `root`, so this lands at the repo root — which is what
    // native/tauri.conf.json's frontendDist ("../dist") resolves to.
    outDir: "../dist",
    // outDir sits outside root; without this Vite refuses to clean it.
    emptyOutDir: true,
  },

  // Tauri shows its own errors; letting Vite clear the screen hides them.
  clearScreen: false,

  server: {
    // 127.0.0.1, not localhost: the CSP allows ws://127.0.0.1:* for the engine,
    // so serving dev + HMR from the same host keeps HMR working without
    // widening connect-src. Weakening the CSP to "make it work" is the wrong
    // fix (CLAUDE.md).
    host: "127.0.0.1",
    // Tauri expects a fixed port and fails rather than silently using another.
    port: 1420,
    strictPort: true,
    watch: {
      // native/ is watched by cargo, not Vite.
      ignored: ["**/native/**"],
    },
  },

  test: {
    /**
     * Two projects, because they answer different questions and ci.yml runs
     * them in different jobs:
     *
     *   registry — validates manifests against the schema. No GPU, ~10s, and
     *              the highest-value check in the repo (ADR-010). Runs first
     *              and alone.
     *   unit     — everything else.
     *
     * The names are load-bearing: `pnpm test:registry` and `pnpm test:unit`
     * select them with `--project`.
     */
    projects: [
      {
        // `root` above is app/, and vitest resolves include globs against it.
        // Tests live outside app/, so each project is re-rooted at the repo.
        root: import.meta.dirname,
        test: {
          name: "registry",
          include: ["registry/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        root: import.meta.dirname,
        test: {
          name: "unit",
          // Co-located with the code they test. native/ has no entry here —
          // Rust tests are cargo #[test], run by ci.yml's rust job.
          include: ["app/**/*.test.{ts,tsx}"],
          environment: "node",
        },
      },
    ],

    coverage: {
      provider: "v8",
      // Relative to `root` (app/), same as build.outDir — so this lands at
      // the repo root rather than inside the source directory.
      reportsDirectory: "../coverage",
      include: ["app/**/*.{ts,tsx}"],
      exclude: ["app/**/*.test.{ts,tsx}", "app/main.tsx"],
    },
  },
});
