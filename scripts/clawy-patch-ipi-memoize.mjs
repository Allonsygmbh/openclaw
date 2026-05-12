// Clawy fork-only post-build patches.
//
// Two memoization patches that together take dispatch on a 2 GB Hetzner
// cx23 from ~280s to ~70s with 121 bundled plugins:
//
//   1. `loadInstalledPluginIndex` — the runtime rebuilds the bundled-plugin
//      index 60+ times per dispatch over the same effective inputs. Cache
//      by the small subset of params that actually invalidate it.
//
//   2. `registerBundledRuntimeDependencyJitiAliases` — re-walks every
//      bundled plugin's `package.json` + transitive dep tree on every
//      plugin load. Track which root dirs we've already registered and
//      short-circuit repeats.
//
// Both functions get bundled into rollup chunks whose filenames change
// between releases (and even between CI build vs published tarball). We
// match by content, not filename, and use unique markers so the script
// is idempotent — a second run is a no-op.
//
// Run after `pnpm build` (which produces dist/) and before `npm pack`.
//
// Upstream tracking: this is an upstream perf bug, not a fork-introduced
// regression — file an issue against wonderwhy-er/openclaw and remove
// these patches when their runtime memoizes natively.

import fs from "node:fs";
import path from "node:path";

const distDir = process.argv[2] ?? "dist";
const dirAbs = path.resolve(distDir);

if (!fs.existsSync(dirAbs)) {
  console.error(`[clawy-patch] dist dir does not exist: ${dirAbs}`);
  process.exit(2);
}

function walk(dir, predicate, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p, predicate, acc);
    else if (entry.isFile() && predicate(entry.name)) acc.push(p);
  }
  return acc;
}

function dumpTree(dir, max = 60) {
  let i = 0;
  function rec(d, depth = 0) {
    if (i >= max) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (i++ >= max) return;
      console.error(
        `  ${" ".repeat(depth * 2)}${entry.isDirectory() ? "[d] " : "    "}${entry.name}`,
      );
      if (entry.isDirectory() && depth < 2) rec(path.join(d, entry.name), depth + 1);
    }
  }
  rec(dir);
}

// Content-based patch: locate the chunk by either NEEDLE_RE (unpatched)
// or MARKER (already patched), then apply if needed. NEEDLE_RE must be
// a regex so we tolerate the tab-vs-space and inline-vs-multiline drift
// between the npm-published tarball and a fresh `pnpm build` output.
function applyContentPatch({ label, marker, needleRe, replacement, fingerprint }) {
  const candidates = walk(dirAbs, (name) => /\.m?js$/.test(name));
  let unpatched = [];
  let alreadyPatched = [];
  let containsFingerprint = [];
  for (const p of candidates) {
    const src = fs.readFileSync(p, "utf8");
    if (src.includes(marker)) {
      alreadyPatched.push(p);
      continue;
    }
    if (needleRe.test(src)) {
      unpatched.push(p);
    } else if (fingerprint && src.includes(fingerprint)) {
      // Hint: this chunk has the function name but our regex didn't bite.
      containsFingerprint.push(p);
    }
  }

  if (alreadyPatched.length && !unpatched.length) {
    console.log(`[clawy-patch:${label}] already patched: ${alreadyPatched.join(", ")}`);
    return;
  }
  if (unpatched.length === 0) {
    console.error(
      `[clawy-patch:${label}] needle regex did not match — upstream shape may have drifted.`,
    );
    if (containsFingerprint.length) {
      console.error(`  Chunks containing "${fingerprint}" (${containsFingerprint.length}):`);
      for (const p of containsFingerprint.slice(0, 3)) {
        const src = fs.readFileSync(p, "utf8");
        const idx = src.indexOf(fingerprint);
        const window = src.slice(Math.max(0, idx - 80), idx + 240);
        console.error(`  ── ${p}:`);
        console.error(
          window
            .split("\n")
            .map((l) => "    | " + l)
            .join("\n"),
        );
      }
    } else {
      console.error(
        `  No chunk contains "${fingerprint}" either — function may be in a separate chunk under ${dirAbs}.`,
      );
      dumpTree(dirAbs);
    }
    process.exit(2);
  }
  if (unpatched.length > 1) {
    console.error(
      `[clawy-patch:${label}] expected exactly one chunk to match, got ${unpatched.length}: ${JSON.stringify(unpatched)}`,
    );
    process.exit(2);
  }

  const target = unpatched[0];
  const src = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, src.replace(needleRe, replacement));
  console.log(`[clawy-patch:${label}] patched: ${target}`);
}

// ── Patch 1: loadInstalledPluginIndex memoize ────────────────────────────
applyContentPatch({
  label: "ipi-memoize",
  marker: "/*__CLAWY_IPI_MEMOIZE__*/",
  fingerprint: "loadInstalledPluginIndex",
  needleRe:
    /function\s+loadInstalledPluginIndex\s*\(\s*params\s*=\s*\{\s*\}\s*\)\s*\{\s*return\s+buildInstalledPluginIndex\s*\(\s*params\s*\)\s*;?\s*\}/,
  replacement: `/*__CLAWY_IPI_MEMOIZE__*/
const _installedPluginIndexCache = new Map();
function _ipiCacheKey(params) {
\tconst p = params || {};
\tconst configFp = p.config ? (p.config?.meta?.lastTouchedAt || "_") + "|" + (p.config?.meta?.lastTouchedVersion || "_") : "_";
\treturn (p.workspaceDir || "_") + "|" + (!!p.preferPersisted) + "|" + (!!p.includeDisabled) + "|" + configFp;
}
function loadInstalledPluginIndex(params = {}) {
\tconst key = _ipiCacheKey(params);
\tlet hit = _installedPluginIndexCache.get(key);
\tif (hit) return hit;
\thit = buildInstalledPluginIndex(params);
\t_installedPluginIndexCache.set(key, hit);
\treturn hit;
}`,
});

// JITI alias memoization removed on v2026.5.x: upstream now caches the
// normalized jiti alias map natively via `normalizedJitiAliasMapCache`
// (a `PluginLruCache` in src/plugins/sdk-alias.ts, landed before v2026.5.7).
// Our two former `jiti-alias-*` patches targeted
// `clearBundledRuntimeDependencyJitiAliases` and
// `registerBundledRuntimeDependencyJitiAliases`, neither of which exist
// in the upstream refactor. The IPI memoize above is still needed
// because upstream hasn't memoized `loadInstalledPluginIndex` itself.
//
// If we ever rebase back to a base that DOES still have the
// `bundledRuntimeDependencyJitiAliases` Map, the two `applyContentPatch`
// calls are in git history (commit a35bc850ea …).

console.log("[clawy-patch] all patches applied");
