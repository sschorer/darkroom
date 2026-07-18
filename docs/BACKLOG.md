# Darkroom — Backlog

Sequenced by risk, not by architecture. The unproven things come first.

Sizes: **S** ≈ an evening · **M** ≈ a weekend · **L** ≈ several sessions

| Milestone | Goal | Issues | Rough |
|---|---|---|---|
| **M0** Walking skeleton | One image, on your machine, ugly | 11 | 2–3 weekends |
| **M1** Registry + downloads | ADR-005 made real | 11 | 3–4 weekends |
| **M2** The app | Something you'd use daily | 11 | 4–6 weekends |
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

### #4 · feat(engine): bootstrap venv + comfyui from pinned SHA ✅
**L** · needs #2 #3 · **highest risk in the project**
- `engine/comfy.lock` holds the SHA; fetch via codeload tarball (no git dependency)
- `uv venv --python 3.12`, `uv pip install -r requirements.txt`
- Write `.version` on success; compare on boot
- **Done:** cold machine → working ComfyUI install with torch seeing CUDA
- ⚠️ Do this second, after #2. It's the assumption everything else rests on.
- Landed with **ADR-014**: `comfy.lock` is JSON pinning torch per-OS by index (PyPI's Windows torch is CPU-only — the trap the one-line sketch hid, RISK-11), and `.version` compares a digest of the whole lock, not the SHA. macOS resolves to MPS, not CUDA (TD-2). Repo moved to `Comfy-Org/ComfyUI`.

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
- `app/lib/registry.schema.ts` — the app's runtime contract *and* the CI gate
- Host allowlist, `dest` confinement under `models/`, `tested_on` required
- **Done:** app and tests share one definition

### #13 · test(registry): crossCheck validation suite
**M** · needs #12
- `registry/registry.test.ts` — params resolve against workflow, API-format detection
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

Goal: **something you'd actually open.** Built to the **Studio** design —
`docs/Darkroom Studio.dc.html` is the visual source of truth for every issue
below; "matches the mockup" is an acceptance criterion, compared at 1440 × 920.
Detailed GH issue specs live in `docs/Milestone 2 - GitHub issues.md`.

The M2 shell is a three-screen app (**Setup / Studio / Settings**) inside custom
window chrome (min/max/close, `decorations: false`). Model *selection* lives in
the compose bar; full install/remove/gating **management** moves to a new
Settings page. File #23 (foundations) before any screen work — everything
references its tokens.

### #23 · design: foundations — tokens, type, window chrome
**M** · no deps — colour tokens, Space Grotesk + JetBrains Mono type scale, and
the 1440 × 920 window shell (custom titlebar, safelight dot, min/max/close),
verbatim from the mockup. Everything else references these.
### #24 · feat(ui): Studio shell — left rail + screen routing
**M** · needs #23 — Setup/Studio/Settings routing; 184px left rail (Library
counts, live queue block, pinned ⚙ Settings button)
### #25 · feat(ui): compose bar + model selector
**M** · needs #24 #16 #20 — floating compose bar; model-selector pill with VRAM
gating reasons + license (OC-2); prompt input; param chips; Generate
### #26 · feat(ui): manifest-driven params form
**M** · needs #16 #20 — fields generated from `params` (min/max/default); feed
`buildWorkflow()`, throw on missing node; rendered as the compose-bar chips (#25)
### #27 · feat(ui): generation queue + live-generating tile
**M** · needs #10 — submit, sequential, cancel; `client_id` matches WS + `/prompt`;
in-grid live tile (step bar + cancel) that the finished image replaces
### #28 · feat(ui): gallery + selected preview
**M** · needs #27 — 452px selected preview (★/⤓, recipe chips, ↻ reuse recipe) +
4-col grid; `/view` bytes → `blob:` (ADR-008); image and video both render
### #29 · feat(ui): error surfacing
**M** · needs #8 #10 — node-error banner above the compose bar + failed tile in
the grid, text driven by real `node_errors`; engine-log tail on spawn failure
(QS-3); version-skew blocks generation until `.version == comfy.lock`
### #30 · feat(ui): Settings — model manager + engine + storage + privacy
**L** · needs #24 #17 #21 — install/remove, storage meter, VRAM gating (disable,
don't hide), engine info, privacy toggle, per-model licenses before install (OC-2)
### #31 · feat(ui): first-run onboarding
**M** · needs #27 #21 — bootstrap → pick a model → first prompt as one flow; byte
progress, not a spinner; a non-technical user reaches their first image (Q2)
### #32 · feat(ui): offline verification
**S** · needs #27 — QS-1: pull the network, generate, assert nothing degrades but
the skippable update check
### #33 · design: visual pass sign-off
**L** · needs #31 — final QA that the built app matches the mockup across Setup,
Studio, and Settings; no default framework styling remains

---

## M3 — Distribution

Goal: **a stranger can install it.**

### #34 · ci: registry + frontend + rust jobs
**M** · needs #13 — `pull_request`, never `pull_request_target`; rust matrix ×3 OS
### #35 · ci: bundle smoke matrix
**M** · needs #34 — `tauri build --no-bundle`, unsigned must succeed or forks can't build
### #36 · build: appimage
**M** · needs #35 — build on **ubuntu-22.04** (TC-4); bundle WebKitGTK
### #37 · build: macos dmg ×2 arch — filed early as [GH #23](https://github.com/sschorer/darkroom/issues/23)
**L** · needs #35 — **includes the notarization decision (RISK-2).** $99/yr or ship unsigned with `xattr` docs. Decide before writing code; it changes the updater's behaviour.
### #38 · build: windows nsis — filed early as [GH #24](https://github.com/sschorer/darkroom/issues/24)
**M** · needs #35
### #39 · feat(updater): keys + latest.json + check flow
**L** · needs #36 #37 #38 — minisign keypair, **offline backup** (RISK-3), defer while queue busy
### #40 · feat(updater): engine teardown on update
**S** · needs #39 #9 — `on_before_exit`; NSIS kills the process without asking
### #41 · test: the actual upgrade path
**M** · needs #39 · **the one everyone skips**
- Ship v0.1.0, install for real, tag v0.1.1, let it update itself
- **Done:** it works on all three platforms. Almost every updater bug only exists on the second version.
### #42 · ci: release workflow
**M** · needs #39 — `tauri-action`, 4-way matrix, `includeUpdaterJson`, draft releases

---

## M4 — Public

Goal: **someone else can contribute.**

### #43 · ci(vouch): pr-vouch + vouch-manage
**S** — files written; add your handle to `VOUCHED.td`
### #44 · chore: coderabbit config
**S** — written; needs the GitHub App installed
### #45 · ci: pr title check + commitlint
**S** — plus repo settings: **squash-only**, default message = **PR title**
### #46 · docs: SECURITY.md
**S** · ⚠️ CONTRIBUTING already links to this and it doesn't exist
### #47 · docs: issue + PR templates
**M** — model PR template carrying the `tested_on` attestation checklist
### #48 · docs: README + screenshots
**M** — the thing that decides whether anyone tries it
### #49 · feat(registry): stage wan22 + z-image-turbo
**M** · needs #13 — `enabled: false`, real `tested_on`; proves the middle path works
### #50 · chore: v0.1.0
**S** · needs #41 — branch protection on, publish the draft

---

## Notes

**Numbers in this file are plan numbers, not GitHub issue numbers.** They coincide for #1–#22 (M0+M1, seeded in order). They diverge for anything filed out of sequence: macOS bundling is plan #37 but [GH #23](https://github.com/sschorer/darkroom/issues/23), Windows is plan #38 but [GH #24](https://github.com/sschorer/darkroom/issues/24). M2's live GH issues are **GH #52–#62**, plan #23–#33 in order (see `docs/Milestone 2 - GitHub issues.md`), so the plan numbers ≠ their GH numbers here too. Cite `GH #n` when you mean the live issue.

**Order that matters:** #4 before anything else substantial. #11 gates M1. #23 (foundations) before any other M2 screen work — everything references its tokens. #18 and #41 are the two tests that get skipped and shouldn't be — they're the tests for bugs that appear an hour later on someone else's machine.

**Order that doesn't:** M4 is nearly all done already; it's just files that need enabling.

**Parallelisable if you're not alone:** M2's UI work (#23–#33) against M1's plumbing, once #23 lands. Everything in M0 is serial.
