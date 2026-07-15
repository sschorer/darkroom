# Darkroom

Generate images and short videos with AI models running **entirely on your own
GPU**. No cloud, no API keys, no per-generation cost. No prompt leaves the
machine.

[![License: GPL-3.0](https://img.shields.io/badge/License-GPLv3-blue.svg)](LICENSE)

---

## Status: early. Nothing generates yet.

This is an honest scaffold, not a working app. There is a window, and that is
currently all there is — no engine, no models, no generation. The first real
image arrives at [#11](https://github.com/sschorer/darkroom/issues/11), which
gates the rest of the plan.

Don't install this expecting a tool yet. If you want to follow along or help,
[docs/BACKLOG.md](docs/BACKLOG.md) is the sequenced plan and
[#4](https://github.com/sschorer/darkroom/issues/4) is the bet the whole
project rests on.

## The idea

ComfyUI is the best local inference engine there is, and it is a node graph
aimed at people who want a node graph. Darkroom bundles it as an
implementation detail and puts a plain app in front of it: pick a model, type
a prompt, get a picture. Models are data ([ADR-005](ARCHITECTURE.md)) — adding
one is a manifest, not a code change.

Deliberately **not** in scope for v1: batch pipelines, cloud fallback, node
graph editing (that's ComfyUI's job), training or LoRA fine-tuning, mobile.

## Requirements

| | |
|---|---|
| GPU | NVIDIA, **≥8GB VRAM**. Hardware gating is a feature: a model that won't fit is disabled with the reason shown, never an OOM. |
| Disk | ~6GB for the engine, plus **12–16GB per model** |
| OS | Linux x86_64, macOS, Windows |

First launch bootstraps a private Python environment and ComfyUI at a pinned
commit (~10 minutes, ~6GB). Nothing is installed system-wide; weights never
enter the repo and land in appdata.

## Developing

```bash
make doctor     # what's missing on this machine
make install    # JS dependencies
make dev        # run the app
make check      # everything CI gates — run before pushing
make            # list every target
```

`make doctor` prints the system packages you need. On Linux that's WebKitGTK
**4.1** — Tauri v2 will not build without it.

`make check` currently fails on `test-registry`, and that is correct: it
reports the registry as empty until
[#14](https://github.com/sschorer/darkroom/issues/14) lands the first
manifest.

## Layout

```text
app/        webview side — React, and the registry schema
native/     everything cargo builds — Tauri, sidecar, downloads
registry/   model manifests + the suite that validates them
docs/       BACKLOG.md — the sequenced plan
```

`app/` and `native/` rather than `src/` and `src-tauri/`: no directory is
named after the tool that made it. See ADR-012.

## Docs

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — arc42; §9 holds the ADRs. Read this
  before non-trivial work; the decisions are already made and argued.
- **[docs/BACKLOG.md](docs/BACKLOG.md)** — sequenced by risk, not by
  architecture.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — how to contribute, including adding
  a model.
- **[CLAUDE.md](CLAUDE.md)** — the traps. Things that are wrong in ways you
  can't see from the code.

## Contributing

Yes, please — especially models. Adding one is a manifest and an API-format
workflow, and the validation suite tells you in ten seconds whether you got it
right. CI has no GPU, so a model's `tested_on` attestation is the only
evidence it runs; we take that seriously.

Read [CONTRIBUTING.md](CONTRIBUTING.md) first.

## License

[GPL-3.0](LICENSE). ComfyUI is GPL-3.0 and Darkroom bundles it — that settles
the question rather than working around it.

Model licenses vary and are **not** the app's license. Every manifest declares
its own; only permissive models ship enabled by default.
