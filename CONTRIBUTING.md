# Contributing to Darkroom

Darkroom is GPL-3.0. By contributing you agree your work ships under that license.

Read [ARCHITECTURE.md](./ARCHITECTURE.md) before a non-trivial change. It's arc42, and §9 records why things are the way they are. If you disagree with a decision, argue with the ADR — that's what it's for.

---

## 1. Trust and vouching

Darkroom uses [vouch](https://github.com/mitchellh/vouch), the trust system Ghostty uses. The list lives at [`.github/VOUCHED.td`](./.github/VOUCHED.td).

Every PR gets one label automatically:

| Label | Meaning |
|---|---|
| `vouch:trusted` | Collaborator, bot, or listed in `VOUCHED.td` |
| `vouch:unvouched` | Not yet listed. **Your PR is not rejected.** |
| `vouch:denounced` | Explicitly blocked |

### What this actually gates

**Nothing automatic.** Unvouched PRs are not closed, CI runs on them normally, and they get reviewed. The label is a triage signal for maintainers, not a gate on your contribution.

What it changes in practice:

- Maintainers read `vouch:trusted` PRs first when the queue is deep.
- Registry PRs from unvouched authors get a closer look — a manifest is a download instruction and a workflow is a graph the engine executes, so it's the highest-consequence file in the repo despite looking like config.
- `vouch:denounced` PRs are closed without review.

We label rather than close because the contribution we most need — someone with a 5090 packaging Wan 2.2 — comes from exactly the people who haven't contributed before. Auto-closing them would optimise the repo for the maintainers' convenience and against the project.

### Getting vouched

Don't ask. Vouching happens when someone who's already trusted has seen enough of your work to believe you're acting in good faith. Open a good PR or write a useful issue and it takes care of itself. It's not a skill assessment.

Maintainers vouch by commenting `vouch @handle` on any issue, which opens a PR against `VOUCHED.td` — the trust list only changes through reviewed commits.

If your PR is mislabelled after a list change, comment `/recheck-vouch`.

### AI-assisted contributions

Use whatever tools you want. But **you** are the author, and that means:

- You understand every line, including why it's there and what happens when it's wrong.
- You ran it. On real hardware. See §3.
- You can answer review questions without going back to the tool.

A PR that fails these is why the vouch system exists. Volume without comprehension is the specific thing we're defending against, and submitting it is grounds for denouncement. An honest "I used Claude for the first draft and here's what I verified" is welcome; an unread diff is not.

---

## 2. Setup

```bash
# Rust + Node 20 + pnpm 9
rustup toolchain install stable
corepack enable && corepack prepare pnpm@9 --activate

# Linux (Ubuntu 22.04 / Debian 12 — the WebKitGTK 4.1 floor, see TC-3)
sudo apt install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev \
  patchelf libfuse2 file build-essential curl wget

pnpm install
node scripts/fetch-uv.mjs   # pulls the uv sidecar for your triple
pnpm tauri dev
```

First run provisions ~6GB into appdata (Python, torch, ComfyUI at the pinned SHA). Expect ~10 minutes. You need an NVIDIA GPU with ≥8GB VRAM to generate anything; you do **not** need one to work on most of the codebase.

---

## 3. Tests

### The constraint

**GitHub Actions has no GPU.** Nothing in CI can generate an image. Every test we have exists to catch failures *without* running a model — and the ones that can't be caught that way are pushed onto contributors as attestation.

Be suspicious of any test design that ignores this. It's the single hardest fact about testing this project.

### What runs where

| Layer | Command | Where | Speed |
|---|---|---|---|
| Registry validation | `pnpm test:registry` | CI, every PR | ~10s |
| Frontend unit | `pnpm test:unit` | CI, every PR | ~5s |
| Rust unit + integration | `cargo test` | CI, 3 OSes | ~1min |
| Bundle smoke | `pnpm tauri build --no-bundle` | CI, 3 OSes | ~10min |
| **Generation** | manual | **your GPU** | — |

Run before pushing:

```bash
make check      # everything the table above gates, in one go
make            # list every target
make doctor     # what your machine is missing, with the install command
```

The commands and their flags live in the `Makefile`. That's deliberate: they
were previously repeated here, in `CLAUDE.md` and in `ci.yml`, and three
copies of `cargo clippy -- -D warnings` drift apart until only the CI one is
true.

### Registry validation is the important one

`registry/registry.test.ts` validates every manifest — shipped and staged — against the same zod schema the app uses at runtime. One definition, both jobs; if they diverge, the test validates a contract the app doesn't enforce.

It catches the failure ADR-005 predicts: a manifest whose `params` point at node IDs that don't exist in its workflow. That breakage is invisible until someone hits Generate, and this test finds it in ten seconds without a GPU. It also catches the UI-vs-API export mistake, which otherwise costs you an afternoon.

### What to test in Rust

Priorities, roughly in order of how much pain they've bought us:

- `part_path()` — `.with_extension("part")` collides for two models sharing a stem. There's a regression test. Don't remove it.
- `download.rs` resume — spin a local server, kill the connection mid-stream, resume, assert the hash. **And** test the server that ignores `Range`: HF redirects to a CDN that may return 200 instead of 206, and if we append to an existing `.part` we produce a corrupt file that hashes wrong an hour later.
- Checksum mismatch → `.part` removed, `dest` never created.
- Cancel → `.part` survives.
- `paths.rs` on all three OSes. This is why the Rust matrix isn't Linux-only.
- VRAM gating: 8GB card + 13GB model = disabled with a reason, never an attempt.

### What to test in the frontend

- `buildWorkflow()` patches the right nodes, doesn't mutate its input, and **throws** on a missing node ID. Silently ignoring it would let a stale manifest generate garbage.
- `comfy.ts` against a mock engine — a small server replaying recorded ComfyUI WS traffic. Covers progress events, `executing: null`, and the `400 + node_errors` path without a GPU.

Record fixtures from a real run rather than hand-writing them; ComfyUI's message shapes are not documented and hand-written fixtures encode your assumptions rather than its behaviour.

### What we don't test

Output quality. There's no assertion for "this image looks right," and pretending otherwise with a perceptual hash would produce a test that fails on a driver update. That's what §4 is for.

---

## 4. Adding a model

The highest-value contribution, and the one CI can help with least.

1. Build the workflow in ComfyUI. Export via **Settings → enable dev mode → Save (API Format)**. The normal export contains UI layout and is rejected by `/prompt`.
2. Create `registry/_staged/<id>/` with `manifest.json` + `workflow.json`.
3. Fill `tested_on` honestly — GPU, VRAM, seconds per generation, and the ComfyUI SHA you tested against. This is the only evidence the model runs.
4. `pnpm test:registry`.
5. Open the PR with sample outputs attached.

New models land in `_staged/` (`enabled: false`). Promotion to a shipped default is a separate decision — it means we're committing to support it on every user's hardware, and it needs an ADR amendment (see ADR-006). Adding a staged model is easy and welcome; promoting one is a product decision, not a PR.

**Non-negotiable:** the license. Every manifest declares one, it must be accurate, and permissive models are strongly preferred. FLUX.1-dev and FLUX.2-dev weights are non-commercial — a user selling output generated through our UI needs to know that before they do it, not after.

---

## 5. PRs

### Commit format

[Conventional Commits](https://www.conventionalcommits.org). **We squash-merge, so your PR title becomes the commit message on `main`** — that's the one that must be right, and it's checked by CI.

```
<type>(<scope>): <description>

feat(registry): add wan 2.2 staged manifest
fix(download): reset hasher when the CDN ignores Range
docs: record vouch policy as ADR-009
ci(vouch): re-label open PRs when VOUCHED.td changes
```

Rules: imperative mood, lowercase subject, no trailing period, ≤72 chars.

| Type | Use for |
|---|---|
| `feat` `fix` | User-visible capability or bug fix |
| `docs` | Including ARCHITECTURE.md and ADRs |
| `style` `refactor` `perf` `test` | No user-visible behaviour change |
| `build` `ci` `chore` `revert` | Packaging, workflows, housekeeping |

Scopes: `registry` `engine` `sidecar` `download` `updater` `comfy` `ui` `paths` `vouch` `ci` `deps`. Optional, but if you use one it must be from that list.

Commits on your branch aren't linted in CI — squash makes them scratch work. `pnpm install` sets up a local `commit-msg` hook if you want them clean anyway. Both the hook and the CI check read `commitlint.config.mjs`, so they can't disagree.

Write the title for someone reading `git log` in a year. `fix(download): handle CDN 200 response` beats `fix: address review feedback`.

### CodeRabbit

CodeRabbit reviews every non-draft PR. Its config lives in [`.coderabbit.yaml`](./.coderabbit.yaml) and it reads `ARCHITECTURE.md` and this file, so it reviews against our actual decisions and can tell you a change contradicts ADR-004.

**It cannot request changes and it cannot block your merge.** A human decides. If it's wrong, say so in a reply — it responds, and corrections become project learnings rather than an argument you have again next month.

Useful commands: `@coderabbitai review` (re-review), `@coderabbitai resolve` (clear its comments), `@coderabbitai configuration` (debug the config).

It's a first-pass reviewer, not a reviewer. It has never run this code on a GPU. It cannot tell you your manifest's `tested_on` is fiction. Treat a CodeRabbit approval as "no obvious mistakes," not "correct."

### General

- One concern per PR. A model addition and a refactor in the same diff get split.
- Architectural changes update `ARCHITECTURE.md` in the same PR. A decision that isn't written down is a decision the next person re-litigates.
- Draft PRs are fine and preferred over a surprise 2000-line diff. Neither CodeRabbit nor the title check will nag you on a draft.
- Version bumps: `package.json`, `Cargo.toml`, and `tauri.conf.json` must move together or the updater compares the wrong number and goes quiet.

### Good first issues

Look for `good first issue`. Genuinely useful and self-contained:

- Rust tests for `paths.rs` on Windows
- Error message improvements — surfacing `node_errors` in a form a human can act on
- Bootstrap progress UI
- `download.rs` edge cases

---

## 6. Reporting bugs

Include: OS + version, GPU + VRAM, app version, model, and the engine log (**Help → Open logs**). "Generation failed" without the log is unactionable — the real error is in Python, several layers from anything you can see.

Security issues: do not open a public issue. See [SECURITY.md](./SECURITY.md).
