'use strict';

/**
 * Syntax check for every JavaScript file in the project.
 *
 * CommonJS files are checked with `node --check`; renderer ES modules are
 * checked through stdin with `--input-type=module`. Exits non-zero on any
 * failure so `npm run check` / CI can gate on it.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'out', 'release', 'build']);

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(path.join(dir, entry.name), out);
    } else if (entry.isFile() && entry.name.endsWith('.js')) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

function isESM(source) {
  return /^\s*(import|export)\s/m.test(source);
}

function checkFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  const rel = path.relative(ROOT, file);
  if (isESM(source)) {
    const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
      input: source,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      return { rel, ok: false, output: `${result.stdout || ''}${result.stderr || ''}` };
    }
    return { rel, ok: true };
  }
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    return { rel, ok: false, output: `${result.stdout || ''}${result.stderr || ''}` };
  }
  return { rel, ok: true };
}

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'tests')), ...walk(path.join(ROOT, 'scripts'))];
let failures = 0;
for (const file of files) {
  const result = checkFile(file);
  if (!result.ok) {
    failures += 1;
    console.error(`✗ ${result.rel}\n${result.output}`);
  }
}

console.log(`${files.length - failures}/${files.length} files passed syntax check.`);
process.exit(failures > 0 ? 1 : 0);