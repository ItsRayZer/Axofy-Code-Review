// api/index.js — single Vercel serverless entry point for Axofy Code Review.
// One function only (Vercel Hobby caps 12; Axofy Code Review uses 1). All routes
// live in server.js; this file just wraps the same request handler.
// Deploy: vercel --prod (set env vars in the Vercel dashboard; never commit keys).
// Note: GitHub webhooks need the raw body for HMAC verification — Vercel
// passes the request stream through, and server.js reads it raw.
'use strict';

const { handleRequest } = require('../server');

module.exports = (req, res) => handleRequest(req, res);
