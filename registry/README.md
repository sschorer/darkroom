# registry

One directory per model, each holding a `manifest.json` and its API-format
workflow. Weights never live here — manifests carry URLs, downloads land in
appdata (ADR-005).

```
registry/
  flux2-klein/
    manifest.json
    workflow.json
  _staged/            # enabled: false, not offered in the UI
    wan22/
      manifest.json
      workflow.json
```

No models yet. `#14` adds the first manifest (flux2-klein), `#15` adds
ltx-video. Until then `pnpm test:registry` reports the registry as empty —
that is the suite working, not a misconfiguration.

`registry.test.ts` sits here rather than in a top-level `tests/` because the
data it validates is this directory (ADR-012). It reads the directory at
module load; every non-directory entry — itself, this README — is skipped.

New models go in `_staged/` with `enabled: false`. Promoting one to a default
is a product decision needing an ADR-006 amendment, not a PR.
