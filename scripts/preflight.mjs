/**
 * Release preflight: verify the package is publishable before `npm publish`.
 *
 * Runs as `prepack`, so `npm pack` and `npm publish` both execute it. It checks
 * the things a broken tarball gets rejected for — or worse, gets *published*
 * for and only fails later on a user's machine:
 *
 *   1. `dsh.bundle.patch` exists and declares this package's own name.
 *   2. `exports` covers `.`, `./client`, and the patch file the loader reads.
 *   3. Every file the tarball needs is actually in `files`.
 *   4. Peer ranges accept the DSH releases this plugin is known to run on.
 *
 *   node scripts/preflight.mjs
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const problems = [];
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) problems.push(label);
};

// ── Manifest basics ─────────────────────────────────────────────────────────
check('package is not private', pkg.private !== true);
check('version is a plain semver', /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(pkg.version ?? ''), String(pkg.version));
check('license is declared', typeof pkg.license === 'string' && pkg.license !== '');
check('repository points at a git URL', typeof pkg.repository?.url === 'string' && /^git\+https:|^https:/.test(pkg.repository.url), String(pkg.repository?.url));
check('description ends with a period', /\.$/.test(pkg.description ?? ''), String(pkg.description).slice(-40));

// ── dsh.bundle: this is what makes `dsh plugin add` work ────────────────────
check('declares dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string', String(pkg.dsh?.bundle?.patch));
const patchPath = pkg.dsh?.bundle?.patch ? join(root, pkg.dsh.bundle.patch) : null;
check('the patch file exists', Boolean(patchPath && existsSync(patchPath)), pkg.dsh?.bundle?.patch ?? '');

if (patchPath && existsSync(patchPath)) {
  const patch = readFileSync(patchPath, 'utf8');
  // The row the composition inserts must name THIS package, or installing it
  // adds a row that loads nothing.
  check('the patch inserts this package name', new RegExp(`name:\\s*${pkg.name}\\s*$`, 'm').test(patch), pkg.name);
  check('the patch inserts a stable id', /id:\s*[\w-]+/m.test(patch));
}

// `dsh.client` alone is not installable — the bundle manifest is required.
check('declares dsh.client.platform for the UI half', pkg.dsh?.client?.platform === 'web', String(pkg.dsh?.client?.platform));

// ── exports: the loader resolves these exact subpaths ───────────────────────
for (const key of ['.', './client', './cordis.patch.yml', './package.json']) {
  const ok = pkg.exports?.[key] !== undefined;
  check(`exports["${key}"] is declared`, ok);
}
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
  if (typeof value !== 'string') continue;
  const target = join(root, value);
  check(`exports["${key}"] resolves to a file`, existsSync(target), value);
}

// ── files: anything loadable must ship ─────────────────────────────────────
const files = pkg.files ?? [];
for (const needed of ['src', 'client', pkg.dsh?.bundle?.patch?.replace(/^\.\//, '')]) {
  if (!needed) continue;
  check(`"${needed}" is in files[]`, files.some((entry) => entry === needed || needed.startsWith(`${entry}/`)), files.join(', '));
}
check('LICENSE is in files[]', files.includes('LICENSE') || existsSync(join(root, 'LICENSE')));
check('src/index.js exists', existsSync(join(root, 'src', 'index.js')));
check('client/client.js exists', existsSync(join(root, 'client', 'client.js')));

// ── Compatible host ranges ─────────────────────────────────────────────────
// A prerelease host is the common case here, and node-semver silently excludes
// prereleases from a range that has no matching prerelease comparator. Every
// range below therefore has an explicit `||` prerelease branch.
const DSH_ENGINE = pkg.engines?.dsh ?? '';
check('engines.dsh carries a prerelease branch', /-rc\.|-alpha\.|-beta\./.test(DSH_ENGINE), DSH_ENGINE);
check('engines.node is declared', typeof pkg.engines?.node === 'string', String(pkg.engines?.node));

const peers = pkg.peerDependencies ?? {};
check('cordis is a peer, not a dependency', peers['@deepseek-ai/cordis'] !== undefined && pkg.dependencies?.['@deepseek-ai/cordis'] === undefined);

// Every official package MUST be a peer: bundling our own copy of cordis would
// give the plugin a second, disconnected service registry.
const officialDeps = Object.keys(pkg.dependencies ?? {}).filter((name) => name.startsWith('@deepseek-ai/'));
check('no official package is a runtime dependency', officialDeps.length === 0, officialDeps.join(', '));

// ── No stray artefacts ─────────────────────────────────────────────────────
for (const stray of ['node_modules', 'test', 'scripts']) {
  if (!files.includes(stray)) continue;
  check(`"${stray}" is not shipped`, false, 'listed in files[]');
}

const failed = problems.length;
console.log(`\n${failed === 0 ? 'preflight OK' : `preflight FAILED: ${failed} problem(s)`}`);
process.exit(failed === 0 ? 0 : 1);
