// CamBridge PWA asset generator.
// A simple video-camera (camcorder) glyph in neon terminal-green (#34e57f) on
// the app's near-black (#0a0a0a) surface, with a glowing green "recording" dot
// in the top-right corner. Rasterizes one SVG design into every icon / splash
// size the manifest + iOS need.
//
// Requires `sharp` (not a runtime dep — install ad hoc to regenerate):
//   npm i -D sharp && node scripts/generate-pwa-assets.mjs
//
import sharp from 'sharp';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = process.argv[2] || join(HERE, '..', 'public');
const SPLASH = join(OUT, 'splash');

// ── palette (matches client/src/tokens.css) ────────────────────────────────
const BG = '#0a0a0a';
const PANEL = '#111114';
const BORDER = '#1f1f23';
const ACCENT = '#34e57f';
const TEXT = '#e6e6e6';
const MUTED = '#6b6b72';

// The classic "videocam" camcorder silhouette (Material), drawn in a 24-unit
// box: a rounded body on the left + a triangular lens pointing right.
const CAMCORDER =
  'M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z';

// A green recording dot with a soft concentric glow (no SVG blur filter — some
// rasterizers drop feGaussianBlur, so we fake the halo with stacked circles).
function recDot(cx, cy, r) {
  return `
    <circle cx="${cx}" cy="${cy}" r="${r * 2.0}" fill="${ACCENT}" opacity="0.10"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 1.5}" fill="${ACCENT}" opacity="0.16"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 1.15}" fill="${BG}"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${ACCENT}"/>`;
}

// Full app-icon SVG at 512. `maskable` insets the art into the safe zone and
// bleeds the background to the edges (no rounded tile — the OS masks it).
function iconSvg({ maskable = false } = {}) {
  const S = 512;
  // Content scale: standard fills more of the tile; maskable pulls in ~20%.
  const glyphW = maskable ? 224 : 288;
  const scale = glyphW / 18; // camcorder art is 18 units wide (x 3..21)
  const gh = 12 * scale;
  const cx = 256;
  const cy = maskable ? 268 : 272;
  // translate so the 24-box art centers on (cx, cy)
  const tx = cx - 12 * scale;
  const ty = cy - 12 * scale;

  const dotR = maskable ? 34 : 40;
  const dotX = maskable ? 372 : 400;
  const dotY = maskable ? 140 : 112;

  const tile = maskable
    ? `<rect width="${S}" height="${S}" fill="${BG}"/>`
    : `<rect x="8" y="8" width="${S - 16}" height="${S - 16}" rx="112" ry="112"
         fill="${BG}" stroke="${BORDER}" stroke-width="3"/>`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  ${tile}
  <g transform="translate(${tx} ${ty}) scale(${scale})">
    <path d="${CAMCORDER}" fill="${ACCENT}"/>
  </g>
  ${recDot(dotX, dotY, dotR)}
</svg>`;
}

// favicon.svg — tighter margins so it reads at 16px in a browser tab.
function faviconSvg() {
  const S = 512;
  const scale = 340 / 18;
  const cx = 250,
    cy = 280;
  const tx = cx - 12 * scale;
  const ty = cy - 12 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
  <rect width="${S}" height="${S}" rx="96" ry="96" fill="${BG}"/>
  <g transform="translate(${tx} ${ty}) scale(${scale})">
    <path d="${CAMCORDER}" fill="${ACCENT}"/>
  </g>
  ${recDot(408, 116, 52)}
</svg>`;
}

// Apple splash: centered icon + wordmark + "By The Anima Project", portrait.
function splashSvg(w, h) {
  const cx = w / 2;
  const cy = h / 2;
  const icon = Math.round(Math.min(w, h) * 0.28);
  const iconY = cy - icon - 40;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="${w}" height="${h}" fill="${BG}"/>
  <g transform="translate(${cx - icon / 2} ${iconY})">
    <svg width="${icon}" height="${icon}" viewBox="0 0 512 512">
      <rect x="8" y="8" width="496" height="496" rx="112" ry="112" fill="${PANEL}" stroke="${BORDER}" stroke-width="3"/>
      <g transform="translate(${256 - 12 * (288 / 18)} ${272 - 12 * (288 / 18)}) scale(${288 / 18})">
        <path d="${CAMCORDER}" fill="${ACCENT}"/>
      </g>
      ${recDot(400, 112, 40)}
    </svg>
  </g>
  <text x="${cx}" y="${cy + 30}" text-anchor="middle"
        font-family="DejaVu Sans Mono, monospace" font-weight="bold"
        font-size="${Math.round(Math.min(w, h) * 0.062)}"
        letter-spacing="6" fill="${TEXT}">CAMBRIDGE</text>
  <text x="${cx}" y="${cy + 30 + Math.round(Math.min(w, h) * 0.05)}" text-anchor="middle"
        font-family="DejaVu Sans Mono, monospace"
        font-size="${Math.round(Math.min(w, h) * 0.028)}"
        letter-spacing="4" fill="${ACCENT}">// P2P CAMERA</text>
  <text x="${cx}" y="${h - Math.round(h * 0.08)}" text-anchor="middle"
        font-family="DejaVu Sans Mono, monospace"
        font-size="${Math.round(Math.min(w, h) * 0.026)}"
        letter-spacing="3" fill="${MUTED}">By The Anima Project</text>
</svg>`;
}

async function png(svg, size, file) {
  await sharp(Buffer.from(svg))
    .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toFile(join(OUT, file));
  console.log('  ✓', file, `(${size}x${size})`);
}

async function splashPng(w, h) {
  const file = `apple-splash-${w}-${h}.png`;
  await sharp(Buffer.from(splashSvg(w, h))).png().toFile(join(SPLASH, file));
  console.log('  ✓ splash/' + file, `(${w}x${h})`);
}

const SPLASHES = [
  [1125, 2436], [1170, 2532], [1179, 2556], [1284, 2778],
  [1290, 2796], [2048, 2732], [750, 1334], [828, 1792],
];

async function main() {
  await mkdir(OUT, { recursive: true });
  await mkdir(SPLASH, { recursive: true });

  console.log('App icons:');
  const std = iconSvg({ maskable: false });
  const msk = iconSvg({ maskable: true });
  await png(std, 512, 'pwa-512x512.png');
  await png(std, 192, 'pwa-192x192.png');
  await png(msk, 512, 'pwa-maskable-512x512.png');
  await png(msk, 192, 'pwa-maskable-192x192.png');
  // apple-touch-icon must be opaque (iOS doesn't like alpha); flatten onto bg.
  await sharp(Buffer.from(iconSvg({ maskable: false })))
    .resize(180, 180)
    .flatten({ background: BG })
    .png()
    .toFile(join(OUT, 'apple-touch-icon.png'));
  console.log('  ✓ apple-touch-icon.png (180x180)');
  await png(std, 32, 'favicon-32x32.png');
  await png(std, 16, 'favicon-16x16.png');

  await writeFile(join(OUT, 'favicon.svg'), faviconSvg());
  console.log('  ✓ favicon.svg');

  console.log('Splash screens:');
  for (const [w, h] of SPLASHES) await splashPng(w, h);

  console.log('\nDone →', OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
