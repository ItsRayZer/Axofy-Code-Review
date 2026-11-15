// lib/jobs.js — async review jobs (pollable, no new serverless function).
// POST /api/review-jobs returns 202 + jobId immediately; the review runs in
// the background and GET /api/review-jobs/:id polls for the result.
// Honest limit: this works fully on a long-running server (local, desktop,
// self-host). On Vercel serverless the function may freeze after the 202
// response, so jobs there are best-effort — small diffs should use the sync
// /api/review-diff endpoint, large PRs should use the CLI, desktop app, or a
// self-hosted server. A per-request BYOM key (body.byom.apiKey) is held only
// in memory inside the job closure until the run finishes — never written to
// disk, never logged, never put in a cache key.
'use strict';

const crypto = require('crypto');

const MAX_JOBS = 50;

class JobStore {
  constructor() {
    this.jobs = new Map(); // id -> { id, status, createdAt, result, error }
  }

  // Start a job. runFn is called async; returns the job immediately.
  create(runFn) {
    if (this.jobs.size >= MAX_JOBS) {
      // Prune the oldest finished job to make room; never drop a live one.
      for (const [k, j] of this.jobs) {
        if (j.status === 'done' || j.status === 'error') { this.jobs.delete(k); break; }
      }
    }
    const id = crypto.randomBytes(8).toString('hex');
    const job = { id, status: 'queued', createdAt: new Date().toISOString(), result: null, error: null };
    this.jobs.set(id, job);
    setImmediate(async () => {
      job.status = 'running';
      try {
        job.result = await runFn();
        job.status = 'done';
      } catch (e) {
        job.error = e && e.message ? e.message : String(e);
        job.status = 'error';
      }
    });
    return job;
  }

  get(id) {
    return this.jobs.get(id) || null;
  }

  // Public view: the result is only included once the job is done.
  publicView(job) {
    return {
      id: job.id,
      status: job.status,
      createdAt: job.createdAt,
      result: job.status === 'done' ? job.result : null,
      error: job.error,
    };
  }
}

module.exports = { JobStore, MAX_JOBS };
