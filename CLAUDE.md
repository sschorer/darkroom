# Darkroom

Tauri 2 desktop app. Generates images and video with AI models running locally on the user's GPU, via a bundled ComfyUI subprocess. GPL-3.0.

**Read `ARCHITECTURE.md` (arc42) before non-trivial work — §9 holds the ADRs.** Don't re-derive decisions; if you disagree with one, say so and amend the ADR. `docs/BACKLOG.md` has the sequenced plan.

## Commands

```bash
make dev                          # run
make test-registry                # manifest validation — fastest real signal
make check                        # everything CI gates
make                              # list every target
```

The flags live in the `Makefile` and only there. Don't paste a copy here —
CI is the only true copy, and a stale one in this file is worse than none.

## Traps

Things that are wrong in ways you can't see from the code:

- **`ci.yml` uses `pull_request`. `pr-vouch.yml` and `pr-title.yml` use `pull_request_target`.** This is deliberate and load-bearing. A `pull_request_target` workflow must never check out or execute PR code — that's a repo takeover. Never "unify" them.
- **No CI runner has a GPU.** Nothing in CI can generate an image. Green CI ≠ a working model. This constrains every test decision (ADR-010).
- **`externalBin` breaks `cargo`, not just the bundle.** `native/binaries/uv-<triple>[.exe]` must exist or `tauri-build` fails at compile time — clippy and `cargo test` included. Every `make` target that runs cargo depends on `sidecar`; CI fetches it in each cargo job. The `-<triple>` suffix is Tauri's resolver contract, not our convention.
- **PyPI's `torch` is CPU-only on Windows.** ComfyUI's `requirements.txt` pins no torch, so `uv pip install -r requirements.txt` alone gives a Windows user a ComfyUI that installs, imports, and renders at ~20 min/image with no error. The bootstrap installs torch from `comfy.lock`'s per-OS `torch.index_url` *first*, with `--index-url` (replace PyPI, not `--extra-index-url` — the extra index lets uv pick PyPI's CPU wheel back). Invisible on Linux, uncatchable in CI (no GPU). ADR-014.
- **`.version` compares a digest of the whole `comfy.lock`, not the SHA.** Changing `torch.index_url` invalidates every venv while leaving `sha` untouched; a SHA-only check would call those installs healthy forever. `comfy.lock` is compiled in with `include_str!`, so a malformed edit is a build failure here, not a first-run crash on a user's machine.
- **The engine tarball is the one artifact not checked against a pinned hash.** GitHub's codeload archives aren't byte-stable, so the commit SHA in the URL path plus TLS is the integrity claim. Don't add a digest pin for it — it would fail on GitHub's schedule, not ours.
- **ComfyUI workflows must be API-format exports** (Settings → dev mode → Save (API Format)). The normal export carries UI layout and `/prompt` rejects it.
- **`client_id` must be identical** on the WS query string and in the `/prompt` body, or zero progress events arrive and nothing errors.
- **ComfyUI must be spawned with `--enable-cors-header`.** By default it installs an `origin_only_middleware` that 403s any request carrying `Sec-Fetch-Site: cross-site` or a mismatched `Origin`. The WebView is a *different* origin from the engine (`tauri://localhost` → `127.0.0.1:<port>`), so every frontend `fetch`/WebSocket is 403'd — yet the Rust health probe (`reqwest`, no such headers) returns 200, so the engine looks healthy while refusing the frontend. The flag is what makes ADR-008 work; loopback + random port (ADR-007) is why dropping the origin gate is safe.
- **Never `.with_extension("part")`** in `download.rs` — it drops the real extension and collides for two models sharing a stem. Append instead.
- **A `Range` request that returns 200, not 206, means the body starts at byte 0.** Reset the file offset *and* the hasher. HF redirects to a CDN that may ignore Range. Getting this wrong yields a corrupt file that fails its hash an hour later.
- **Sidecar teardown must exist in three places**: `RunEvent::ExitRequested`, the updater's `on_before_exit` (NSIS kills us without asking), and a stale-PID check at boot. Miss one and a 6GB process holds the GPU; the next launch OOMs inexplicably.
- **Never set CSP to null.** `connect-src` needs `http://127.0.0.1:* ws://127.0.0.1:*` because the engine port is dynamic. Weakening CSP to "make it work" is the wrong fix.
- **Version must match across `package.json`, `Cargo.toml`, `tauri.conf.json`, and the git tag.** A mismatch makes the updater compare the wrong number and go silently dead.
- **Build Linux on ubuntu-22.04.** glibc isn't forward-compatible; a newer runner raises the floor and breaks LTS users.
- **`buildWorkflow` must throw on a missing node ID.** Silently skipping lets a stale manifest generate garbage (ADR-005).
- **New models go in `registry/_staged/` with `enabled: false`.** Promoting one to a default is a product decision needing an ADR-006 amendment, not a PR.
- **Weights never enter the repo.** Manifests hold URLs; downloads land in appdata.
- **`make dev`, not `pnpm tauri dev`, on Linux/NVIDIA.** WebKitGTK's dmabuf renderer deadlocks the NVIDIA driver when the dev webview tears down: a thread wedges in `exit_mmap` unmapping GPU memory as an unkillable D-state task, no signal touches it, the frozen window can't be closed, and only a reboot recovers. The `dev` target disables that renderer (the flag lives in the Makefile, like every other); running `tauri dev` bare skips it and reintroduces the hang.

## Conventions

- **Conventional Commits.** We squash-merge, so the **PR title** is the commit message and the only thing CI lints. Types: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`. Scopes: `registry` `engine` `sidecar` `download` `updater` `comfy` `ui` `paths` `vouch` `ci` `deps`. Lowercase subject, no trailing period, ≤72 chars.
- **Architecture docs are arc42.** New decisions go in `ARCHITECTURE.md` §9 as ADRs with Context / Decision / Rationale / Consequences / Alternatives. An architectural change without an ADR gets re-litigated in six months.
- **No `.unwrap()`/`.expect()`** on anything reachable from user input, the filesystem, or the network. This is a desktop app: a panic is a window vanishing with no explanation.
- **Errors must be actionable.** The engine fails in Python, layers from anything the user sees. Surface `node_errors` (it names the failing node) and the engine log tail — never a bare status code.
- The schema in `app/lib/registry.schema.ts` is both the app's runtime contract and the CI gate. One definition. Don't fork it.

<!-- Maintainer note: stripped before injection, costs no context.
     Keep this file under ~100 lines. If you're tempted to add architecture
     overviews or directory layouts, don't — /doctor will trim them anyway,
     and ARCHITECTURE.md already has them. Only add things that are wrong
     in non-obvious ways. -->
