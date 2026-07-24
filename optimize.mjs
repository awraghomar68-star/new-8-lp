// Un-inline the netlify-export bundles into a shared, optimized, HTTP-cacheable
// multi-file static site. Run once: `npm run optimize`.
//
// Each page ships as a self-contained bundle: assets base64-inlined in a
// <script type="__bundler/manifest"> JSON blob, decoded to blob URLs at runtime
// by an unpacker IIFE, with the real page markup living inside a
// <script type="__bundler/template"> JSON string.
//
// This script decodes every asset, writes it once to /assets (content-hashed so
// identical bytes across pages collapse to a single file), recompresses images
// to webp, and rewrites each page to BE its template referencing /assets/... by
// URL. dc-runtime resolves assets via window.__resources and, finding no
// __resourceBlobs, falls back to fetch() — no runtime edits required.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPORT = path.join(ROOT, 'netlify-export');
const ASSET_ROOT = path.join(EXPORT, 'assets');
const PAGES = [
  'atlas-light', 'authenticite', 'cuisine', 'ivory-stigma',
  'lacquer', 'luxe-cadeau', 'sante-bien-etre', 'terroir-histoire',
];

const IMG_MAX_WIDTH = 1600;
const WEBP_QUALITY = 78;

// originalBytesHash -> public URL. Guarantees one written file per unique blob
// across all pages, and skips re-encoding an already-materialized asset.
const assetCache = new Map();

const stats = {
  pages: 0,
  writtenFiles: 0,
  reusedBlobs: 0,
  bytesInHtmlBefore: 0,
  bytesInHtmlAfter: 0,
  bytesWritten: 0,
  imgBytesBefore: 0,
  imgBytesAfter: 0,
  encodeFailures: 0,
};

function sha(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

function extractBlock(html, type) {
  // Non-greedy up to the matching </script>. Manifest/template values never
  // contain a literal "</script>" (the publisher escapes them), so this is safe.
  const re = new RegExp(
    `<script type="__bundler/${type}">([\\s\\S]*?)</script>`, 'i');
  const m = html.match(re);
  return m ? m[1].trim() : null;
}

function decodeEntry(entry) {
  let bytes = Buffer.from(entry.data, 'base64');
  if (entry.compressed) bytes = gunzipSync(bytes);
  return bytes;
}

// Decode -> optimize (images) -> write once, keyed by original-bytes hash.
// Returns the public URL to reference from the page.
async function materialize(entry) {
  const original = decodeEntry(entry);
  const key = sha(original);
  if (assetCache.has(key)) {
    stats.reusedBlobs++;
    return assetCache.get(key);
  }

  const mime = entry.mime || 'application/octet-stream';
  const [top, sub = ''] = mime.split('/');
  let dir, filename, outBytes;

  if (top === 'image') {
    stats.imgBytesBefore += original.length;
    dir = 'img';
    filename = `${key}.webp`;
    try {
      outBytes = await sharp(original)
        .rotate() // honour EXIF orientation before we drop metadata
        .resize({ width: IMG_MAX_WIDTH, withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toBuffer();
    } catch (err) {
      // Malformed / unsupported image: keep original bytes, correct extension.
      stats.encodeFailures++;
      console.warn(`  ! image encode failed (${mime}), keeping original: ${err.message}`);
      const ext = sub === 'jpeg' ? 'jpg' : (sub || 'bin');
      filename = `${key}.${ext}`;
      outBytes = original;
    }
    stats.imgBytesAfter += outBytes.length;
  } else if (top === 'font') {
    dir = 'fonts';
    filename = `${key}.${sub || 'woff2'}`;
    outBytes = original;
  } else if (mime === 'text/javascript' || mime === 'application/javascript') {
    dir = 'js';
    filename = `${key}.js`;
    outBytes = original;
  } else {
    dir = 'misc';
    filename = `${key}.${sub || 'bin'}`;
    outBytes = original;
  }

  const absDir = path.join(ASSET_ROOT, dir);
  mkdirSync(absDir, { recursive: true });
  writeFileSync(path.join(absDir, filename), outBytes);
  stats.writtenFiles++;
  stats.bytesWritten += outBytes.length;

  const url = `/assets/${dir}/${filename}`;
  assetCache.set(key, url);
  return url;
}

async function processPage(slug) {
  const file = path.join(EXPORT, slug, 'index.html');
  const html = readFileSync(file, 'utf8');
  stats.bytesInHtmlBefore += Buffer.byteLength(html);

  const manifestRaw = extractBlock(html, 'manifest');
  const templateRaw = extractBlock(html, 'template');
  if (!manifestRaw || !templateRaw) {
    console.warn(`- ${slug}: no bundler blocks, skipping (already processed?)`);
    stats.bytesInHtmlAfter += Buffer.byteLength(html);
    return;
  }
  const extRaw = extractBlock(html, 'ext_resources');

  const manifest = JSON.parse(manifestRaw);
  let template = JSON.parse(templateRaw);
  const extResources = extRaw ? JSON.parse(extRaw) : [];

  // Materialize every asset; build uuid -> url map.
  const resources = {};
  for (const [uuid, entry] of Object.entries(manifest)) {
    resources[uuid] = await materialize(entry);
  }
  // dc-runtime's cdnScriptFor looks up __resources by the ORIGINAL CDN url.
  for (const e of extResources) {
    if (e.uuid && resources[e.uuid]) resources[e.id] = resources[e.uuid];
  }

  // Swap every uuid reference in the template for its real /assets/... URL.
  for (const [uuid, url] of Object.entries(manifest)) {
    template = template.split(uuid).join(resources[uuid]);
  }

  // Match the unpacker's runtime behaviour: strip SRI/crossorigin (we serve the
  // bytes same-origin; SRI hashes were for the original CDN files).
  template = template
    .replace(/\s+integrity="[^"]*"/gi, '')
    .replace(/\s+crossorigin(="[^"]*")?/gi, '');

  // Inject __resources so dc-runtime resolves assets by URL (and skips its
  // fetch(location.href) self-load path). Must run before any uuid-src script,
  // so place it immediately after the opening <head>.
  const resScript =
    `<script>window.__resources = ${
      JSON.stringify(resources).replace(/<\//g, '<\\/')};</script>`;
  const headMatch = template.match(/<head[^>]*>/i);
  if (!headMatch) throw new Error(`${slug}: template has no <head>`);
  const idx = headMatch.index + headMatch[0].length;
  const out = template.slice(0, idx) + '\n' + resScript + template.slice(idx);

  writeFileSync(file, out);
  stats.bytesInHtmlAfter += Buffer.byteLength(out);
  stats.pages++;
  console.log(
    `- ${slug}: ${(Buffer.byteLength(html) / 1e6).toFixed(1)}MB -> ` +
    `${(Buffer.byteLength(out) / 1e3).toFixed(0)}KB  ` +
    `(${Object.keys(manifest).length} assets)`);
}

async function main() {
  console.log('Optimizing netlify-export...\n');
  for (const slug of PAGES) await processPage(slug);

  const mb = (n) => (n / 1e6).toFixed(1) + 'MB';
  console.log('\n=== summary ===');
  console.log(`pages rewritten     : ${stats.pages}`);
  console.log(`unique files written: ${stats.writtenFiles} (${stats.reusedBlobs} dedup hits)`);
  console.log(`HTML total          : ${mb(stats.bytesInHtmlBefore)} -> ${mb(stats.bytesInHtmlAfter)}`);
  console.log(`assets on disk      : ${mb(stats.bytesWritten)}`);
  console.log(`images              : ${mb(stats.imgBytesBefore)} -> ${mb(stats.imgBytesAfter)} (webp q${WEBP_QUALITY}, <=${IMG_MAX_WIDTH}px)`);
  console.log(`total site transfer : ${mb(stats.bytesInHtmlBefore)} -> ${mb(stats.bytesInHtmlAfter + stats.bytesWritten)}`);
  if (stats.encodeFailures) console.log(`image encode failures: ${stats.encodeFailures} (kept original bytes)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
