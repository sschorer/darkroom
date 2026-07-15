/**
 * Conventional Commits — https://www.conventionalcommits.org
 *
 * Used in two places:
 *   1. .husky/commit-msg — local, best-effort. Anyone can `--no-verify`, and
 *      contributors who never run `pnpm install` never get the hook at all.
 *   2. .github/workflows/pr-title.yml — the real gate, because we squash-merge
 *      and the PR title becomes the commit message on main.
 *
 * Both read this file, so the rules can't drift apart.
 */

/** @type {import('@commitlint/types').UserConfig} */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "type-enum": [
      2,
      "always",
      [
        "feat", // user-visible capability
        "fix", // user-visible bug fix
        "docs", // incl. ARCHITECTURE.md / ADRs
        "style", // formatting only, no behaviour
        "refactor",
        "perf",
        "test",
        "build", // bundling, packaging, uv sidecar
        "ci", // workflows
        "chore",
        "revert",
      ],
    ],
    "scope-enum": [
      2,
      "always",
      [
        "registry", // manifests, workflows, the model registry itself
        "engine", // ComfyUI bootstrap, comfy.lock, venv provisioning
        "sidecar", // process spawn/teardown
        "download", // weight fetching
        "updater", // Tauri updater, latest.json
        "comfy", // the HTTP/WS client
        "ui",
        "paths",
        "vouch",
        "ci",
        "deps",
      ],
    ],
    "scope-empty": [0], // scope optional; when present it must be in the list
    "subject-case": [2, "always", "lower-case"],
    "subject-full-stop": [2, "never", "."],
    "header-max-length": [2, "always", 72],
    "body-max-line-length": [2, "always", 100],
  },
};
