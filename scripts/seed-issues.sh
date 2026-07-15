#!/usr/bin/env bash
# Seeds labels, milestones and the M0/M1 backlog into GitHub.
#
#   gh auth login
#   ./scripts/seed-issues.sh --dry-run     # look first
#   ./scripts/seed-issues.sh
#
# Idempotent-ish: re-running creates duplicate issues, so run it once.
# M2-M4 are deliberately omitted — see docs/BACKLOG.md. Don't seed work you
# might not do; a backlog of 48 open issues reads as an abandoned project to
# anyone who finds the repo.

set -euo pipefail

DRY=""
[[ "${1:-}" == "--dry-run" ]] && DRY="echo [dry-run]"

run() { $DRY gh "$@"; }

echo "==> Labels"
while IFS='|' read -r name color desc; do
  run label create "$name" --color "$color" --description "$desc" --force
done <<'EOF'
milestone:m0|0e8a16|Walking skeleton
milestone:m1|1d76db|Registry + downloads
size:s|c2e0c6|An evening
size:m|fef2c0|A weekend
size:l|f9d0c4|Several sessions
area:engine|5319e7|ComfyUI bootstrap and lifecycle
area:registry|5319e7|Manifests and workflows
area:download|5319e7|Weight fetching
area:ui|5319e7|Frontend
area:ci|5319e7|Workflows and packaging
risk:high|b60205|Unproven; may invalidate the architecture
good first issue|7057ff|Self-contained
EOF

echo "==> Milestones"
for m in "M0 - Walking skeleton" "M1 - Registry + downloads" \
         "M2 - The app" "M3 - Distribution" "M4 - Public"; do
  $DRY gh api "repos/{owner}/{repo}/milestones" -f title="$m" --silent 2>/dev/null \
    || echo "    (exists: $m)"
done

new() { # title | labels | milestone | body
  run issue create --title "$1" --label "$2" --milestone "$3" --body "$4"
}

echo "==> M0"
M0="M0 - Walking skeleton"

new "chore: scaffold tauri 2 + react + ts" "milestone:m0,size:s,area:ci" "$M0" \
"React + TS + Tailwind via create-tauri-app, pnpm.

- [ ] CSP set with \`connect-src http://127.0.0.1:* ws://127.0.0.1:*\` from day one — the engine port is dynamic (ARCHITECTURE §8.4)
- [ ] Version aligned across package.json, Cargo.toml, tauri.conf.json

**Done:** \`pnpm tauri dev\` opens a window."

new "build: fetch uv sidecar per target triple" "milestone:m0,size:s,area:ci" "$M0" \
"Ship uv (~30MB) as the only bundled binary. See ADR-004.

- [ ] \`scripts/fetch-uv.mjs\` downloads the release asset
- [ ] Named \`uv-<triple>[.exe]\` — Tauri's externalBin resolver requires this exactly
- [ ] Wired into tauri.conf.json

**Done:** \`uv --version\` runs via the sidecar on all three OSes."

new "feat(paths): appdata layout + helpers" "milestone:m0,size:s,area:engine" "$M0" \
"Single source of truth for the appdata layout (ARCHITECTURE §7.2).

- [ ] engine/, models/, outputs/ resolution
- [ ] \`.venv/bin/python\` vs \`.venv/Scripts/python.exe\`
- [ ] Unit tests

**Done:** tests pass on Linux, macOS and Windows. This is why the Rust CI matrix isn't Linux-only."

new "feat(engine): bootstrap venv + comfyui from pinned SHA" \
  "milestone:m0,size:l,area:engine,risk:high" "$M0" \
"**The highest-risk issue in the project.** Everything else assumes this works.

- [ ] Read the SHA from \`engine/comfy.lock\`
- [ ] Fetch via codeload tarball — do not require git on the user's machine
- [ ] \`uv venv --python 3.12\` then \`uv pip install -r requirements.txt\`
- [ ] Write \`.version\`; compare against comfy.lock on boot

**Done:** cold machine to working ComfyUI with torch seeing CUDA, on all three OSes.

If this can't be made reliable, ADR-004 is wrong and the architecture needs rethinking. Find out now."

new "feat(engine): bootstrap progress reporting" "milestone:m0,size:m,area:engine" "$M0" \
"~10 minutes, ~6GB. A spinner is not acceptable UX for that.

- [ ] Stream uv + download progress to the frontend
- [ ] Phase + byte count

**Done:** a first-time user can tell it's working rather than hung. (Quality goal Q2.)"

new "feat(sidecar): free-port allocation + spawn" "milestone:m0,size:m,area:engine" "$M0" \
"ADR-007.

- [ ] Bind 127.0.0.1:0, take the port, drop the listener
- [ ] \`--listen 127.0.0.1\` (never 0.0.0.0), \`--disable-auto-launch\`
- [ ] \`PYTHONUNBUFFERED=1\`

**Done:** engine starts cleanly while the user's own ComfyUI holds 8188."

new "feat(sidecar): health polling" "milestone:m0,size:s,area:engine" "$M0" \
"- [ ] Poll \`/system_stats\` at 500ms, give up at 120s

**Done:** \`start_engine\` returns a port only once the engine actually answers."

new "feat(sidecar): log pump" "milestone:m0,size:s,area:engine" "$M0" \
"The engine fails in Python, several layers from anything the user can see.

- [ ] stdout/stderr to a rotating file + a frontend channel
- [ ] Help → Open logs

**Done:** a Python traceback is readable without a terminal."

new "feat(sidecar): teardown + stale PID recovery" "milestone:m0,size:m,area:engine" "$M0" \
"A leaked engine holds several GB of VRAM and makes the next launch fail with an OOM the user can't explain. ARCHITECTURE §8.3.

- [ ] Kill on \`RunEvent::ExitRequested\`
- [ ] PID file, checked at next boot
- [ ] (\`on_before_exit\` arrives with the updater in M3)

**Done:** \`kill -9\` the app, relaunch, GPU is reclaimed. (QS-6.)"

new "feat(comfy): minimal client" "milestone:m0,size:m,area:ui" "$M0" \
"- [ ] \`POST /prompt\` with client_id
- [ ] WS \`/ws?clientId=\` — progress, executing, execution_error
- [ ] Skip binary frames (preview images) before JSON.parse
- [ ] \`/history/{id}\` then \`/view\`

**Done:** progress events arrive. They won't if client_id differs between the WS and the POST body — budget an afternoon for exactly that."

new "spike: hardcoded generation end-to-end" "milestone:m0,size:m,area:ui,risk:high" "$M0" \
"🚪 **Milestone gate.**

Deliberately ugly: hand-place FLUX.2 klein weights, hardcode the workflow JSON, one button.

- [ ] Prompt in, image out

**Done:** an image appears in the window.

Then write down everything that hurt — that list is the real input to M1, more than the schema we designed on paper."

echo "==> M1"
M1="M1 - Registry + downloads"

new "feat(registry): zod schema + types" "milestone:m1,size:m,area:registry" "$M1" \
"ADR-005. The app's runtime contract AND the CI gate — one definition or they drift.

- [ ] Manifest + Workflow + crossCheck in \`src/lib/registry.schema.ts\`
- [ ] Host allowlist on \`files[].url\`
- [ ] \`dest\` relative, no \`..\`, confined to models/
- [ ] \`tested_on\` required

**Done:** app and tests import the same schema."

new "test(registry): crossCheck validation suite" "milestone:m1,size:m,area:registry" "$M1" \
"The most valuable test in the repo — CI has no GPU (ADR-010), so this is the only cheap check that a model is wired correctly.

- [ ] Every manifest, shipped and staged
- [ ] params node IDs resolve against the workflow
- [ ] UI-export detection (\`nodes\`/\`links\` keys present)
- [ ] Exactly one enabled image + one enabled video model (ADR-006)

**Done:** a deliberately broken manifest fails in under 10s."

new "feat(registry): flux2-klein manifest + workflow" "milestone:m1,size:m,area:registry" "$M1" \
"- [ ] Export via Settings → dev mode → **Save (API Format)**. The normal export contains UI layout and \`/prompt\` rejects it.
- [ ] Real sha256 + size
- [ ] Honest \`tested_on\`

**Done:** \`pnpm test:registry\` green."

new "feat(registry): ltx-video manifest + workflow" "milestone:m1,size:m,area:registry" "$M1" \
"- [ ] As flux2-klein
- [ ] Note: video nodes return outputs under \`gifs\`, not \`images\` — the client handles both

**Done:** a clip generates from the registry path."

new "feat(workflow): buildWorkflow" "milestone:m1,size:s,area:registry" "$M1" \
"- [ ] Deep-clone before patching; never mutate the caller's workflow
- [ ] **Throw** on a node ID absent from the workflow

**Done:** unit tests cover the throw and the no-mutation case. Silently skipping a missing node lets a stale manifest generate garbage — the exact failure ADR-005 predicts."

new "feat(download): resumable verified fetch" "milestone:m1,size:l,area:download" "$M1" \
"12–16GB per model.

- [ ] \`.part\` via **append** — \`with_extension(\"part\")\` collides for two models sharing a stem
- [ ] Re-hash existing \`.part\` on resume (you can't resume a SHA-256)
- [ ] Atomic rename only after verification
- [ ] Throttled progress (~250ms); per-chunk emit floods IPC
- [ ] No total request timeout — these run for an hour

**Done:** a 14GB download survives a network drop and resumes."

new "test(download): the nasty cases" "milestone:m1,size:m,area:download" "$M1" \
"**Do not skip.** These are the bugs that surface an hour into a download on someone else's machine.

- [ ] Local server that **ignores Range**: HF redirects to a CDN that may return 200 instead of 206. Must reset both file offset and hasher, or we append to existing bytes and produce a corrupt file that fails its hash an hour later.
- [ ] Checksum mismatch → \`.part\` removed, \`dest\` never created
- [ ] Cancel → \`.part\` survives, next run resumes

**Done:** all three pass. (QS-7.)"

new "feat(download): free-space precheck" "milestone:m1,size:s,area:download" "$M1" \
"- [ ] \`sum(files.size) * 1.1\` via fs4 before the first byte

**Done:** insufficient space refuses up front rather than filling the root partition at 12/14GB."

new "feat(registry): VRAM gating" "milestone:m1,size:m,area:registry" "$M1" \
"Quality goal Q5: never offer what the hardware can't run.

- [ ] Read \`vram_total\` from /system_stats at boot
- [ ] Compare against \`requires.vram_gb\`
- [ ] **Disable, don't hide** — with the reason visible

**Done:** an 8GB card sees a 13GB model greyed out with an explanation, never an OOM. (QS-8.)"

new "feat(ui): download manager" "milestone:m1,size:m,area:ui" "$M1" \
"- [ ] Per-file progress, speed, ETA
- [ ] Resume, cancel
- [ ] Verifying state while re-hashing a \`.part\`

**Done:** install a model from clean state without a terminal."

new "test(comfy): mock engine" "milestone:m1,size:m,area:ui" "$M1" \
"ADR-010: the engine boundary can only ever be tested against a mock.

- [ ] **Record** real WS traffic — don't hand-write fixtures. ComfyUI's message shapes are undocumented; hand-written ones encode your assumptions rather than its behaviour.
- [ ] Cover progress, \`executing: null\`, \`400 + node_errors\`

**Done:** the client is tested with no GPU."

echo
echo "Done. M2-M4 intentionally not seeded — see docs/BACKLOG.md."
