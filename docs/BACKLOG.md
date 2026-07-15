# Darkroom — Backlog

Sequenced by risk, not by architecture. The unproven things come first.

Sizes: **S** ≈ an evening · **M** ≈ a weekend · **L** ≈ several sessions

| Milestone | Goal | Issues | Rough |
|---|---|---|---|
| **M0** Walking skeleton | One image, on your machine, ugly | 11 | 2–3 weekends |
| **M1** Registry + downloads | ADR-005 made real | 11 | 3–4 weekends |
| **M2** The app | Something you'd use daily | 9 | 4–6 weekends |
| **M3** Distribution | Installable by strangers | 9 | 3–4 weekends |
| **M4** Public | Contributions possible | 8 | 2 weekends |

**Cut line: M2.** Stop there and you have a private tool that works. M3+M4 exist only to serve users you don't have yet.

---

## M0 — Walking skeleton

Goal: **a hardcoded prompt produces a real image.** No registry, no downloads UI, no updater. If this milestone fails, ARCHITECTURE.md is wrong and better rewritten now.

### #1 · chore: scaffold tauri 2 + react + ts
**S** · no deps
- `create-tauri-app`, React + TS + Tailwind, pnpm
- CSP configured with `connect-src http://127.0.0.1:* ws://127.0.0.1:*` from day one (§8.4)
- Versions aligned across `package.json`, `Cargo.toml`, `tauri.conf.json`
- **Done:** `pnpm tauri dev` opens a window on your OS

### #2 · build: fetch uv sidecar per target triple
**S** · needs #1
- `scripts/fetch-uv.mjs` downloads the uv release asset, names it `uv-<triple>[.exe]`
- Wire `externalBin` in `tauri.conf.json`
- **Done:** `uv --version` runs via the sidecar on Linux, macOS, Windows

### #3 · feat(paths): appdata layout + helpers
**S** · needs #1
- `paths.rs`: single source of truth for `engine/`, `models/`, `outputs/`
- Handles `.venv/bin/python` vs `.venv/Scripts/python.exe`
- **Done:** unit tests pass on all three OSes in CI

### #4 · feat(engine): bootstrap venv + comfyui from pinned SHA
**L** · needs #2 #3 · **highest risk in the project**
- `engine/comfy.lock` holds the SHA; fetch via codeload tarball (no git dependency)
- `uv venv --python 3.12`, `uv pip install -r requirements.txt`
- Write `.version` on success; compare on boot
- **Done:** cold machine → working ComfyUI install with torch seeing CUDA
- ⚠️ Do this second, after #2. It's the assumption everything else rests on.

### #5 · feat(engine): bootstrap progress reporting
**M** · needs #4
- Stream uv/download progress to the frontend
- Byte counts and phase, not a spinner — this runs 10 minutes
- **Done:** a first-time user can tell it's working, not hung

### #6 · feat(sidecar): free-port allocation + spawn
**M** · needs #4
- Bind `127.0.0.1:0`, take port, drop, pass to ComfyUI
- `--listen 127.0.0.1`, `--disable-auto-launch`, `PYTHONUNBUFFERED=1`
- **Done:** engine starts on a random port with the user's own ComfyUI running on 8188

### #7 · feat(sidecar): health polling
**S** · needs #6
- Poll `/system_stats` up to 120s
- **Done:** `start_engine` returns a port only when the engine really answers

### #8 · feat(sidecar): log pump
**S** · needs #6
- stdout/stderr → rotating file + frontend channel
- **Done:** a Python traceback is visible without a terminal

### #9 · feat(sidecar): teardown + stale PID recovery
**M** · needs #6
- `RunEvent::ExitRequested` + PID file checked at next boot
- (`on_before_exit` lands with the updater in #33)
- **Done:** `kill -9` the app → next launch reclaims the GPU

### #10 · feat(comfy): minimal client
**M** · needs #7
- `POST /prompt` with `client_id`, WS progress, `/history`, `/view`
- **Done:** progress events arrive (they won't if `client_id` mismatches)

### #11 · spike: hardcoded generation end-to-end
**M** · needs #10 · **🚪 milestone gate**
- Manually download FLUX.2 klein, hand-place weights, hardcode a workflow
- One button, one prompt, one image
- **Done:** an image appears in the window
- Write down what hurt. It's the input to M1.

---

## M1 — Registry + downloads

Goal: **ADR-005 stops being a theory.** Models become data.

### #12 · feat(registry): zod schema + types
**M** · needs #11
- `src/lib/registry.schema.ts` — the app's runtime contract *and* the CI gate
- Host allowlist, `dest` confinement under `models/`, `tested_on` required
- **Done:** app and tests share one definition

### #13 · test(registry): crossCheck validation suite
**M** · needs #12
- `tests/registry.test.ts` — params resolve against workflow, API-format detection
- **Done:** a deliberately broken manifest fails in <10s

### #14 · feat(registry): flux2-klein manifest + workflow
**M** · needs #12
- Export via **Save (API Format)**, real sha256/size, honest `tested_on`
- **Done:** `pnpm test:registry` green

### #15 · feat(registry): ltx-video manifest + workflow
**M** · needs #14
- Video outputs come back under `gifs`, not `images` — the client must handle both
- **Done:** as #14

### #16 · feat(workflow): buildWorkflow
**S** · needs #12
- Deep-clone, patch by node ID, **throw** on missing node
- **Done:** unit tests incl. the throw and the no-mutation case

### #17 · feat(download): resumable verified fetch
**L** · needs #3
- `.part` + append (not `with_extension`), SHA-256, atomic rename
- Throttled progress, no total timeout
- **Done:** 14GB download survives a network drop

### #18 · test(download): the nasty cases
**M** · needs #17 · **do not skip**
- Local server that **ignores `Range`** → must reset offset *and* hasher
- Checksum mismatch → `.part` removed, `dest` never created
- Cancel → `.part` survives
- **Done:** all three pass

### #19 · feat(download): free-space precheck
**S** · needs #17
- `sum(size) * 1.1` via `fs4` before starting
- **Done:** insufficient space refuses up front, not at 12/14GB

### #20 · feat(registry): VRAM gating
**M** · needs #12 #7
- Read real VRAM, disable — don't hide — models that don't fit, with the reason
- **Done:** 8GB card sees klein disabled and knows why

### #21 · feat(ui): download manager
**M** · needs #17 #19
- Per-file progress, speed, resume, cancel
- **Done:** install a model from a clean state without a terminal

### #22 · test(comfy): mock engine
**M** · needs #10
- Replay **recorded** WS traffic (don't hand-write — ComfyUI's shapes are undocumented)
- **Done:** progress, `executing: null`, and `400 + node_errors` covered with no GPU

---

## M2 — The app

Goal: **something you'd actually open.**

### #23 · feat(ui): manifest-driven params form
**M** · needs #16 #20 — form fields generated from `params`, respecting min/max/default
### #24 · feat(ui): generation queue
**M** · needs #10 — submit, progress, cancel, sequential
### #25 · feat(ui): gallery
**M** · needs #24 — render `/view` outputs, image + video
### #26 · feat(ui): history in sqlite
**M** · needs #25 — prompt, seed, model, params; re-use a past generation's settings
### #27 · feat(ui): model picker
**S** · needs #20 #21 — install state, gating reasons, license shown (OC-2)
### #28 · feat(ui): error surfacing
**M** · needs #8 #10 — `node_errors` by name; engine log tail on spawn failure (QS-3)
### #29 · feat(ui): first-run onboarding
**M** · needs #5 #21 — bootstrap → pick a model → first prompt, as one flow
### #30 · feat(ui): offline verification
**S** · needs #24 — QS-1: pull the network, generate, assert nothing degrades
### #31 · design: visual pass
**L** · needs #29 — it's a *darkroom*; make it look like one, not a bootstrap template

---

## M3 — Distribution

Goal: **a stranger can install it.**

### #32 · ci: registry + frontend + rust jobs
**M** · needs #13 — `pull_request`, never `pull_request_target`; rust matrix ×3 OS
### #33 · ci: bundle smoke matrix
**M** · needs #32 — `tauri build --no-bundle`, unsigned must succeed or forks can't build
### #34 · build: appimage
**M** · needs #33 — build on **ubuntu-22.04** (TC-4); bundle WebKitGTK
### #35 · build: macos dmg ×2 arch
**L** · needs #33 — **includes the notarization decision (RISK-2).** $99/yr or ship unsigned with `xattr` docs. Decide before writing code; it changes the updater's behaviour.
### #36 · build: windows nsis
**M** · needs #33
### #37 · feat(updater): keys + latest.json + check flow
**L** · needs #34 #35 #36 — minisign keypair, **offline backup** (RISK-3), defer while queue busy
### #38 · feat(updater): engine teardown on update
**S** · needs #37 #9 — `on_before_exit`; NSIS kills the process without asking
### #39 · test: the actual upgrade path
**M** · needs #37 · **the one everyone skips**
- Ship v0.1.0, install for real, tag v0.1.1, let it update itself
- **Done:** it works on all three platforms. Almost every updater bug only exists on the second version.
### #40 · ci: release workflow
**M** · needs #37 — `tauri-action`, 4-way matrix, `includeUpdaterJson`, draft releases

---

## M4 — Public

Goal: **someone else can contribute.**

### #41 · ci(vouch): pr-vouch + vouch-manage
**S** — files written; add your handle to `VOUCHED.td`
### #42 · chore: coderabbit config
**S** — written; needs the GitHub App installed
### #43 · ci: pr title check + commitlint
**S** — plus repo settings: **squash-only**, default message = **PR title**
### #44 · docs: SECURITY.md
**S** · ⚠️ CONTRIBUTING already links to this and it doesn't exist
### #45 · docs: issue + PR templates
**M** — model PR template carrying the `tested_on` attestation checklist
### #46 · docs: README + screenshots
**M** — the thing that decides whether anyone tries it
### #47 · feat(registry): stage wan22 + z-image-turbo
**M** · needs #13 — `enabled: false`, real `tested_on`; proves the middle path works
### #48 · chore: v0.1.0
**S** · needs #39 — branch protection on, publish the draft

---

## Notes

**Order that matters:** #4 before anything else substantial. #11 gates M1. #18 and #39 are the two that get skipped and shouldn't be — they're the tests for bugs that appear an hour later on someone else's machine.

**Order that doesn't:** M4 is nearly all done already; it's just files that need enabling.

**Parallelisable if you're not alone:** M2's UI work (#23–#31) against M1's plumbing. Everything in M0 is serial.
