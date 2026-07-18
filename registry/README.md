# registry

One directory per model, each holding a `manifest.json` and its API-format
workflow. Weights never live here — manifests carry URLs, downloads land in
appdata (ADR-005).

```
registry/
  flux2-klein/         # enabled image default
    manifest.json
    workflow.json
  ltx-video/           # enabled video default
    manifest.json
    workflow.json
  _staged/             # enabled: false, not offered in the UI
    wan22/
      manifest.json
      workflow.json
```

Two shipping defaults: flux2-klein for images (`#14`), ltx-video for video
(`#15`). ADR-006 fixes it at exactly one enabled model per kind — the suite
enforces that, so promoting a staged model means demoting the incumbent.

Video outputs come back under `gifs` rather than `images`; the client
(`app/lib/comfy.ts`) flattens both, so a clip surfaces the same way a still does.

`registry.test.ts` sits here rather than in a top-level `tests/` because the
data it validates is this directory (ADR-012). It reads the directory at
module load; every non-directory entry — itself, this README — is skipped.

New models go in `_staged/` with `enabled: false`. Promoting one to a default
is a product decision needing an ADR-006 amendment, not a PR.
