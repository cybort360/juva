#!/usr/bin/env node
/**
 * Generates Juva's launcher icon and splash from its own palette.
 *
 * Committed as a script rather than as opaque binaries so the marks stay editable and
 * on-brand: the icon is the Juva Rail orb — the same signal-green dot on ink that the
 * app's own navigation uses — and the splash is paper with that orb centred, so a cold
 * launch is continuous with the first screen instead of a white flash.
 *
 * Written with rsvg-convert, which is already present on this machine. Regenerate with
 * `npm run assets`.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';

const OUT = path.join(process.cwd(), 'assets');
mkdirSync(OUT, { recursive: true });

const INK = '#161A16';
const PAPER = '#F4F1E8';
const SIGNAL = '#C6F36B';

/**
 * The orb.
 *
 * A ring of ink with a signal-green core: the shape the Juva Rail already uses for the
 * active state, so the icon is a piece of the product rather than a logo bolted on.
 */
function orb({ size, background, ringInset }) {
  const c = size / 2;
  const ring = c - size * ringInset;
  const core = ring * 0.44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${background}"/>
  <circle cx="${c}" cy="${c}" r="${ring}" fill="${INK}"/>
  <circle cx="${c}" cy="${c}" r="${core}" fill="${SIGNAL}"/>
</svg>`;
}

/** A transparent-background variant, for the Android adaptive foreground layer. */
function adaptiveForeground(size) {
  const c = size / 2;
  // Android masks the outer ~1/3, so the mark sits well inside the safe zone.
  const ring = size * 0.26;
  const core = ring * 0.44;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <circle cx="${c}" cy="${c}" r="${ring}" fill="${INK}"/>
  <circle cx="${c}" cy="${c}" r="${core}" fill="${SIGNAL}"/>
</svg>`;
}

const targets = [
  // Store icon: opaque, no transparency, no rounded corners — the platforms mask it.
  { name: 'icon.png', size: 1024, svg: orb({ size: 1024, background: PAPER, ringInset: 0.22 }) },
  {
    name: 'adaptive-icon.png',
    size: 1024,
    svg: adaptiveForeground(1024),
  },
  // Splash: the same orb on paper, so the launch and the first frame share a colour.
  { name: 'splash.png', size: 1284, svg: orb({ size: 1284, background: PAPER, ringInset: 0.38 }) },
  { name: 'favicon.png', size: 48, svg: orb({ size: 48, background: PAPER, ringInset: 0.18 }) },
];

for (const target of targets) {
  const svgPath = path.join(OUT, `${target.name}.svg`);
  const pngPath = path.join(OUT, target.name);
  writeFileSync(svgPath, target.svg);
  execFileSync('rsvg-convert', [
    svgPath,
    '-w',
    String(target.size),
    '-h',
    String(target.size),
    '-o',
    pngPath,
  ]);
  rmSync(svgPath);
  console.log(`assets: ${target.name} (${target.size}x${target.size})`);
}
