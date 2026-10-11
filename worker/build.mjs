/**
 * Build step.
 *
 * index.html at the repository root stays the single source of truth (open it
 * directly, edit it, upload it anywhere). This script copies it into ./public,
 * which is what the Worker serves as static assets. Nothing is generated or
 * rewritten - it is a plain copy, so the file can never silently drift.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = path.resolve(here, '..', 'index.html');
const outDir = path.join(here, 'public');
const target = path.join(outDir, 'index.html');

if (!fs.existsSync(source)) {
  console.error('✗ Could not find ' + source);
  process.exit(1);
}

fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(source, target);

const bytes = fs.statSync(target).size;
console.log('✓ public/index.html  ' + (bytes / 1024).toFixed(1) + ' KB  (copied from ../index.html)');
