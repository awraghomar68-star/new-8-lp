# Netlify Export Asset Optimization — Design

**Date:** 2026-07-24
**Status:** Approved (design), pending spec review

## Problem

`netlify-export/` is a static multi-page site (production domain `zaafran.ma`, 8 experience pages + a clean landing `index.html`). Each of the 8 page files is a self-contained "bundle": every asset is base64-inlined into a `<script type="__bundler/manifest">` JSON blob and decoded to blob/data URLs at runtime by an unpacker IIFE.

Measured cost (decoded bytes across all 8 pages):

| Class | Instances | Unique (by content) | Decoded total |
|-------|-----------|---------------------|---------------|
| image/jpeg | 140 | **42** | **61.5 MB** |
| font/woff2 | 200 | 47 | 4.4 MB |
| text/javascript | 24 | **3** | 1.7 MB |
| image/webp | 9 | — | 0.5 MB |

Per-page HTML is 7.5–14 MB (384 lines, one ~13.6M-char line = the manifest). Total site ~90 MB.

Consequences:
1. **Images dominate** — 61.5 MB jpeg, but only 42 unique (heavy cross-page duplication).
2. **Base64 +33% tax** on every inlined byte.
3. **Blocking cold start** — nothing paints until `DOMContentLoaded` → `JSON.parse(13.6MB)` → `atob` every asset → build blobs → `template.split(uuid).join()` per uuid. All main-thread.
4. **No HTTP caching / dedup** — identical fonts, React, runtime re-shipped in every page file.

Images are the win: dedup (140→42) + recompress to webp/resize (~61 MB → ~3 MB unique) is ~95% of the payoff.

## Architecture facts (verified)

- Pages are **React apps**: template contains a `<x-dc>` DSL + `<helmet>`, driven by a 66 KB `dc-runtime` bundle (`// GENERATED ... do not edit`), plus React 18.3.1 + ReactDOM (declared in `ext_resources`, pointing at unpkg CDN urls, bytes embedded in manifest).
- `dc-runtime` resolves assets through two globals:
  - `window.__resources[id]` → returns a **URL string** used directly as `src`.
  - `bundledBlob(url)` reads `window.__resourceBlobs[url]`; **when absent it falls back to `fetch(url)`**.
- Therefore dc-runtime runs on **real URLs with no blobs** — the artifact-host CSP blob machinery is only needed on restrictive hosts. On Netlify (same-origin files, no blocking CSP), feeding real `/assets/...` URLs and leaving `__resourceBlobs` undefined works via the fetch fallback. **No dc-runtime edits required.**
- Templates are flat single pages (no iframes; `about:blank#uuid` appears only in unpacker comments). No nested-page materialization needed.

## Approach (chosen: A — un-inline to shared optimized assets)

One Node build script post-processes all 8 pages in place. Assets are content-hashed so identical bytes across pages collapse to a single shared file, HTTP-cached after first load.

Rejected alternatives:
- **B (in-place single-file shrink):** keeps base64 tax and blocks cross-page cache/dedup. Underdelivers on the chosen multi-file model.
- **C (drop runtime, full static HTML):** impossible — page content is React-rendered from `<x-dc>` at runtime.

## Decisions

| Decision | Choice |
|----------|--------|
| Image format/quality | **webp, quality 78, resize width ≤ 1600px** (`withoutEnlargement`) |
| Output location | **In place** — mutate `netlify-export/`; original recoverable via git |
| Toolchain | **Node + `sharp`** (add minimal `package.json`, `npm i sharp`) |
| Asset URLs | **Root-absolute** `/assets/...` (works from any page depth) |

## Components

### 1. `optimize.mjs` (build script, project root)

Pipeline, run once:

**Per page** (`netlify-export/<slug>/index.html`):
1. **Parse** the 4 bundler `<script>` blocks: `__bundler/manifest`, `__bundler/template`, `__bundler/ext_resources`, `__bundler/page_order`.
2. **Decode** each manifest entry: `base64` → bytes; if `entry.compressed`, gunzip.
3. **Materialize** to shared, content-hashed files (dedup via `sha256(decoded bytes)`, first 16 hex chars):
   - `image/*` → `sharp(bytes).rotate().resize({width:1600, withoutEnlargement:true}).webp({quality:78})` → `netlify-export/assets/img/<hash>.webp`. Already-webp assets are re-encoded through the same path for consistent sizing (cheap, idempotent).
   - `font/woff2` → written as-is → `netlify-export/assets/fonts/<hash>.woff2`.
   - `text/javascript` → written as-is → `netlify-export/assets/js/<hash>.js`.
   - A module-level `Map<hash, writtenUrl>` guards against re-writing/re-encoding an already-materialized blob across pages.
4. **Build `__resources` map** for this page: `{ uuid → assetUrl }` for every manifest entry, PLUS `{ cdnUrl → assetUrl }` for each `ext_resources` entry (dc-runtime's `cdnScriptFor` looks up by CDN url).
5. **Rewrite template:** string-replace every `uuid` occurrence in the decoded template with its `/assets/...` URL. (uuids are unique 36-char tokens — safe literal replace.)
6. **Emit new page HTML — the output page IS the rewritten template document.**
   - The decoded `__bundler/template` is already a complete `<!DOCTYPE html>…</html>` document containing the real `<x-dc>` markup in its `<body>` and the dc-runtime `<script src>` in its `<head>`. In the original file this template lives *inside a JSON string*; the shipped `<body>` is only the loading shell (`#__bundler_thumbnail`), and the unpacker IIFE is what parses the template, swaps uuids, and injects it into the live DOM.
   - Since the unpacker is removed, the build must promote the template to be the actual document: **new `index.html` = rewritten template**, with `<script>window.__resources = {…};</script>` injected into its `<head>` **before** the dc-runtime `<script src>` (dc-runtime reads `__resources` on boot; if it is set, dc-runtime skips its `fetch(location.href)` self-load path).
   - The original shell — loading thumbnail, unpacker IIFE, and the `manifest` / `template` / `ext_resources` / `page_order` script blocks — is entirely discarded (not present in the output).
   - Keep the template's existing `integrity`/`crossorigin` stripping behavior — harmless for same-origin `/assets`.
   - Overwrite `netlify-export/<slug>/index.html`.

### 2. `netlify.toml` (new, project root)

Immutable cache headers for hashed assets:
```toml
[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"
```

### 3. `package.json` (new, minimal)

```json
{ "private": true, "type": "module", "devDependencies": { "sharp": "^0.33" } }
```

### 4. Landing page

`netlify-export/index.html` is untouched (clean 12 KB, links to `https://zaafran.ma/<slug>/`).

## Data flow (runtime, post-build)

```
browser GET /luxe-cadeau/          -> ~50KB HTML
  <script>window.__resources = {uuid->/assets/..., cdnurl->/assets/...}</script>
  <script src="/assets/js/<dc-runtime hash>.js">   (cached across pages)
    dc-runtime boots -> reads __resources -> for each asset:
      bundledBlob(url) -> no __resourceBlobs -> fetch("/assets/img/<hash>.webp") 200
    React + ReactDOM fetched from /assets/js/... (cached)
  fonts: @font-face src url(/assets/fonts/<hash>.woff2) (cached)
```

First page: fetches page-specific webp images + shared fonts/js. Subsequent pages: only their own images; fonts/js/React served from cache.

## Error handling

- **sharp decode failure** on a malformed image → log uuid, fall back to writing original bytes with correct extension (`.jpg`/`.webp`), still deduped. Never abort the whole build for one asset.
- **Missing bundler block** in a page → log and skip that page (leave original untouched), continue others.
- **uuid appears in template but not manifest** (or vice-versa) → warn; leave uuid unreplaced only if no mapping (surfaces as a dev-visible broken ref rather than silent).
- Script is **idempotent-safe by output**: re-running regenerates identical hashed files; pages already rewritten (no bundler blocks) are detected and skipped.

## Testing / verification

1. **Build assertion:** script prints per-page before/after HTML size, asset counts, dedup ratio, total unique bytes written. Expect ~90 MB → single-digit MB.
2. **Runtime smoke (Playwright, local static server serving `netlify-export/`):** for each of 8 pages —
   - no `console.error` / uncaught errors,
   - `window.__resources` populated,
   - every `<img>` has `naturalWidth > 0`,
   - `document.fonts.status === 'loaded'` and a known family present,
   - all `/assets/*` network responses are 200.
3. **Visual spot-check:** screenshot 2–3 pages, compare against a pre-build reference render for layout/typography parity.

## Out of scope

- Editing `dc-runtime` or the source generator (not present in repo).
- Preserving single-file / offline (`file://`) portability — explicitly traded away for the multi-file model.
- AVIF, retina srcset, font subsetting — deferred; webp+dedup already captures the dominant win.

## Success criteria

- Total `netlify-export/` transfer weight reduced from ~90 MB to < 10 MB.
- Each page HTML < 100 KB; first paint no longer gated on a multi-MB synchronous unpack.
- Shared fonts/JS/React downloaded once site-wide (HTTP-cached, hashed URLs).
- All 8 pages render with parity to the pre-build output (Playwright + visual check pass).
