#!/usr/bin/env node
/**
 * Secret scan.
 *
 * Looks for credentials committed into the tree, and for the subtler mistake this
 * project is actually prone to: a *private* key placed in an `EXPO_PUBLIC_*`
 * variable. Anything with that prefix is inlined into the JavaScript bundle at build
 * time, so it is readable by anyone who installs the app — a RevenueCat secret key or
 * an OpenRouter key there is published, not configured.
 *
 * Exits non-zero on any finding. Deliberately has no allowlist file: an exception
 * belongs in this script with a comment explaining why, where a reviewer will see it.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const root = process.cwd();

/** Directories that never contain source worth scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.expo',
  'dist',
  'ios',
  'android',
  '.tmp-domain',
  '.tmp-api',
  'coverage',
]);

const SCAN_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|json|md|yml|yaml|env|example|plist|gradle)$/;

/**
 * Files that legitimately contain the *words* below.
 *
 * This script and its own test describe the patterns they look for, so matching
 * themselves would make the scan permanently red.
 */
const SELF_REFERENTIAL = new Set([
  'scripts/secret-scan.mjs',
  'tests/secretScan.test.ts',
  'docs/RELEASE_REPORT.md',
]);

const RULES = [
  {
    id: 'openrouter-key',
    // OpenRouter keys are `sk-or-v1-…`.
    pattern: /sk-or-v1-[A-Za-z0-9]{16,}/,
    message: 'An OpenRouter API key appears in the tree.',
  },
  {
    id: 'openai-style-key',
    pattern: /\bsk-[A-Za-z0-9]{32,}\b/,
    message: 'A provider secret key appears in the tree.',
  },
  {
    id: 'revenuecat-secret-key',
    // Public SDK keys start appl_/goog_/test_; `sk_` is the *secret* API key.
    pattern: /\bsk_[A-Za-z0-9]{20,}\b/,
    message: 'A RevenueCat secret key appears in the tree. Only public SDK keys may ship.',
  },
  {
    id: 'aws-access-key',
    pattern: /\bAKIA[0-9A-Z]{16}\b/,
    message: 'An AWS access key id appears in the tree.',
  },
  {
    id: 'google-api-key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/,
    message: 'A Google API key appears in the tree.',
  },
  {
    id: 'private-key-block',
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/,
    message: 'A private key block appears in the tree.',
  },
  {
    id: 'sentry-dsn-with-secret',
    // A DSN with two colon-separated halves carries a secret that was retired years
    // ago but still grants write access on old projects.
    pattern: /https:\/\/[0-9a-f]{16,}:[0-9a-f]{16,}@[\w.-]+\/\d+/,
    message: 'A legacy Sentry DSN including a secret appears in the tree.',
  },
];

/**
 * The rule that matters most here.
 *
 * `EXPO_PUBLIC_*` is inlined into the bundle. Assigning anything that looks like a
 * private credential to one publishes it.
 */
const PUBLIC_PREFIX_RULE = {
  id: 'private-value-in-public-var',
  pattern: /EXPO_PUBLIC_[A-Z0-9_]*(SECRET|PRIVATE|SERVICE_ROLE)[A-Z0-9_]*\s*=\s*\S+/,
  message:
    'A secret-sounding value is assigned to an EXPO_PUBLIC_ variable, which is inlined into the shipped bundle.',
};

/**
 * A local, gitignored env file is where credentials are *supposed* to live.
 *
 * Scanning them made this gate fail for correct behaviour, which trains people to ignore
 * it. `.env.example` is still scanned — a key committed there is a real leak — and the
 * gitignore assertion below proves the local ones cannot be committed at all.
 */
function isLocalEnvFile(name) {
  return (name === '.env' || name.startsWith('.env.')) && !name.endsWith('.example');
}

function walk(dir, files = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, files);
    else if (isLocalEnvFile(entry)) continue;
    else if (SCAN_EXTENSIONS.test(entry) || entry.startsWith('.env')) files.push(full);
  }
  return files;
}

const findings = [];

for (const file of walk(root)) {
  const relative = path.relative(root, file);
  if (SELF_REFERENTIAL.has(relative)) continue;

  const text = readFileSync(file, 'utf8');
  for (const rule of [...RULES, PUBLIC_PREFIX_RULE]) {
    const match = rule.pattern.exec(text);
    if (!match) continue;
    const line = text.slice(0, match.index).split('\n').length;
    findings.push({ file: relative, line, rule: rule.id, message: rule.message });
  }
}

/**
 * A populated `.env` is not a finding on its own — it is how the app is configured
 * locally — but it must never be committed. Without git we cannot check the index, so
 * the ignore file is checked instead.
 */
const gitignore = (() => {
  try {
    return readFileSync(path.join(root, '.gitignore'), 'utf8');
  } catch {
    return '';
  }
})();

if (!/^\.env$/m.test(gitignore) && !/^\.env\*?$/m.test(gitignore)) {
  findings.push({
    file: '.gitignore',
    line: 1,
    rule: 'env-not-ignored',
    message: '.env is not gitignored, so local credentials could be committed.',
  });
}

if (findings.length === 0) {
  console.log(`secret-scan: clean (${RULES.length + 1} rules)`);
  process.exit(0);
}

console.error(`secret-scan: ${findings.length} finding(s)\n`);
for (const finding of findings) {
  console.error(`  ${finding.file}:${finding.line}  [${finding.rule}] ${finding.message}`);
}
process.exit(1);
