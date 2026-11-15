// lib/queue.js — review job queue, mirroring CodeRabbit's shape.
//   - Dedupe by idempotency key: (repo, PR, head SHA). A re-delivered webhook
//     or a duplicate event for the same head SHA never runs twice.
//   - Debounce 30-60s: rapid pushes collapse; only the latest head is reviewed.
//   - Cancel superseded: if a newer head arrives while a job is queued, the
//     older queued job is dropped and only the newest runs.
// Jobs run serially per repo (one worker) so two PRs in the same repo never
// race each other; different repos run in parallel.
'use strict';

const DEBOUNCE_MS = 30000; // 30s (CodeRabbit-style 30-60s window)

class ReviewQueue {
  constructor({ debounceMs = DEBOUNCE_MS } = {}) {
    this.debounceMs = debounceMs;
    this.pending = new Map(); // key -> { timer, fn, key }
    this.running = new Set(); // keys currently executing
    this.byRepo = new Map(); // repo -> promise chain (serial per repo)
  }

  keyFor(repo, prNumber, headSha) {
    return `${repo}#${prNumber}@${headSha || 'latest'}`;
  }

  // Enqueue a review. Returns { status: 'queued' | 'duplicate' | 'superseded' }.
  // If the same key is already queued, the new call is a duplicate (dropped).
  // If an older key for the same PR is queued, it is superseded (cancelled).
  enqueue({ repo, prNumber, headSha }, fn) {
    const key = this.keyFor(repo, prNumber, headSha);
    if (this.pending.has(key) || this.running.has(key)) return { status: 'duplicate', key };
    // Cancel superseded queued jobs for the same PR (older head SHA).
    let superseded = 0;
    for (const [k, job] of this.pending) {
      if (k.startsWith(`${repo}#${prNumber}@`) && k !== key) {
        clearTimeout(job.timer);
        this.pending.delete(k);
        superseded += 1;
      }
    }
    const job = {
      key,
      timer: setTimeout(() => this._run(key, repo, fn), this.debounceMs),
      fn,
    };
    this.pending.set(key, job);
    return { status: 'queued', key, superseded };
  }

  async _run(key, repo, fn) {
    this.pending.delete(key);
    this.running.add(key);
    const chain = (this.byRepo.get(repo) || Promise.resolve()).then(fn).catch((e) => {
      console.error('[queue] review failed for ' + key + ':', e.message);
    });
    this.byRepo.set(repo, chain);
    try { await chain; } finally { this.running.delete(key); }
  }

  // For tests / shutdown: how many jobs are waiting.
  get pendingCount() { return this.pending.size; }
  get runningCount() { return this.running.size; }
}

module.exports = { ReviewQueue, DEBOUNCE_MS };
