#!/usr/bin/env node
/**
 * Dependency audit with a reasoned allowlist.
 *
 * `npm audit` alone is not usable as a release gate here: Expo's toolchain pulls in
 * advisories that are real but unreachable from the shipped app, so a bare audit is
 * permanently red — and a permanently red gate is one nobody reads.
 *
 * So each accepted advisory is listed below with why it does not affect the artifact
 * and what would change that. Anything *not* listed fails the build. The point is that
 * accepting a vulnerability requires writing down a reason a reviewer can disagree with.
 */
import { execFileSync } from 'node:child_process';

/**
 * Advisories accepted for now.
 *
 * `expires` is a date after which the entry stops being accepted, so an accepted
 * advisory cannot quietly become permanent. Re-check on that date rather than extending
 * it reflexively.
 */
const ACCEPTED = [
  {
    match: /^image-size:/,
    severity: 'high',
    reason:
      'Reached only through metro, the bundler. It parses images on the build machine, ' +
      'never in the shipped app, and Juva bundles no untrusted images. A malicious image ' +
      'would have to be added to this repository first.',
    path: 'expo > @expo/metro > metro > image-size',
    expires: '2026-11-01',
  },
  {
    match: /^uuid: Missing buffer bounds check/,
    severity: 'moderate',
    reason:
      'Reached only through xcode > @expo/config-plugins, which runs during prebuild on ' +
      'a developer machine or CI. It is not part of the app binary, and Juva never passes ' +
      'a caller-supplied buffer to it.',
    path: 'expo > @expo/config-plugins > xcode > uuid',
    expires: '2026-11-01',
  },
];

function runAudit() {
  try {
    // npm audit exits non-zero when it finds anything, so the throw is expected.
    return execFileSync('npm', ['audit', '--omit=dev', '--json'], {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    const stdout = /** @type {{ stdout?: string }} */ (error).stdout;
    if (typeof stdout === 'string' && stdout.length > 0) return stdout;
    throw error;
  }
}

const report = JSON.parse(runAudit());

/** Collapse npm's per-package tree into the distinct advisories behind it. */
const advisories = new Map();
for (const entry of Object.values(report.vulnerabilities ?? {})) {
  for (const via of entry.via ?? []) {
    if (typeof via === 'object' && via.title) {
      advisories.set(via.title, { severity: via.severity, url: via.url });
    }
  }
}

const today = new Date().toISOString().slice(0, 10);
const unaccepted = [];
const expired = [];

for (const [title, detail] of advisories) {
  const accepted = ACCEPTED.find((entry) => entry.match.test(title));
  if (!accepted) {
    unaccepted.push({ title, ...detail });
    continue;
  }
  if (accepted.expires < today) expired.push({ title, expires: accepted.expires });
}

console.log(`audit: ${advisories.size} distinct advisory/advisories in production tree`);
for (const [title, detail] of advisories) {
  const accepted = ACCEPTED.find((entry) => entry.match.test(title));
  console.log(`  ${accepted ? 'accepted' : 'BLOCKING'}  ${detail.severity.padEnd(8)} ${title}`);
  if (accepted) console.log(`            ${accepted.path}`);
}

if (expired.length > 0) {
  console.error('\naudit: accepted advisories have expired and must be re-reviewed:');
  for (const entry of expired) console.error(`  ${entry.title} (accepted until ${entry.expires})`);
}

if (unaccepted.length > 0) {
  console.error('\naudit: unaccepted advisories present:');
  for (const entry of unaccepted) {
    console.error(`  ${entry.severity}  ${entry.title}\n    ${entry.url ?? ''}`);
  }
  console.error(
    '\nEither upgrade the dependency, or add an entry to ACCEPTED in scripts/audit.mjs with a ' +
      'reason it cannot affect the shipped app.',
  );
}

process.exit(unaccepted.length > 0 || expired.length > 0 ? 1 : 0);
