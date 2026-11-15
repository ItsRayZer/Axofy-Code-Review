#!/usr/bin/env node
// bin/axoreview.js — thin CLI client. Diffs the working tree (or a branch)
// and reviews it — via a running Axofy Code Review server when one is
// reachable, otherwise locally (deterministic checks + SE, no server, no
// key, no website). The local path never calls an LLM directly and never
// needs an API key; with a free BYOM key in env it uses the model.
// Usage:
//   axoreview review [--base main] [--profile chill] [--file path/to.diff]
//                    [--line-by-line] [--se|--no-se] [--depth quick|standard|deep]
//                    [--url http://localhost:3000]
// Env: AXOREVIEW_URL (default http://localhost:3000)
'use strict';

const { execFileSync } = require('child_process');
const fs = require('fs');

const BASE_URL = (process.env.AXOREVIEW_URL || 'http://localhost:3000').replace(/\/$/, '');

function parseArgs(argv) {
  const out = { cmd: argv[0] || 'review', base: 'main', profile: 'chill', file: null, url: BASE_URL, lineByLine: false, se: true, depth: 'standard' };
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--base') out.base = argv[++i];
    else if (argv[i] === '--profile') out.profile = argv[++i];
    else if (argv[i] === '--file') out.file = argv[++i];
    else if (argv[i] === '--url') out.url = argv[++i];
    else if (argv[i] === '--line-by-line') out.lineByLine = true;
    else if (argv[i] === '--se') out.se = true;
    else if (argv[i] === '--no-se') out.se = false;
    else if (argv[i] === '--depth') out.depth = argv[++i];
    else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
  }
  return out;
}

function printLineVerdicts(review) {
  const verdicts = review.lineByLine || [];
  console.log(`\nLine-by-line (${verdicts.length} changed lines) — SE score ${review.se?.score ?? '?'}/100 (grade ${review.se?.grade ?? '?'})`);
  for (const v of verdicts) {
    const mark = v.verdict === 'ok' ? 'ok      ' : v.verdict.toUpperCase().padEnd(8, ' ');
    console.log(`  [${mark}] ${v.file}:${v.line}  ${v.code.trim().slice(0, 100)}`);
    for (const f of v.findings) console.log(`           ↳ ${f.severity}: ${f.title}`);
    for (const n of v.seNotes || []) console.log(`           ↳ SE ${n.se}: ${n.title}`);
    if (v.suggestion) console.log(`           Fix: ${String(v.suggestion).split('\n')[0].slice(0, 140)}`);
  }
  if (review.se?.smells?.length) {
    console.log('\nSE smells: ' + review.se.smells.slice(0, 8).map((s) => `${s.title} ×${s.count}`).join(' · '));
  }
  console.log(review.se?.summary || '');
}

function printReview(review, args) {
  console.log(`\nAxofy Code Review — ${review.summary.title}`);
  console.log(review.summary.text);
  console.log(`Effort ${review.effort}/5 · Risk ${review.risk} · LLM mode: ${review.llmMode}${review.cacheHit ? ' (cached)' : ''} · Provider: ${review.provider?.name || '?'}/${review.provider?.model || '?'} (Axofy cost $0)`);
  if (review.slop && review.slop.verdict !== 'ok') console.log(`Slop: ${review.slop.verdict} (score ${review.slop.score}) — ${review.slop.signals.join('; ')}`);
  if (args.lineByLine || review.lineByLine) printLineVerdicts(review);
  const all = [...review.findings, ...review.groupedFindings];
  if (!all.length && !review.lineByLine?.length) console.log('\nNo findings. Ship it.');
  if (!args.lineByLine) {
    for (const f of all) {
      console.log(`\n[${f.severity.toUpperCase()} · ${f.category}] ${f.file}:${f.line} — ${f.title}`);
      console.log('  ' + f.explanation);
      if (f.evidence) console.log('  Evidence: ' + f.evidence);
      if (f.suggestedFix) console.log('  Fix: ' + String(f.suggestedFix).split('\n')[0]);
    }
  }
}

function gitDiff(base) {
  try {
    return execFileSync('git', ['diff', base + '...HEAD'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  } catch {
    return execFileSync('git', ['diff'], { encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.cmd !== 'review') {
    console.log('Usage: axoreview review [--base main] [--profile chill|quiet|assertive] [--file path/to.diff] [--line-by-line] [--se|--no-se] [--depth quick|standard|deep] [--url http://localhost:3000]');
    console.log('  --line-by-line  every changed line gets its own verdict (default mode for agents)');
    console.log('  --se / --no-se  software-engineering checks on every line (SOLID, DRY, KISS, naming, complexity, API compat, migrations, OWASP, perf, concurrency, error handling) — on by default');
    console.log('  No server running? The review runs locally instead (deterministic checks + SE, $0, no key).');
    process.exit(args.help ? 0 : 1);
  }
  const diff = args.file ? fs.readFileSync(args.file, 'utf8') : gitDiff(args.base);
  if (!diff.trim()) { console.log('No diff found — nothing to review.'); process.exit(0); }
  const endpoint = args.lineByLine ? '/api/review-line-by-line' : '/api/review-diff';
  try {
    const res = await fetch(args.url + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ diff, profile: args.profile, depth: args.depth, se: args.se }),
    });
    if (!res.ok) throw new Error('server error ' + res.status + ': ' + (await res.text()).slice(0, 200));
    printReview(await res.json(), args);
  } catch (e) {
    // No server? Run the review locally — same engine, same verdicts.
    // (Only for connection failures / server errors; a bad diff still fails.)
    if (!/fetch failed|ECONNREFUSED|server error/.test(e.message)) throw e;
    console.error(`(No Axofy Code Review server at ${args.url} — running locally instead.)`);
    const { reviewLineByLine } = require('../lib/line-by-line');
    const review = await reviewLineByLine(diff, { profile: args.profile, depth: args.depth, seEnabled: args.se });
    printReview(review, args);
  }
}

main().catch((e) => { console.error('axoreview failed:', e.message); process.exit(1); });
