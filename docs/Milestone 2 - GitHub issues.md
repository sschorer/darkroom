# Milestone 2 — "The app" · GitHub issues to file

**Source of truth: `Darkroom Studio.dc.html`.** Every issue below must be built
to match that mockup exactly — same layout, colours, type, spacing, copy, and
states. Acceptance criteria say "matches the mockup" and mean it: compare
against the file at a **1440 × 920** window.

Plan numbers in `docs/BACKLOG.md` are #23–#31; live GH issues for M2 start at
**GH #25**. **File #0 first** (it rewrites the backlog); then #1 (foundations)
before any screen work, since everything references its tokens.

---

## 0 · docs: update BACKLOG.md for the M2 "Studio" UI direction
**Labels:** `docs`, `M2` · **Size:** S

The M2 UI is designed (Studio direction). Update `docs/BACKLOG.md` so scope and
numbers match before seeding the work:

- **#27 model picker** → the *selection* control lives **in the compose bar**;
  full install/remove/gating management moves to the new **Settings** page.
- **#28 error surfacing** → specify a **node-error banner** above the compose
  bar + a **failed tile** in the gallery (details in issue #7).
- **#24 queue** → add the **live-generating tile** (in-grid, step bar + cancel)
  as an explicit deliverable.
- **NEW: Settings / model-manager page** (issue #8) — not currently in the
  backlog; reached from a **bottom-left Settings button**.
- Note the desktop **window chrome** (min/max/close) + screen routing
  (Setup / Studio / Settings) as the M2 shell.
- Link `Darkroom Studio.dc.html` as the visual reference for all M2 UI issues.

**Done:** BACKLOG.md M2 matches the design; every issue below has a plan entry.

---

## 1 · design: foundations — tokens, type, window chrome
**Labels:** `design`, `ui`, `M2` · **Size:** M

The exact values the rest of M2 is built from. Take them verbatim from
`Darkroom Studio.dc.html`.

### Colour tokens
| Role | Hex |
|---|---|
| App / window surface | `#0c0c0f` |
| Titlebar | `#0a0a0d` |
| Panel surfaces | `#111114`, `#131317`, `#16161a` |
| Inset / unselected | `#0e0e11`, `#0d0d10` |
| Hairline borders | `#17171b`, `#1a1a1e`, `#1e1e23`, `#212127`, `#26262c` |
| Text — primary | `#e6e6ea` / `#e6e6e6` |
| Text — secondary | `#d2d2d8`, `#c9c9cf`, `#9a9aa2` |
| Text — muted | `#7a7a82`, `#6b6b73`, `#5a5a62` |
| **Safelight** accent | `#d94f3d` (link hover `#ec6a58`) |
| Primary button | `linear-gradient(180deg,#e05942,#c23a2a)`, text `#1a0906` |
| Red-tinted surface | bg `#171216`, border `#33242a` |
| Success | `#8fb98a` |
| Error surface / text | bg `rgba(30,16,15,.94)`, border `#4a2a26`, glyph `#e07a6d`, text `#e8ccc6` |

Keep `--color-surface: #0b0b0d` and `--color-safelight: #d94f3d` from
`index.css`.

### Type
- **Space Grotesk** (400/500/600/700) — all UI text.
- **JetBrains Mono** (400/500/600) — `.mono`: counts, seeds, params, meta,
  file paths, status. Any numeric/technical value is mono.

### Window chrome
- Window **1440 × 920**, radius **14**, border `#1a1a1e`,
  shadow `0 40px 120px rgba(0,0,0,.6)`.
- Titlebar height **44**, border-bottom `#17171b`, bg `#0a0a0d`.
  Left: safelight dot (7px, `#d94f3d`, soft pulse) + "Darkroom" (600) + mono
  subline. Right: **minimize / maximize / close** buttons **42 × 30**, radius 7,
  hover bg `#1c1c22`; **close hover** bg `#c23a2a`, white glyph.
- Tauri `decorations: false`, custom drag region.

**Done:** a token/theme module + window shell reproduce the chrome exactly on
all three OSes.

---

## 2 · feat(ui): Studio shell — left rail + screen routing
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #1

- Routing between **Setup / Studio / Settings**.
- Left rail **184px**, border-right `#17171b`:
  - **Library** (mono label): `▦ All outputs · 128` (active: bg `#16161a`,
    `#d94f3d` glyph), `▣ Images · 104`, `▶ Video · 24`, `★ Kept · 17`.
    Rows padding `8px 10px`, radius 7; counts mono `#6b6b73`.
  - Hairline `#17171b`.
  - **`Queue · 2`** (mono): a block bg `#141014` border `#2a1c1a` with
    `generating 3/4` (text `#c7796d`) over a 3px bar (`#d94f3d` on `#241618`,
    74%); then muted `1 queued · lighthouse…`.
  - Pinned bottom (border-top `#17171b`): **`⚙ Settings`** button, hover bg
    `#16161a` → opens Settings.

**Done:** rail matches the mockup exactly; Settings button routes.

---

## 3 · feat(ui): compose bar + model selector
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #16, #20

Floating bar, absolute `left/right 22px, bottom 22px`, padding `11px 12px`,
radius 14, bg `rgba(20,20,24,.9)` + blur, border `#26262c`,
shadow `0 20px 50px rgba(0,0,0,.5)`. Left → right:

- **Model selector** pill: bg `#171216`, border `#33242a`, 22px swatch
  (red radial), two lines "**FLUX.2 klein**" / mono "**image · CUDA**", `▾`.
  Opens installed-model menu with **VRAM gating reasons** (§8.5) and
  **license** (OC-2).
- **Prompt** input, placeholder "**Describe the next frame…**", safelight caret.
- Param chips (mono, bg `#16161a`, `#9a9aa2`): `seed 184203771 ⇄`, `steps 4`,
  `1:1`. Video models swap in duration/frames.
- **Generate** button (primary gradient), `⏎` submits.

**Done:** matches the mockup; switching models updates the pill + params.

---

## 4 · feat(ui): manifest-driven params form
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #16, #20

Fields from manifest `params` (min/max/default). Prompt, **seed** (⇄ shuffle),
**steps**, **aspect/size** for image; **duration/frames** for video. Values feed
`buildWorkflow()`; missing node throws. Rendered as the compose-bar chips in #3.

**Done:** klein and LTX-Video render correct fields with no per-model UI code.

---

## 5 · feat(ui): generation queue + live-generating tile
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #10

- Submit, sequential, cancel (§6.3); `client_id` matches WS + `/prompt`.
- **Live tile** (first grid cell): aspect 1, radius 6, border `#3a242a`, red
  gradient + `shimmer` sweep; **cancel ✕** 22×22 top-right (hover `#c23a2a`);
  bottom overlay mono "**step 3 / 4**" over a 3px bar (72%, `#d94f3d`).
- Rail queue summary as in #2.

**Done:** live tile + cancel match the mockup; finished image replaces the tile.

---

## 6 · feat(ui): gallery + selected preview
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #5

- **Selected preview** column **452px**: image aspect 1, radius 8, border
  `#212127`; overlay **★** and **⤓** buttons (30×30, `rgba(12,12,15,.6)`);
  below it the prompt + recipe chips (mono): `seed 184203771`, `4 steps`,
  `1024²`, `6.2s`, and **`↻ reuse recipe`** (bg `#1a1214`, `#d97a6d`).
- **Grid**: 4 columns, gap 10, tiles aspect 1, radius 6, border `#17171b`.
  Video tiles carry a bottom-left `▶ 0:04` badge (mono, `rgba(12,12,15,.65)`).
- `/view` bytes → `blob:` URLs (ADR-008).

**Done:** grid + preview match; image and video both render.

---

## 7 · feat(ui): error surfacing
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #8, #10

- **Node-error banner** — absolute above compose bar (`bottom 94px`), bg
  `rgba(30,16,15,.94)` + blur, border `#4a2a26`; 26px `⚠` chip (`#2a1513`);
  copy: "**Generation failed** — node `CLIPTextEncode` (#6): prompt exceeds the
  512-token limit." + mono sub "prompt_id 7b2f… · shorten the prompt or split
  it, then generate again"; **View engine log ↗** button (opens `logs/`,
  ADR-015) + **✕ dismiss**. Text driven by real `node_errors`.
- **Failed tile** — border `#4a2a26`, bg dark red-black, centred `⚠` (`#e07a6d`),
  mono "**failed**" (`#c7796d`), node name (`#7a5a52`), `↻ retry` bottom-right.
- **Spawn failure** → engine-log tail (§8.6). **Version-skew** blocks
  generation until `.version == comfy.lock` (§8.2).

**Done:** banner + failed tile match the mockup; text comes from real errors.

---

## 8 · feat(ui): Settings — model manager + engine + storage + privacy
**Labels:** `feat`, `ui`, `M2` · **Size:** L · **needs:** #2, #17, #21

Nav **212px** (`◆ Models` active, `⚙ Engine`, `▤ Storage`, `◇ Privacy`,
`ⓘ About`); bottom **← Back to studio**. Content max-width **820**.

- Heading **Models** + description; models land in
  `~/.local/share/live.darkroom.app/models` (mono).
- **Storage meter**: bg `#111114` border `#1e1e23`, "21.3 GB used · 318 GB free".
- **Installed** rows (padding `14px 16px`, radius 11, bg `#111114`,
  border `#1e1e23`, 44px swatch, name 15px + kind pill, mono meta, green
  `● ready`, **Remove** hover-red):
  - FLUX.2 klein · image · "Apache-2.0 · 13.4 GB · needs 13 GB VRAM"
  - LTX-Video · video · "Apache-2.0 · 7.9 GB · needs 8 GB VRAM"
- **Available** rows (bg `#0e0e11`):
  - Z-Image Turbo · image · "Apache-2.0 · ~12 GB · fits · staged" → **↓ Install**
  - Wan 2.2 · video · "needs 24 GB VRAM · this GPU has 24 GB · staged" → **↓ Install**
  - Wan 2.2 (14B finals) · video · "needs 32 GB VRAM · this GPU has 24 GB" →
    **Too large** (disabled, opacity .6, meta `#b06a5c`) — gating not hiding.
- **Engine** block: "ComfyUI a7251938 · torch 2.6.0+cu129 · CUDA · NVIDIA
  RTX 4090 (24 GB)", `up to date`, **Reinstall**.
- **Privacy**: update-check toggle (Q1, §8.7). **About**: version + GPL-3.0 +
  per-model licenses.

**Done:** page matches the mockup; install/remove works; every license visible
before install.

---

## 9 · feat(ui): first-run onboarding
**Labels:** `feat`, `ui`, `M2` · **Size:** M · **needs:** #5, #21

Centred **600px** column, safelight radial glow top. Header mono "**SETTING UP**"
+ h1 (34px) "**Let's set up your darkroom**" + privacy subtitle. Three step
cards:

- **1 · Install the engine** (active: bg `#120e0d`, border `#33241f`, number in
  `#d94f3d`): "ComfyUI and PyTorch, provisioned into a private environment.",
  "3.4 GB / 6.0 GB · ~4 min", **57% bar** with shimmer, mono uv line
  "Installing torch-2.6.0+cu129-cp312-cp312-linux_x86_64.whl …" (byte progress,
  not a spinner — #5).
- **2 · Choose your first model**: FLUX.2 klein (selected, `✓`) "image ·
  Apache-2.0 / ~13 GB · fits 24 GB"; LTX-Video "video · Apache-2.0 / ~8 GB ·
  fits 24 GB". Downloads after the engine.
- **3 · Develop your first frame** (dimmed, opacity .55): "Type a prompt, press
  Generate. Ready once setup finishes." + **Skip →**.

**Done:** matches the mockup; a non-technical user reaches their first image
without a terminal (Q2).

---

## 10 · feat(ui): offline verification
**Labels:** `test`, `ui`, `M2` · **Size:** S · **needs:** #5

QS-1: after bootstrap + one model, pull the network and generate.

**Done:** generation succeeds offline; only update checks are outbound and
skippable.

---

## 11 · design: visual pass sign-off
**Labels:** `design`, `M2` · **Size:** M · **needs:** #9

#31 — final QA that the built app matches `Darkroom Studio.dc.html` across all
screens: tokens applied, safelight-dot status, red focus states, tonal
placeholder tiles for loading/empty, consistent density. No default framework
styling remains.

**Done:** side-by-side with the mockup shows no visual drift on Setup, Studio,
and Settings.
