# Kickoff prompt for Claude Code

Unzip the scaffold, `cd` into it, run `claude`, and paste the block below.

> **Before you start:** `gh auth login` (needs `repo` scope). If you'd rather not
> hand an agent your GitHub credentials, just run `./bootstrap-repo.sh <handle>`
> yourself — it's deterministic and does exactly the same thing. Claude Code's
> real value starts at issue #1, not at repo creation.

---

## Paste this

```
This directory is the scaffold for Darkroom — a Tauri 2 desktop app that
generates images and video with AI models running locally on the user's GPU
via a bundled ComfyUI subprocess. GPL-3.0. Nothing is built yet; these are
docs, CI config, and one schema + test.

Read CLAUDE.md, then ARCHITECTURE.md (arc42 — §9 is the ADRs), then
docs/BACKLOG.md. Don't re-derive decisions that are already ADRs.

TASK 1 — create the repo.
Run ./bootstrap-repo.sh <MY-HANDLE>. Read it first so you know what it does.
It creates the public repo, pushes the scaffold, sets squash-only merging with
PR_TITLE as the commit message (pr-title.yml is meaningless without this),
applies branch protection, and seeds the M0/M1 issues via scripts/seed-issues.sh.
If a step fails, diagnose it rather than working around it — silently skipping
the merge settings would leave the commit convention unenforced.

TASK 2 — issue #1, chore: scaffold tauri 2 + react + ts.
Scaffold into this directory (don't nest a new project inside it — the docs,
.github/, src/lib/registry.schema.ts and tests/ stay where they are).
- Tauri 2 + React + TypeScript + Tailwind + Vite, pnpm
- CSP with connect-src http://127.0.0.1:* ws://127.0.0.1:* from the start
- Version identical in package.json, Cargo.toml, tauri.conf.json
- Wire up: vitest with test:registry and test:unit scripts, eslint, prettier,
  commitlint + husky (prepare: husky)
- pnpm test:registry must run. It'll report an empty registry; that's correct
  for now — #14 adds the first manifest.
Then verify `pnpm tauri dev` opens a window and `pnpm lint && pnpm typecheck`
passes. Open a PR with a Conventional Commit title.

Then stop and check in. Don't start #2 unprompted.

Notes:
- The backlog order is by risk, not architecture. #4 (uv + ComfyUI bootstrap)
  is the project's central bet — if it can't be made reliable, ADR-004 is
  wrong. Don't reorder to do "easier" work first.
- CI has no GPU. Never propose a test that generates an image.
- If you hit something that contradicts an ADR, say so; don't quietly work
  around it.
```

---

## After that

Work issue by issue. `#2 → #3 → #4`, and **#4 is where you find out if this project is real** — if uv + torch + ComfyUI won't bootstrap cleanly on a cold machine across three OSes, ADR-004 collapses and the ~80MB bundle premise with it.

Useful things to say mid-flight:

| | |
|---|---|
| `/memory` | check CLAUDE.md is actually loading |
| `/doctor` | proposes trims once CLAUDE.md drifts past ~100 lines |
| "add this to CLAUDE.md" | when it hits a trap we didn't write down |

**When Claude Code discovers a new trap, put it in CLAUDE.md — not in a comment.** That file compounds: by month three it holds every non-obvious mistake the project has produced, and prevents them for free. It's the same instinct as the ADRs, on a shorter loop.

**One caution.** CLAUDE.md is context, not enforcement — Claude Code reads it and tries to comply, but there's no guarantee. Anything that must hold, encode in CI. That's why `tests/registry.test.ts` exists rather than a line in CLAUDE.md saying "please keep manifests valid."
