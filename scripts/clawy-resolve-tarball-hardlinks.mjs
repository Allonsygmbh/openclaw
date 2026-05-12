#!/usr/bin/env node
// Resolve hardlinks in an npm pack tarball into regular files with full data.
//
// `npm pack` emits hardlink entries for content-deduplicated files (44-byte
// types.js stubs in pi-agent-core, identical .editorconfig files across
// dozens of micro-packages, etc.). The hardlink target paths can appear
// AFTER the link entries in the archive stream, so any naive extractor
// leaves 0-byte stubs or skips entries entirely.
//
// We've previously tried:
//   - `tar --hard-dereference` at re-pack: failed in GH Actions runners
//     (silent 0-byte stubs for pi-agent-core/dist/types.js etc).
//   - `cp -r` after extract to break hardlinks: didn't help — the
//     extract itself was already dropping files (33850 in CI vs 36930
//     locally for the same source).
//
// This script sidesteps those layers: read the input tarball stream once,
// buffer file data into memory, then re-emit a flat tarball where every
// Link entry is replaced by a regular File entry carrying the target's
// data. Output has zero hardlinks regardless of what GNU tar, node-tar's
// extract, or pacote's tar handler do downstream.
//
// Usage: node scripts/clawy-resolve-tarball-hardlinks.mjs <input.tgz> <output.tgz>

import { createReadStream, statSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { Parser, create as tarCreate } from "tar";

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error("usage: clawy-resolve-tarball-hardlinks.mjs <input.tgz> <output.tgz>");
  process.exit(2);
}

const entries = []; // ordered list to preserve archive order
const fileData = new Map(); // path -> Buffer

await new Promise((resolve, reject) => {
  const parser = new Parser({});
  parser.on("entry", (entry) => {
    if (entry.type === "File" || entry.type === "OldFile" || entry.type === "ContiguousFile") {
      const chunks = [];
      entry.on("data", (c) => chunks.push(c));
      entry.on("end", () => {
        const buf = Buffer.concat(chunks);
        fileData.set(entry.path, buf);
        entries.push({
          type: "File",
          path: entry.path,
          mode: entry.mode,
          uid: entry.uid,
          gid: entry.gid,
          mtime: entry.mtime,
          data: buf,
        });
      });
    } else if (entry.type === "Link") {
      entries.push({
        type: "Link",
        path: entry.path,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtime: entry.mtime,
        linkpath: entry.linkpath,
      });
      entry.resume();
    } else if (entry.type === "SymbolicLink") {
      entries.push({
        type: "SymbolicLink",
        path: entry.path,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtime: entry.mtime,
        linkpath: entry.linkpath,
      });
      entry.resume();
    } else if (entry.type === "Directory" || entry.type === "GNUDumpDir") {
      entries.push({
        type: "Directory",
        path: entry.path,
        mode: entry.mode,
        uid: entry.uid,
        gid: entry.gid,
        mtime: entry.mtime,
      });
      entry.resume();
    } else {
      entry.resume();
    }
  });
  parser.on("error", reject);
  parser.on("end", resolve);
  createReadStream(inputPath).pipe(createGunzip()).pipe(parser);
});

const counts = {
  files: entries.filter((e) => e.type === "File").length,
  dirs: entries.filter((e) => e.type === "Directory").length,
  hardlinks: entries.filter((e) => e.type === "Link").length,
  symlinks: entries.filter((e) => e.type === "SymbolicLink").length,
};

// Build the resolved entry list: replace every Link with a File whose data
// is the target's data. Preserve archive order.
let unresolvedLinks = 0;
const resolved = [];
for (const e of entries) {
  if (e.type !== "Link") {
    resolved.push(e);
    continue;
  }
  const targetData = fileData.get(e.linkpath);
  if (!targetData) {
    unresolvedLinks++;
    console.error(`unresolved hardlink: ${e.path} -> ${e.linkpath}`);
    continue;
  }
  resolved.push({
    type: "File",
    path: e.path,
    mode: e.mode,
    uid: e.uid,
    gid: e.gid,
    mtime: e.mtime,
    data: targetData,
  });
}

if (unresolvedLinks > 0) {
  console.error(`ERROR: ${unresolvedLinks} hardlinks could not be resolved`);
  process.exit(1);
}

// Stream resolved entries into a node-tar Pack. We feed each entry as if
// they were files-on-disk by using tar.create with a synthesized cwd. To
// avoid actually writing files, we use the lower-level approach: drive a
// Pack with explicit headers + payloads.
//
// node-tar v7 doesn't expose a documented "add raw entry" API on Pack,
// so the simplest robust path is: write each entry to a temp staging dir
// (regular files only, no hardlinks), then call tar.create on that dir.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), "clawy-tar-resolve-"));
try {
  for (const e of resolved) {
    const target = path.join(stagingDir, e.path);
    if (e.type === "Directory") {
      fs.mkdirSync(target, { recursive: true, mode: e.mode ?? 0o755 });
    } else if (e.type === "File") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, e.data);
      try {
        if (typeof e.mode === "number") fs.chmodSync(target, e.mode);
      } catch {}
    } else if (e.type === "SymbolicLink") {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try {
        fs.symlinkSync(e.linkpath, target);
      } catch (err) {
        if (err.code !== "EEXIST") throw err;
      }
    }
  }

  // Sanity: every file in staging must have nlink === 1 (no accidental
  // hardlinks from the writeFileSync pass on filesystems that dedup).
  let staleHl = 0;
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(p);
      } else if (ent.isFile()) {
        const st = fs.lstatSync(p);
        if (st.nlink > 1) staleHl++;
      }
    }
  };
  walk(stagingDir);
  if (staleHl > 0) {
    console.error(`ERROR: ${staleHl} files in staging have nlink>1 — pack would emit hardlinks`);
    process.exit(1);
  }

  // Determine the package root inside staging (npm pack creates `package/`).
  const stagedDirs = fs
    .readdirSync(stagingDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);

  // Pack everything as ustar, sorted, ownership zeroed for reproducibility.
  await tarCreate(
    {
      file: outputPath,
      cwd: stagingDir,
      gzip: true,
      portable: true,
      noPax: true,
      mtime: new Date(0), // stable mtimes regardless of writeFileSync timing
    },
    stagedDirs,
  );
} finally {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}

const outSize = statSync(outputPath).size;
console.log(
  `resolved-hardlinks: files=${counts.files} dirs=${counts.dirs} hardlinks=${counts.hardlinks} symlinks=${counts.symlinks} out-size=${outSize}`,
);
