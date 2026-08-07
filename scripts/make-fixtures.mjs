#!/usr/bin/env node
/**
 * make-fixtures.mjs — deterministic sandbox fixture tree for the Robot
 * Framework acceptance suites (tests/robot/**).
 *
 *   node scripts/make-fixtures.mjs <targetDir>
 *
 * Layout (see junk sandbox rules in packages/core/src/scanners/junk.ts):
 *   Caches/app1/blob.cache          junk (dir rule, confidence 0.9)
 *   tmp/scratch.tmp                 junk (dir rule)
 *   Logs/old.log                    junk (dir rule)
 *   .Trash/x.bin                    junk (dir rule)
 *   Documents/keep.log              NEVER a candidate (protected dir)
 *   Documents/important.txt         NEVER a candidate
 *   big/big1.bin                    2,000,000 bytes  (large @ threshold 1e6)
 *   big/big2.bin                    5,000,000 bytes  (large @ threshold 1e6)
 *   dup/a/photo.jpg                 300,000 bytes — canonical (oldest mtime)
 *   dup/b/photo-copy.jpg            identical bytes to photo.jpg
 *   dup/c/other.jpg                 same size AND same first/last 64KB but a
 *                                   different middle → passes the partial-hash
 *                                   stage, must be rejected by the full hash
 *                                   (the false-positive guard).
 *   Applications/Toy.app/Contents/Info.plist   sandbox app fixture (JSON)
 *   Library/Application Support/Toy/data.bin   owned path of com.toy
 *
 * Every byte is derived from a seeded PRNG (no Date/Math.random in content)
 * and every file gets a fixed mtime/atime so canonical-duplicate selection
 * (oldest mtime wins) and any age-based logic are deterministic.
 */
import { mkdirSync, writeFileSync, utimesSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const target = process.argv[2];
if (!target) {
  console.error('usage: node scripts/make-fixtures.mjs <targetDir>');
  process.exit(1);
}
const root = path.resolve(target);

// -- seeded PRNG (mulberry32) — deterministic file bytes --------------------
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seededBytes(seed, length) {
  const rand = mulberry32(seed);
  const buf = Buffer.allocUnsafe(length);
  for (let i = 0; i < length; i++) buf[i] = Math.floor(rand() * 256);
  return buf;
}

// Fixed timestamps (epoch seconds). Old enough to be "stale" for any
// age-threshold logic; photo.jpg is strictly older than photo-copy.jpg so the
// canonical pick (oldest mtime) is deterministic.
const T_BASE = Date.UTC(2021, 0, 1) / 1000; // 2021-01-01T00:00:00Z
const T_COPY = T_BASE + 24 * 60 * 60; //       2021-01-02T00:00:00Z

function put(relPath, content, mtimeSec = T_BASE) {
  const full = path.join(root, ...relPath.split('/'));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content);
  utimesSync(full, mtimeSec, mtimeSec);
  return full;
}

// -- junk (all inside case-insensitive junk dir names) ----------------------
put('Caches/app1/blob.cache', seededBytes(101, 4096));
put('tmp/scratch.tmp', seededBytes(102, 2048));
put('Logs/old.log', 'fixture log line 1\nfixture log line 2\n');
put('.Trash/x.bin', seededBytes(103, 1024));

// -- protected user content (must NEVER be junk candidates) -----------------
put('Documents/keep.log', 'this log lives in Documents and is protected\n');
put('Documents/important.txt', 'irreplaceable user document\n');

// -- large files (>= 1,000,000 with --large-threshold 1000000) --------------
put('big/big1.bin', seededBytes(201, 2_000_000));
put('big/big2.bin', seededBytes(202, 5_000_000));

// -- duplicates --------------------------------------------------------------
// photoBytes >= 200KB so both the partial-hash (first+last 64KB) and the
// full-hash stages are exercised.
const photoBytes = seededBytes(301, 300_000);
put('dup/a/photo.jpg', photoBytes, T_BASE); // oldest mtime → canonical
put('dup/b/photo-copy.jpg', photoBytes, T_COPY);
// other.jpg: same size, same ext, same first+last 64KB, different middle —
// survives blocking AND partial hashing; only the full hash may reject it.
const otherBytes = Buffer.from(photoBytes);
const mid = Math.floor(otherBytes.length / 2);
const diff = seededBytes(302, 128);
diff.copy(otherBytes, mid);
put('dup/c/other.jpg', otherBytes, T_COPY);

// -- sandbox app-uninstall fixture -------------------------------------------
put(
  'Applications/Toy.app/Contents/Info.plist',
  JSON.stringify(
    {
      CFBundleIdentifier: 'com.toy',
      CFBundleName: 'Toy',
      CFBundleShortVersionString: '1.0.0',
      ownedPaths: ['Library/Application Support/Toy'],
    },
    null,
    2,
  ) + '\n',
);
put('Library/Application Support/Toy/data.bin', seededBytes(401, 8192));

console.log(root);
