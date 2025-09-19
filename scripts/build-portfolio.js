#!/usr/bin/env node
/*
  Tiny build script: scans repo for index.html files and injects a minimalist
  link list into index2.html between the markers:
    <!-- BEGIN AUTO-LIST -->
    <!-- END AUTO-LIST -->

  Usage:
    node scripts/build-portfolio.js
*/

const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const TARGET = path.join(ROOT, 'index2.html');

const IGNORE_DIRS = new Set(['.git', 'node_modules', '.DS_Store']);

function walk(dir, out = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    if (IGNORE_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full, out);
    } else if (e.isFile() && e.name === 'index.html') {
      out.push(full);
    }
  }
  return out;
}

function toItem(filePath) {
  const rel = path.relative(ROOT, filePath).split(path.sep).join('/');
  if (rel === 'index.html') {
    return { name: 'Home', url: './' };
  }
  const dir = path.posix.dirname(rel);
  const name = path.posix.basename(dir);
  return { name, url: `${dir}/` };
}

function buildListHTML(items) {
  return items
    .map(({ name, url }) =>
      [
        '        <li>',
        `          <a href="${url}">${name}</a>`,
        `          <span class="url">${url}</span>`,
        '        </li>'
      ].join('\n')
    )
    .join('\n');
}

function injectIntoIndex2(htmlList) {
  const src = fs.readFileSync(TARGET, 'utf8');
  const start = '<!-- BEGIN AUTO-LIST -->';
  const end = '<!-- END AUTO-LIST -->';
  const startIdx = src.indexOf(start);
  const endIdx = src.indexOf(end);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    throw new Error('Markers not found in index2.html');
  }
  const before = src.slice(0, startIdx + start.length);
  const after = src.slice(endIdx);
  const injected = `${before}\n${htmlList}\n        ${after}`;
  fs.writeFileSync(TARGET, injected, 'utf8');
}

// Execute
const files = walk(ROOT);
const items = files.map(toItem)
  // Remove duplicates (in case of symlinks etc.)
  .filter((v, i, a) => a.findIndex(b => b.url === v.url) === i)
  // Sort by name, then url
  .sort((a, b) => (a.name.localeCompare(b.name) || a.url.localeCompare(b.url)));

const htmlList = buildListHTML(items);
injectIntoIndex2(htmlList);

console.log(`Injected ${items.length} items into index2.html`);

