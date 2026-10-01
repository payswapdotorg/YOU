// ═══════════════════════════════════════════════════════════════════════════
// svg-portrait-1 — deterministic HTIR → SVG portrait renderer (Worker C lane).
// ~real code, no AI: a composed stylized portrait card (600×800).
//
// DETERMINISM GUARANTEE: the same HTIR render-relevant content + the same seed
// produce a byte-identical SVG string. All randomness flows from a seeded
// mulberry32 PRNG (src/lib/you/lab/determinism.ts); there is no Date.now(),
// no Math.random() and no environment-dependent text anywhere in the output.
// Only render-relevant HTIR fields (morphology/geometry/appearance/confidence)
// feed the seed — provenance timestamps deliberately do NOT affect pixels.
// ═══════════════════════════════════════════════════════════════════════════
import type { HTIR, RenderStyle } from '../contracts';
import { clamp, hashString, makeRng, round, stableStringify } from '../lab/determinism';

export const SVG_PORTRAIT_ADAPTER = {
  adapterId: 'svg-portrait-1',
  version: '1',
  deterministic: true,
  aiInvolved: false,
  determinismNote: 'same HTIR render-relevant content + same seed → byte-identical SVG (seeded mulberry32 PRNG)',
} as const;

export interface PortraitRenderOptions {
  style: RenderStyle;
  seed: number;
}

const W = 600;
const H = 800;
const FONT = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', sans-serif";
const MONO = "ui-monospace, SFMono-Regular, Menlo, monospace";

// ─── color helpers ───────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const s = m ? m[1] : '888888';
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function rgbToHex(r: number, g: number, b: number): string {
  const c = (v: number) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}

/** f > 1 lightens toward white, f < 1 darkens toward black. */
function shade(hex: string, f: number): string {
  const [r, g, b] = hexToRgb(hex);
  if (f >= 1) {
    const t = f - 1;
    return rgbToHex(r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t);
  }
  return rgbToHex(r * f, g * f, b * f);
}

function mix(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexToRgb(a);
  const [r2, g2, b2] = hexToRgb(b);
  return rgbToHex(r1 + (r2 - r1) * t, g1 + (g2 - g1) * t, b1 + (b2 - b1) * t);
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function n(v: number): string {
  return String(round(v, 2));
}

// ─── style profiles ──────────────────────────────────────────────────────────

interface StyleProfile {
  outline: number; // stroke width for main shapes
  flat: boolean; // flat fills vs gradients
  eyeScale: number;
  headScale: number;
  sketchy: boolean; // illustration wobble
  lowPoly: boolean; // polygon facets
  pixelGrid: boolean; // game overlay
  sparkles: boolean; // anime accents
  softShading: boolean; // photorealistic radial shading
  boldMouth: boolean;
}

function styleProfile(style: RenderStyle): StyleProfile {
  const base: StyleProfile = {
    outline: 2, flat: false, eyeScale: 1, headScale: 1, sketchy: false,
    lowPoly: false, pixelGrid: false, sparkles: false, softShading: false, boldMouth: false,
  };
  switch (style) {
    case 'photorealistic': return { ...base, outline: 0.5, eyeScale: 1, softShading: true };
    case 'anime': return { ...base, outline: 3, flat: true, eyeScale: 1.45, sparkles: true };
    case 'cartoon': return { ...base, outline: 5, flat: true, eyeScale: 1.2, headScale: 1.12, boldMouth: true };
    case 'low-poly': return { ...base, outline: 0, lowPoly: true, flat: true };
    case 'game': return { ...base, outline: 2, flat: true, pixelGrid: true };
    case 'illustration': return { ...base, outline: 1.5, sketchy: true, flat: true };
    case 'stylized-portrait':
    default: return { ...base, outline: 2 };
  }
}

// ─── render-relevant HTIR projection (provenance deliberately excluded) ─────

function renderRelevant(htir: HTIR): unknown {
  return {
    morphology: htir.morphology,
    geometry: { measurements: htir.geometry.measurements, face: htir.geometry.face, hands: htir.geometry.hands },
    appearance: htir.appearance,
    confidenceOverall: htir.confidence?.overall ?? null,
  };
}

// ─── main renderer ───────────────────────────────────────────────────────────

export function renderPortraitSvg(htir: HTIR, opts: PortraitRenderOptions): string {
  const style = opts.style;
  const prof = styleProfile(style);
  const rng = makeRng((opts.seed >>> 0) ^ hashString(stableStringify(renderRelevant(htir))));

  // palette with honest fallbacks when the HTIR lacks observations
  const p = htir.appearance?.palette ?? {};
  const skin = p.skin ?? '#c8956c';
  const hairC = p.hair ?? '#3b2a20';
  const eyesC = p.eyes ?? '#4a342a';
  const cloth = p.clothing?.[0] ?? '#565a64';
  const ink = '#2a2723';

  // geometry from HTIR measurements
  const m = htir.geometry?.measurements ?? {};
  const headRatio = clamp(typeof m.headRatio === 'number' ? m.headRatio : 1, 0.6, 1.5);
  const shoulderRatio = clamp(typeof m.shoulderRatio === 'number' ? m.shoulderRatio : 1, 0.5, 1.6);
  const faceShape = (htir.geometry?.face?.landmarkSummary ?? '').toLowerCase();

  const cx = W / 2;
  const cy = 350;
  let headRx = (42 + 26 * headRatio) * prof.headScale;
  let headRy = headRx * 1.28;
  if (/round/.test(faceShape)) headRy = headRx * 1.08;
  else if (/square|rect/.test(faceShape)) { headRx *= 1.06; headRy = headRx * 1.12; }
  else if (/long|oblong/.test(faceShape)) headRy = headRx * 1.48;
  else if (/heart|triang/.test(faceShape)) { headRy = headRx * 1.3; }

  const shoulderW = 150 + 115 * shoulderRatio;
  const torsoTop = cy + headRy + 14;

  // hair config
  const hair = htir.appearance?.hair ?? { coverage: 'medium' as const };
  const hairLen = (hair.length ?? '').toLowerCase();
  const longHair = /long|past shoulder|flowing/.test(hairLen) || hair.coverage === 'high';
  const mediumHair = /medium|shoulder|mid/.test(hairLen) || hair.coverage === 'medium';
  const bald = /bald|shaved|very short/.test(hairLen);

  // distinguishing features
  const dist = htir.appearance?.distinguishing ?? [];
  const distLower = dist.map((d) => d.toLowerCase()).join(' ');
  const hasGlasses =
    distLower.includes('glass') ||
    (htir.morphology?.descriptors ?? []).some((d) => d.toLowerCase().includes('glass'));
  const facialHair = htir.appearance?.hair?.style
    ? ''
    : '';
  const beardMentioned =
    /beard|stubble|moustache|mustache|goatee/.test(distLower) ||
    /beard|stubble|moustache|mustache|goatee/.test((htir.morphology?.descriptors ?? []).join(' ').toLowerCase());
  void facialHair;

  // jitter (all from seeded PRNG)
  const browTilt = rng.float(-0.08, 0.08);
  const smileAmount = 0.35 + clamp(htir.confidence?.overall ?? 0.6, 0, 1) * 0.4;
  const irisGlowX = rng.float(-2, 2);
  const irisGlowY = rng.float(-2, 2);

  const layers: string[] = [];

  // ── defs ──
  const bgTop = shade(mix(skin, cloth, 0.35), 1.75);
  const bgBottom = shade(mix(cloth, hairC, 0.4), 0.72);
  const defs: string[] = [];
  defs.push(
    `<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${bgTop}"/><stop offset="1" stop-color="${bgBottom}"/></linearGradient>`
  );
  if (prof.softShading) {
    defs.push(
      `<radialGradient id="faceshade" cx="0.38" cy="0.32" r="0.85"><stop offset="0" stop-color="${shade(skin, 1.18)}"/><stop offset="0.55" stop-color="${skin}"/><stop offset="1" stop-color="${shade(skin, 0.82)}"/></radialGradient>`,
      `<radialGradient id="glow" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="${shade(skin, 1.9)}" stop-opacity="0.9"/><stop offset="1" stop-color="${shade(skin, 1.9)}" stop-opacity="0"/></radialGradient>`
    );
  } else {
    defs.push(
      `<radialGradient id="glow" cx="0.5" cy="0.42" r="0.55"><stop offset="0" stop-color="${shade(skin, 1.7)}" stop-opacity="${prof.flat ? 0.55 : 0.8}"/><stop offset="1" stop-color="${shade(skin, 1.7)}" stop-opacity="0"/></radialGradient>`
    );
  }
  if (!prof.flat) {
    defs.push(
      `<linearGradient id="cloth" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(cloth, 1.22)}"/><stop offset="1" stop-color="${shade(cloth, 0.78)}"/></linearGradient>`
    );
  }
  if (prof.softShading) {
    defs.push(`<filter id="soft" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="6"/></filter>`);
  }

  // ── background ──
  layers.push(`<rect width="${W}" height="${H}" fill="url(#bg)"/>`);
  layers.push(`<rect width="${W}" height="${H}" fill="url(#glow)"/>`);
  // seeded ambient dots (deterministic decoration)
  for (let i = 0; i < 14; i++) {
    const dx = rng.float(20, W - 20);
    const dy = rng.float(20, 240);
    const r = rng.float(1.2, 3.2);
    layers.push(`<circle cx="${n(dx)}" cy="${n(dy)}" r="${n(r)}" fill="${shade(skin, 1.9)}" opacity="${n(rng.float(0.15, 0.4))}"/>`);
  }

  // ── long hair back layer ──
  if (longHair) {
    const hx = headRx * 1.18;
    const hy = headRy * 1.12;
    const bottom = cy + headRy + 170;
    layers.push(
      `<path d="M ${n(cx - hx)} ${n(cy)} C ${n(cx - hx - 26)} ${n(cy + headRy)} ${n(cx - hx + 6)} ${n(bottom)} ${n(cx - headRx * 0.55)} ${n(bottom + 8)} L ${n(cx + headRx * 0.55)} ${n(bottom + 8)} C ${n(cx + hx - 6)} ${n(bottom)} ${n(cx + hx + 26)} ${n(cy + headRy)} ${n(cx + hx)} ${n(cy)} A ${n(hx)} ${n(hy)} 0 0 0 ${n(cx - hx)} ${n(cy)} Z" fill="${prof.flat ? hairC : `url(#hairgrad)`}"${outlineAttr(prof, ink)}/>`
    );
    defs.push(`<linearGradient id="hairgrad" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${shade(hairC, 1.25)}"/><stop offset="1" stop-color="${shade(hairC, 0.75)}"/></linearGradient>`);
  } else if (mediumHair) {
    const hx = headRx * 1.12;
    layers.push(
      `<path d="M ${n(cx - hx)} ${n(cy - headRy * 0.2)} C ${n(cx - hx - 14)} ${n(cy + headRy * 0.9)} ${n(cx - hx + 8)} ${n(cy + headRy + 62)} ${n(cx - headRx * 0.72)} ${n(cy + headRy + 66)} L ${n(cx + headRx * 0.72)} ${n(cy + headRy + 66)} C ${n(cx + hx - 8)} ${n(cy + headRy + 62)} ${n(cx + hx + 14)} ${n(cy + headRy * 0.9)} ${n(cx + hx)} ${n(cy - headRy * 0.2)} A ${n(hx)} ${n(headRy * 1.05)} 0 0 0 ${n(cx - hx)} ${n(cy - headRy * 0.2)} Z" fill="${hairC}"${outlineAttr(prof, ink)}/>`
    );
  }

  // ── torso / shoulders ──
  const clothFill = prof.flat ? cloth : 'url(#cloth)';
  layers.push(
    `<path d="M ${n(cx - shoulderW)} ${H} L ${n(cx - shoulderW)} ${n(torsoTop + 66)} Q ${n(cx - shoulderW * 0.62)} ${n(torsoTop)} ${n(cx - 34)} ${n(torsoTop + 4)} L ${n(cx + 34)} ${n(torsoTop + 4)} Q ${n(cx + shoulderW * 0.62)} ${n(torsoTop)} ${n(cx + shoulderW)} ${n(torsoTop + 66)} L ${n(cx + shoulderW)} ${H} Z" fill="${clothFill}"${outlineAttr(prof, ink)}/>`
  );
  // collar
  layers.push(
    `<path d="M ${n(cx - 34)} ${n(torsoTop + 4)} Q ${n(cx)} ${n(torsoTop + 34)} ${n(cx + 34)} ${n(torsoTop + 4)}" fill="none" stroke="${shade(cloth, 0.6)}" stroke-width="${n(prof.outline * 1.5 + 1)}"/>`
  );

  // ── neck ──
  layers.push(
    `<rect x="${n(cx - 20)}" y="${n(cy + headRy * 0.66)}" width="40" height="${n(torsoTop - cy - headRy * 0.66 + 14)}" rx="10" fill="${shade(skin, 0.9)}"${outlineAttr(prof, ink)}/>`
  );

  // ── head ──
  const headFill = prof.softShading ? 'url(#faceshade)' : skin;
  if (prof.sketchy) {
    layers.push(wobblyEllipse(cx, cy, headRx, headRy, rng, headFill, ink, prof.outline));
  } else if (prof.lowPoly) {
    layers.push(lowPolyHead(cx, cy, headRx, headRy, skin, rng));
  } else {
    layers.push(`<ellipse cx="${n(cx)}" cy="${n(cy)}" rx="${n(headRx)}" ry="${n(headRy)}" fill="${headFill}"${outlineAttr(prof, ink)}/>`);
  }
  // ears
  layers.push(
    `<ellipse cx="${n(cx - headRx)}" cy="${n(cy + 2)}" rx="${n(headRx * 0.14)}" ry="${n(headRy * 0.2)}" fill="${shade(skin, 0.94)}"${outlineAttr(prof, ink)}/>`,
    `<ellipse cx="${n(cx + headRx)}" cy="${n(cy + 2)}" rx="${n(headRx * 0.14)}" ry="${n(headRy * 0.2)}" fill="${shade(skin, 0.94)}"${outlineAttr(prof, ink)}/>`
  );

  // ── eyes ──
  const eyeY = cy - headRy * 0.06;
  const eyeDx = headRx * 0.42;
  const eyeRx = headRx * 0.155 * prof.eyeScale;
  const eyeRy = headRx * 0.1 * prof.eyeScale;
  const irisR = eyeRy * 0.62;
  for (const side of [-1, 1]) {
    const ex = cx + side * eyeDx;
    layers.push(
      `<ellipse cx="${n(ex)}" cy="${n(eyeY)}" rx="${n(eyeRx)}" ry="${n(eyeRy)}" fill="#ffffff"${outlineAttr(prof, ink)}/>`,
      `<circle cx="${n(ex + irisGlowX * 0.4)}" cy="${n(eyeY + irisGlowY * 0.4)}" r="${n(irisR)}" fill="${eyesC}"/>`,
      `<circle cx="${n(ex + irisGlowX * 0.4)}" cy="${n(eyeY + irisGlowY * 0.4)}" r="${n(irisR * 0.42)}" fill="#141210"/>`,
      `<circle cx="${n(ex + irisGlowX * 0.4 + irisR * 0.34)}" cy="${n(eyeY + irisGlowY * 0.4 - irisR * 0.34)}" r="${n(irisR * 0.16)}" fill="#ffffff" opacity="0.9"/>`
    );
    if (prof.sketchy) {
      layers.push(
        `<ellipse cx="${n(ex + rng.float(-1.5, 1.5))}" cy="${n(eyeY + rng.float(-1.5, 1.5))}" rx="${n(eyeRx)}" ry="${n(eyeRy)}" fill="none" stroke="${ink}" stroke-width="1" opacity="0.35"/>`
      );
    }
  }
  // brows
  const browY = eyeY - eyeRy * 2.1;
  for (const side of [-1, 1]) {
    const bx1 = cx + side * eyeDx - eyeRx;
    const bx2 = cx + side * eyeDx + eyeRx;
    const tilt = side * browTilt * 10;
    layers.push(
      `<path d="M ${n(bx1)} ${n(browY + tilt)} Q ${n((bx1 + bx2) / 2)} ${n(browY - eyeRy * 0.55 + tilt)} ${n(bx2)} ${n(browY + tilt)}" fill="none" stroke="${shade(hairC, 1.1)}" stroke-width="${n(3 + prof.outline)}" stroke-linecap="round"/>`
    );
  }

  // ── nose ──
  layers.push(
    `<path d="M ${n(cx - 1)} ${n(eyeY + eyeRy * 1.2)} Q ${n(cx - headRx * 0.09)} ${n(cy + headRy * 0.22)} ${n(cx)} ${n(cy + headRy * 0.26)} Q ${n(cx + headRx * 0.1)} ${n(cy + headRy * 0.24)} ${n(cx + headRx * 0.05)} ${n(cy + headRy * 0.27)}" fill="none" stroke="${shade(skin, 0.72)}" stroke-width="${n(2 + prof.outline * 0.5)}" stroke-linecap="round" opacity="0.8"/>`
  );

  // ── mouth ──
  const mouthY = cy + headRy * 0.46;
  const mouthW = headRx * (prof.boldMouth ? 0.5 : 0.38);
  const mouthCurve = mouthW * (0.35 + smileAmount * 0.55);
  if (prof.boldMouth) {
    layers.push(
      `<path d="M ${n(cx - mouthW)} ${n(mouthY)} Q ${n(cx)} ${n(mouthY + mouthCurve * 1.7)} ${n(cx + mouthW)} ${n(mouthY)} Q ${n(cx)} ${n(mouthY + mouthCurve * 0.5)} ${n(cx - mouthW)} ${n(mouthY)} Z" fill="${shade('#8a4a44', 1.05)}" stroke="${ink}" stroke-width="${n(prof.outline)}"/>`
    );
  } else {
    layers.push(
      `<path d="M ${n(cx - mouthW)} ${n(mouthY)} Q ${n(cx)} ${n(mouthY + mouthCurve)} ${n(cx + mouthW)} ${n(mouthY)}" fill="none" stroke="${shade('#8a4a44', 0.9)}" stroke-width="${n(2.4 + prof.outline * 0.4)}" stroke-linecap="round"/>`
    );
  }

  // ── blush ──
  if (prof.softShading || style === 'anime' || style === 'cartoon') {
    const blushOp = style === 'anime' ? 0.4 : 0.22;
    layers.push(
      `<ellipse cx="${n(cx - headRx * 0.62)}" cy="${n(cy + headRy * 0.18)}" rx="${n(headRx * 0.2)}" ry="${n(headRy * 0.1)}" fill="${mix(skin, '#d96a5a', 0.5)}" opacity="${blushOp}"/>`,
      `<ellipse cx="${n(cx + headRx * 0.62)}" cy="${n(cy + headRy * 0.18)}" rx="${n(headRx * 0.2)}" ry="${n(headRy * 0.1)}" fill="${mix(skin, '#d96a5a', 0.5)}" opacity="${blushOp}"/>`
    );
  }

  // ── beard / facial hair ──
  if (beardMentioned) {
    layers.push(
      `<path d="M ${n(cx - headRx * 0.82)} ${n(cy + headRy * 0.18)} Q ${n(cx - headRx * 0.78)} ${n(cy + headRy * 0.95)} ${n(cx)} ${n(cy + headRy * 1.04)} Q ${n(cx + headRx * 0.78)} ${n(cy + headRy * 0.95)} ${n(cx + headRx * 0.82)} ${n(cy + headRy * 0.18)} Q ${n(cx + headRx * 0.5)} ${n(cy + headRy * 0.34)} ${n(cx)} ${n(cy + headRy * 0.3)} Q ${n(cx - headRx * 0.5)} ${n(cy + headRy * 0.34)} ${n(cx - headRx * 0.82)} ${n(cy + headRy * 0.18)} Z" fill="${shade(hairC, 1.02)}" opacity="0.88"/>`
    );
  }

  // ── hair front (cap/fringe) ──
  if (!bald) {
    const capTop = cy - headRy * 1.04;
    const fringeY = cy - headRy * (style === 'anime' ? 0.42 : 0.34);
    const hx = headRx * 1.06;
    layers.push(
      `<path d="M ${n(cx - hx)} ${n(cy - headRy * 0.12)} C ${n(cx - hx)} ${n(capTop)} ${n(cx + hx)} ${n(capTop)} ${n(cx + hx)} ${n(cy - headRy * 0.12)} Q ${n(cx + headRx * 0.8)} ${n(fringeY + 6)} ${n(cx + headRx * 0.42)} ${n(fringeY)} Q ${n(cx + headRx * 0.1)} ${n(fringeY - 8)} ${n(cx - headRx * 0.3)} ${n(fringeY + 4)} Q ${n(cx - headRx * 0.72)} ${n(fringeY + 10)} ${n(cx - hx)} ${n(cy - headRy * 0.12)} Z" fill="${prof.flat ? hairC : 'url(#hairgrad)'}"${outlineAttr(prof, ink)}/>`
    );
  } else {
    layers.push(
      `<path d="M ${n(cx - headRx * 0.96)} ${n(cy - headRy * 0.36)} A ${n(headRx * 0.96)} ${n(headRy * 0.68)} 0 0 1 ${n(cx + headRx * 0.96)} ${n(cy - headRy * 0.36)}" fill="none" stroke="${shade(skin, 0.85)}" stroke-width="${n(prof.outline + 2)}" stroke-linecap="round" opacity="0.6"/>`
    );
  }

  // ── glasses ──
  if (hasGlasses) {
    const gRx = eyeRx * 1.5;
    const gRy = eyeRy * 1.45;
    for (const side of [-1, 1]) {
      const ex = cx + side * eyeDx;
      layers.push(
        `<rect x="${n(ex - gRx)}" y="${n(eyeY - gRy)}" width="${n(gRx * 2)}" height="${n(gRy * 2)}" rx="${n(gRx * 0.35)}" fill="#ffffff" fill-opacity="0.14" stroke="#33302b" stroke-width="${n(2 + prof.outline)}"/>`
      );
    }
    layers.push(
      `<path d="M ${n(cx - eyeDx + gRx)} ${n(eyeY)} Q ${n(cx)} ${n(eyeY - gRy * 0.7)} ${n(cx + eyeDx - gRx)} ${n(eyeY)}" fill="none" stroke="#33302b" stroke-width="${n(2 + prof.outline)}"/>`,
      `<path d="M ${n(cx - eyeDx - gRx)} ${n(eyeY)} L ${n(cx - headRx * 0.98)} ${n(eyeY - 2)}" fill="none" stroke="#33302b" stroke-width="${n(2 + prof.outline)}"/>`,
      `<path d="M ${n(cx + eyeDx + gRx)} ${n(eyeY)} L ${n(cx + headRx * 0.98)} ${n(eyeY - 2)}" fill="none" stroke="#33302b" stroke-width="${n(2 + prof.outline)}"/>`
    );
  }

  // ── style accents ──
  if (prof.sparkles) {
    for (let i = 0; i < 3; i++) {
      const sx = rng.float(60, W - 60);
      const sy = rng.float(60, 260);
      const sr = rng.float(4, 8);
      layers.push(
        `<path d="M ${n(sx)} ${n(sy - sr)} L ${n(sx + sr * 0.3)} ${n(sy - sr * 0.3)} L ${n(sx + sr)} ${n(sy)} L ${n(sx + sr * 0.3)} ${n(sy + sr * 0.3)} L ${n(sx)} ${n(sy + sr)} L ${n(sx - sr * 0.3)} ${n(sy + sr * 0.3)} L ${n(sx - sr)} ${n(sy)} L ${n(sx - sr * 0.3)} ${n(sy - sr * 0.3)} Z" fill="${shade(skin, 1.95)}" opacity="${n(rng.float(0.4, 0.8))}"/>`
      );
    }
  }
  if (prof.pixelGrid) {
    const grid: string[] = [];
    for (let gx = 0; gx < W; gx += 20) grid.push(`<line x1="${gx}" y1="0" x2="${gx}" y2="${H - 90}" stroke="${ink}" stroke-width="0.5" opacity="0.07"/>`);
    for (let gy = 0; gy < H - 90; gy += 20) grid.push(`<line x1="0" y1="${gy}" x2="${W}" y2="${gy}" stroke="${ink}" stroke-width="0.5" opacity="0.07"/>`);
    layers.push(`<g>${grid.join('')}</g>`);
  }
  if (prof.softShading) {
    layers.push(
      `<ellipse cx="${n(cx - headRx * 0.42)}" cy="${n(cy - headRy * 0.3)}" rx="${n(headRx * 0.34)}" ry="${n(headRy * 0.22)}" fill="#ffffff" opacity="0.10" filter="url(#soft)"/>`
    );
  }

  // ── palette strip ──
  const swatches: Array<{ label: string; hex: string }> = [
    { label: 'skin', hex: skin },
    { label: 'hair', hex: hairC },
    { label: 'eyes', hex: eyesC },
    { label: 'clothing', hex: cloth },
  ];
  const stripY = 706;
  const sw: string[] = [];
  swatches.forEach((s2, i) => {
    const x = 40 + i * 132;
    if (prof.pixelGrid) {
      // game style: dithered 4×2 blocks per swatch
      for (let bx = 0; bx < 4; bx++) {
        for (let by = 0; by < 2; by++) {
          sw.push(
            `<rect x="${n(x + bx * 27)}" y="${n(stripY + by * 20)}" width="26" height="19" fill="${shade(s2.hex, 0.9 + rng.float(0, 0.25))}"/>`
          );
        }
      }
    } else {
      sw.push(
        `<rect x="${x}" y="${stripY}" width="108" height="40" rx="8" fill="${s2.hex}" stroke="${ink}" stroke-opacity="0.25" stroke-width="1.5"/>`
      );
    }
    sw.push(
      `<text x="${n(x + 54)}" y="${n(stripY + 58)}" font-family="${MONO}" font-size="10.5" fill="${ink}" fill-opacity="0.75" text-anchor="middle">${esc(s2.label)} ${esc(s2.hex)}</text>`
    );
  });
  layers.push(`<g>${sw.join('')}</g>`);

  // ── captions ──
  const caption = `YOU · TWIN AVATAR · ${esc(style)}`;
  const sub = `twin ${esc(String(htir.twinId).slice(0, 10))} · v${htir.version} · seed ${opts.seed} · deterministic render`;
  const foot = `simulated stylized portrait — rendered deterministically from HTIR by svg-portrait-1 (no AI in this render)`;
  layers.push(
    `<text x="30" y="44" font-family="${FONT}" font-size="17" font-weight="700" letter-spacing="2.5" fill="${ink}">${caption}</text>`,
    `<text x="30" y="64" font-family="${MONO}" font-size="10.5" fill="${ink}" fill-opacity="0.62">${sub}</text>`,
    `<text x="${W / 2}" y="${H - 14}" font-family="${MONO}" font-size="9.5" fill="${ink}" fill-opacity="0.5" text-anchor="middle">${foot}</text>`
  );

  // Morphology note strip (honest descriptors, rendered as text)
  const descriptors = (htir.morphology?.descriptors ?? []).slice(0, 3);
  if (descriptors.length > 0) {
    layers.push(
      `<text x="30" y="${H - 88}" font-family="${FONT}" font-size="11" fill="${ink}" fill-opacity="0.55">${esc(descriptors.join('  ·  '))}</text>`
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-label="Stylized avatar portrait rendered from HTIR"><defs>${defs.join('')}</defs>${layers.join('')}</svg>`;
}

// ─── style helpers ───────────────────────────────────────────────────────────

function outlineAttr(prof: StyleProfile, ink: string): string {
  return prof.outline > 0 ? ` stroke="${ink}" stroke-width="${n(prof.outline)}" stroke-opacity="0.85"` : '';
}

/** illustration style: hand-drawn wobbly closed ellipse. */
function wobblyEllipse(
  cx: number, cy: number, rx: number, ry: number,
  rng: ReturnType<typeof makeRng>, fill: string, ink: string, outline: number
): string {
  const pts = 10;
  const coords: Array<[number, number]> = [];
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const jr = 1 + rng.float(-0.035, 0.035);
    coords.push([cx + Math.cos(a) * rx * jr, cy + Math.sin(a) * ry * jr]);
  }
  const mid = (a: [number, number], b: [number, number]): [number, number] => [
    (a[0] + b[0]) / 2 + rng.float(-2, 2),
    (a[1] + b[1]) / 2 + rng.float(-2, 2),
  ];
  let d = `M ${n(coords[0][0])} ${n(coords[0][1])}`;
  for (let i = 0; i < pts; i++) {
    const cur = coords[i];
    const next = coords[(i + 1) % pts];
    const m = mid(cur, next);
    d += ` Q ${n(cur[0])} ${n(cur[1])} ${n(m[0])} ${n(m[1])}`;
  }
  d += ' Z';
  const extra =
    outline > 0
      ? `<path d="${d}" fill="none" stroke="${ink}" stroke-width="1" opacity="0.3" transform="translate(${n(rng.float(-1.5, 1.5))} ${n(rng.float(-1.5, 1.5))})"/>`
      : '';
  return `<path d="${d}" fill="${fill}"${outline > 0 ? ` stroke="${ink}" stroke-width="${n(outline)}" stroke-opacity="0.85"` : ''}/>${extra}`;
}

/** low-poly style: seeded ring-triangulated facets inside the head ellipse. */
function lowPolyHead(cx: number, cy: number, rx: number, ry: number, skin: string, rng: ReturnType<typeof makeRng>): string {
  const rings = [0, 0.34, 0.66, 1.0];
  const perRing = [1, 6, 10, 14];
  const ringPts: Array<Array<[number, number]>> = rings.map((r, ri) => {
    const count = perRing[ri];
    const pts: Array<[number, number]> = [];
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (ri * 0.35);
      const jr = r === 0 ? 1 : 1 + rng.float(-0.06, 0.06);
      pts.push([cx + Math.cos(a) * rx * r * jr, cy + Math.sin(a) * ry * r * jr]);
    }
    return pts;
  });
  const polys: string[] = [];
  const facet = (a: [number, number], b: [number, number], c: [number, number]) => {
    const f = 0.86 + rng.float(0, 0.3);
    polys.push(
      `<polygon points="${n(a[0])},${n(a[1])} ${n(b[0])},${n(b[1])} ${n(c[0])},${n(c[1])}" fill="${shade(skin, f)}" stroke="${shade(skin, 0.7)}" stroke-width="0.6" stroke-opacity="0.5"/>`
    );
  };
  for (let ri = 0; ri < ringPts.length - 1; ri++) {
    const inner = ringPts[ri];
    const outer = ringPts[ri + 1];
    for (let i = 0; i < inner.length; i++) {
      const a1 = inner[i];
      const a2 = inner[(i + 1) % inner.length];
      // map inner index to two nearest outer indices
      const o1 = outer[Math.round((i / inner.length) * outer.length) % outer.length];
      const o2 = outer[Math.round(((i + 1) / inner.length) * outer.length) % outer.length];
      facet(a1, o1, o2);
      facet(a1, o2, a2);
    }
  }
  return `<g>${polys.join('')}</g>`;
}
