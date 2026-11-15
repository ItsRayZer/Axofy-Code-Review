// lib/codegraph.js — fresh per-review code graph (CodeRabbit-style).
// Built from scratch for every review from the files we have (clone or API
// contents) — never a stale pre-built index. Nodes: definitions (function /
// class / method / const-arrow), imports, and call sites. Edges: file A
// imports/calls something defined in file B. Blast radius for a changed
// function = every file that calls or imports it (direct callers, 1 hop;
// transitive callers are listed separately and capped).
// Regex-based (no tree-sitter dependency yet); JS/TS + Python covered.
'use strict';

const DEF_RES = [
  /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
  /(?:^|\n)\s*(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/g,
  /(?:^|\n)\s*def\s+([A-Za-z_$][\w$]*)\s*\(/g,
  /(?:^|\n)\s*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g, // methods (JS object/class)
  // Go: func Name( / func (r T) Name(
  /(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)\s*\(/g,
  // Rust: pub fn name(
  /(?:^|\n)\s*(?:pub\s+)?fn\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // Java / C# / Kotlin / PHP / Swift: [modifiers] ReturnType name(
  /(?:^|\n)\s*(?:public|private|protected|internal|static|final|async|fun|func)\s+(?:[\w<>\[\],\s]+\s+)?([A-Za-z_$][\w$]*)\s*\(/g,
  // PHP: function name(
  /(?:^|\n)\s*function\s+([A-Za-z_$][\w$]*)\s*\(/g,
  // Ruby: def name / class Name
  /(?:^|\n)\s*def\s+(?:self\.)?([A-Za-z_$][\w$]*)/g,
  // C/C++: return_type name(
  /(?:^|\n)\s*(?:int|void|char|long|double|float|bool|std::[\w:]+)\s+([A-Za-z_$][\w$]*)\s*\(/g,
];

const IMPORT_RES = [
  /import\s+.*?from\s+['"]([^'"]+)['"]/g,
  /require\(['"]([^'"]+)['"]\)/g,
  /(?:^|\n)\s*from\s+([\w.]+)\s+import/g,
  /(?:^|\n)\s*import\s+([\w.]+)/g,
  /(?:^|\n)\s*import\s+\(?\s*["']([^"']+)["']/g, // Go: import "fmt"
  /(?:^|\n)\s*use\s+([\w:]+)/g, // Rust: use std::io
  /(?:^|\n)\s*use\s+([\w\\]+);/g, // PHP: use App\Foo
  /(?:^|\n)\s*using\s+([\w.]+);/g, // C#
  /(?:^|\n)\s*require\s+['"]([^'"]+)['"]/g, // Ruby: require 'x'
  /(?:^|\n)\s*#include\s*[<"]([^>"]+)[>"]/g, // C/C++
];

function extractDefinitions(text) {
  const defs = new Map(); // name -> { name, kind }
  for (const re of DEF_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text || ''))) {
      const name = m[1];
      if (name && name.length > 1 && !['if', 'for', 'while', 'switch', 'catch', 'return'].includes(name)) {
        defs.set(name, { name, kind: re === DEF_RES[2] ? 'class' : re === DEF_RES[3] ? 'function' : 'function' });
      }
    }
  }
  return [...defs.values()];
}

function extractImports(text) {
  const imports = new Set();
  for (const re of IMPORT_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text || ''))) if (m[1]) imports.add(m[1]);
  }
  return [...imports];
}

// fileTexts: { path: text }. Returns { nodes, edges, byFile }.
function buildCodeGraph(fileTexts) {
  const byFile = {};
  const defOwner = new Map(); // symbol -> file that defines it
  for (const [file, text] of Object.entries(fileTexts)) {
    const defs = extractDefinitions(text);
    const imports = extractImports(text);
    byFile[file] = { definitions: defs, imports };
    for (const d of defs) if (!defOwner.has(d.name)) defOwner.set(d.name, file);
  }
  const edges = []; // { from, to, via, kind: 'call' | 'import' }
  for (const [file, text] of Object.entries(fileTexts)) {
    for (const imp of byFile[file].imports) {
      // Resolve a relative import to a file in the graph.
      const target = Object.keys(fileTexts).find((f) => f.endsWith(imp.replace(/^\.\//, '').replace(/^\.\.\//, '')) || f.replace(/\.(js|ts|jsx|tsx|py)$/, '') === imp.replace(/^\.\//, ''));
      if (target && target !== file) edges.push({ from: file, to: target, via: imp, kind: 'import' });
    }
    for (const [name, owner] of defOwner) {
      if (owner === file) continue;
      if (new RegExp('\\b' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\(').test(text)) {
        edges.push({ from: file, to: owner, via: name, kind: 'call' });
      }
    }
  }
  return { byFile, edges, defOwner };
}

// Blast radius: for each changed file, which other files call/import it.
function blastRadius(graph, changedFiles) {
  const out = {};
  for (const f of changedFiles) {
    const callers = graph.edges.filter((e) => e.to === f).map((e) => ({ file: e.from, via: e.via, kind: e.kind }));
    const defs = (graph.byFile[f]?.definitions || []).map((d) => d.name);
    out[f] = { definitions: defs, callers };
  }
  return out;
}

module.exports = { buildCodeGraph, blastRadius, extractDefinitions, extractImports };
