// lib/diff.js — unified diff parser + GitHub position mapping.
// GitHub inline comments need `position`: the 1-based line index inside the
// file diff, counting from the first line after the ---/+++ headers
// (the @@ hunk header line is position 1 of its hunk block). We compute it
// exactly that way so comments anchor to the right diff line.
'use strict';

function parseDiff(diffText) {
  const files = [];
  let cur = null;
  let position = 0; // position within current file diff (after headers)
  let inHeaders = true;

  const lines = String(diffText || '').split('\n');
  for (const raw of lines) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      cur = {
        oldPath: m ? m[1] : null,
        path: m ? m[2] : null,
        isNew: false,
        isDeleted: false,
        hunks: [],
      };
      files.push(cur);
      position = 0;
      inHeaders = true;
      continue;
    }
    if (!cur) continue; // ignore preamble
    if (line.startsWith('new file mode')) { cur.isNew = true; continue; }
    if (line.startsWith('deleted file mode')) { cur.isDeleted = true; continue; }
    if (line.startsWith('--- ')) continue;
    if (line.startsWith('+++ ')) { inHeaders = false; continue; }
    if (line.startsWith('@@ ')) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      const hunk = {
        oldStart: Number(m[1]),
        oldLines: m[2] === undefined ? 1 : Number(m[2]),
        newStart: Number(m[3]),
        newLines: m[4] === undefined ? 1 : Number(m[4]),
        header: line,
        lines: [],
      };
      cur.hunks.push(hunk);
      position += 1; // the @@ line itself occupies a position
      hunk.headerPosition = position;
      continue;
    }
    const hunk = cur.hunks[cur.hunks.length - 1];
    if (!hunk) continue;
    position += 1;
    const type = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : 'ctx';
    const entry = { type, content: line.slice(1), raw: line, position };
    if (type === 'add') { entry.newLine = hunk.newStart + countOf(hunk.lines, 'add', 'ctx'); entry.oldLine = null; }
    else if (type === 'del') { entry.oldLine = hunk.oldStart + countOf(hunk.lines, 'del', 'ctx'); entry.newLine = null; }
    else { // context: '\\ No newline' lines have no content marker value
      if (line.startsWith('\\')) { entry.type = 'meta'; entry.content = line; }
      else {
        entry.newLine = hunk.newStart + countOf(hunk.lines, 'add', 'ctx');
        entry.oldLine = hunk.oldStart + countOf(hunk.lines, 'del', 'ctx');
      }
    }
    hunk.lines.push(entry);
  }
  return files;
}

function countOf(lines, ...types) {
  let n = 0;
  for (const l of lines) if (types.includes(l.type)) n += 1;
  return n;
}

function addedLines(files) {
  const out = [];
  for (const f of files) {
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type === 'add') out.push({ file: f.path, line: l.newLine, position: l.position, content: l.content });
      }
    }
  }
  return out;
}

function diffStats(files) {
  let added = 0, removed = 0;
  for (const f of files) for (const h of f.hunks) for (const l of h.lines) {
    if (l.type === 'add') added += 1;
    if (l.type === 'del') removed += 1;
  }
  return { files: files.length, added, removed };
}

module.exports = { parseDiff, addedLines, diffStats };
