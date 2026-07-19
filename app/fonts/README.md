# Bundled fonts

Self-hosted because Darkroom is offline-first and the CSP is `style-src 'self'`
with no `font-src` override — a webfont fetched from Google's CDN at runtime
would be blocked, and blocked silently. These are the `latin` subsets only
(the app ships English UI), pulled from Fontsource.

- **Space Grotesk** — UI text. SIL Open Font License 1.1.
  <https://github.com/floriankarsten/space-grotesk>
- **JetBrains Mono** — the `.mono` face: counts, seeds, params, paths, status.
  SIL Open Font License 1.1. <https://github.com/JetBrains/JetBrainsMono>

Both licenses permit bundling and redistribution (including inside this
GPL-3.0 app). The OFL requires the fonts not be sold on their own and that
their reserved names aren't reused for modified versions — neither of which
we do.
