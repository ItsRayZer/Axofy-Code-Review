// LLM provider routing — FREE BY DESIGN. No tiers, no billing, no caps.
// Primary: NVIDIA NIM (free endpoint, model Nemotron 3 Ultra).
// Fallbacks (user picks a free key, app never charges):
//   groq       -> https://api.groq.com/openai/v1 (free tier, e.g. llama-3.3-70b-versatile)
//   openrouter -> https://openrouter.ai/api/v1 (free :free models)
//   gemini     -> https://generativelanguage.googleapis.com/v1beta/openai (AI Studio free tier)
// Configure with env: LLM_PROVIDER, LLM_MODEL, LLM_BASE_URL, LLM_API_KEY.
// Provider-specific keys also work: NVIDIA_API_KEY, GROQ_API_KEY,
// OPENROUTER_API_KEY, GEMINI_API_KEY. Explicit LLM_* vars win.
'use strict';

const { spawn } = require('child_process');
const path = require('path');

const PROVIDERS = {
  nvidia: { baseUrl: 'https://integrate.api.nvidia.com/v1', model: 'nvidia/nemotron-3-ultra-550b-a55b', keyEnv: 'NVIDIA_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile', keyEnv: 'GROQ_API_KEY' },
  openrouter: { baseUrl: 'https://openrouter.ai/api/v1', model: 'meta-llama/llama-3.3-70b-instruct:free', keyEnv: 'OPENROUTER_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: 'gemini-2.0-flash', keyEnv: 'GEMINI_API_KEY' },
  // BYOM local providers — no key, no cloud, $0 to Axofy and $0 to the user.
  ollama: { baseUrl: 'http://localhost:11434/v1', model: 'llama3.1', keyEnv: null, local: true },
  lmstudio: { baseUrl: 'http://localhost:1234/v1', model: 'local-model', keyEnv: null, local: true },
  // BYOM custom OpenAI-compatible endpoint — user supplies baseUrl + model + key.
  custom: { baseUrl: '', model: '', keyEnv: 'LLM_API_KEY', local: false },
};

// Public provider table: cost to Axofy is $0 for every provider — Axofy
// never pays for a model. The user pays only what their own provider
// charges them (free tiers / local models = $0). No key is ever in here.
const PROVIDER_INFO = {
  nvidia: { id: 'nvidia', label: 'NVIDIA NIM (Nemotron 3 Ultra)', axofyCostUsd: 0, userCost: '$0 — free tier (~40 rpm)', keyNeeded: true, local: false, freeTierNote: 'Free NVIDIA NIM tier; bring your own free key.' },
  groq: { id: 'groq', label: 'Groq (free tier)', axofyCostUsd: 0, userCost: '$0 — free tier', keyNeeded: true, local: false, freeTierNote: 'Free Groq tier; bring your own free key.' },
  openrouter: { id: 'openrouter', label: 'OpenRouter :free models', axofyCostUsd: 0, userCost: '$0 — :free models only', keyNeeded: true, local: false, freeTierNote: 'Only :free models are used by default; paid models are never selected.' },
  gemini: { id: 'gemini', label: 'Gemini AI Studio (free tier)', axofyCostUsd: 0, userCost: '$0 — free tier', keyNeeded: true, local: false, freeTierNote: 'Free Gemini AI Studio tier; bring your own free key.' },
  ollama: { id: 'ollama', label: 'Ollama (local)', axofyCostUsd: 0, userCost: '$0 — runs on your own machine', keyNeeded: false, local: true, freeTierNote: 'Local model at http://localhost:11434 — no key, no cloud, no bill.' },
  lmstudio: { id: 'lmstudio', label: 'LM Studio (local)', axofyCostUsd: 0, userCost: '$0 — runs on your own machine', keyNeeded: false, local: true, freeTierNote: 'Local model at http://localhost:1234 — no key, no cloud, no bill.' },
  custom: { id: 'custom', label: 'Custom OpenAI-compatible endpoint', axofyCostUsd: 0, userCost: 'Whatever your endpoint charges you — Axofy adds $0', keyNeeded: true, local: false, freeTierNote: 'You supply base URL + model + key; Axofy never sees a bill for it.' },
};

function listProviders() {
  return Object.values(PROVIDER_INFO).map((p) => ({ ...p }));
}

// byom: optional per-request override {provider, model, baseUrl, apiKey}.
// The apiKey is used for this request only — never logged, never stored,
// never put in a cache key (see pipeline.js, which hashes only name/model/baseUrl).
function resolveProvider(byom) {
  const b = (byom && typeof byom === 'object') ? byom : {};
  const name = String(b.provider || process.env.LLM_PROVIDER || 'nvidia').toLowerCase();
  const def = PROVIDERS[name] || PROVIDERS.nvidia;
  return {
    name: PROVIDERS[name] ? name : 'nvidia',
    baseUrl: b.baseUrl || process.env.LLM_BASE_URL || def.baseUrl,
    model: b.model || process.env.LLM_MODEL || def.model,
    key: b.apiKey || process.env.LLM_API_KEY || (def.keyEnv ? process.env[def.keyEnv] : null) || null,
    local: Boolean(def.local),
  };
}

// Descriptor safe for cache keys / logs / responses: provider+model+baseUrl only, never the key.
function providerDescriptor(byom) {
  const p = resolveProvider(byom);
  return { name: p.name, model: p.model, baseUrl: p.baseUrl, local: p.local };
}

function llmMode(byom) {
  if (process.env.AXOREVIEW_LLM === 'mock') return 'mock';
  const p = resolveProvider(byom);
  if (p.local) return 'direct'; // local models need no key
  if (p.key) return 'direct';
  if (p.name === 'nvidia' && !byom) return 'vault'; // vault helper attaches the registered key
  return 'mock'; // other providers need their own free key; no key = mock, never fake
}

// Test a BYOM config without storing anything. Cloud providers with no key
// fail fast with 'key needed' (no network call). Local providers are probed
// via GET {baseUrl}/models. Returns {ok, provider, model, reason?}.
async function testProvider(byom) {
  const p = resolveProvider(byom);
  const info = PROVIDER_INFO[p.name];
  if (!p.baseUrl) return { ok: false, provider: p.name, model: p.model, reason: 'base URL is required for the custom provider' };
  if (!p.local && !p.key) return { ok: false, provider: p.name, model: p.model, reason: 'a free API key is needed for ' + p.name + ' — Axofy never stores it; paste it per request or set it in env' };
  try {
    const headers = { Accept: 'application/json' };
    if (p.key) headers.Authorization = 'Bearer ' + p.key;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    let res;
    try { res = await fetch(p.baseUrl.replace(/\/$/, '') + '/models', { headers, signal: controller.signal }); }
    finally { clearTimeout(timer); }
    if (res.ok) return { ok: true, provider: p.name, model: p.model, local: p.local, note: info ? info.freeTierNote : '' };
    return { ok: false, provider: p.name, model: p.model, reason: p.name + ' returned HTTP ' + res.status + ' — check the model name / base URL / key' };
  } catch (e) {
    return { ok: false, provider: p.name, model: p.model, reason: p.local ? 'cannot reach local model at ' + p.baseUrl + ' — is Ollama / LM Studio running?' : 'cannot reach ' + p.name + ': ' + e.message.slice(0, 120) };
  }
}

const VAULT_SCRIPT = path.join(__dirname, '..', 'scripts', 'nemotron_via_vault.py');

function extractJson(text) {
  if (!text) return null;
  // Prefer a fenced ```json block, else the first {...} spanning the reply.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try { return JSON.parse(candidate.slice(start, end + 1)); } catch { return null; }
}

async function chatDirect(messages, { temperature = 0.1, maxTokens = 4096, byom } = {}) {
  const provider = resolveProvider(byom);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 180000);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provider.key) headers.Authorization = 'Bearer ' + provider.key;
  try {
    const res = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: provider.model, messages, temperature, top_p: 0.95, max_tokens: maxTokens }),
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`${provider.name} HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } finally {
    clearTimeout(timer);
  }
}

function chatViaVault(messages, { temperature = 0.1, maxTokens = 4096 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('python3', [VAULT_SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('LLM vault helper timed out after 180s')); }, 180000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error('LLM vault helper exited ' + code + ': ' + err.slice(0, 300)));
      try {
        const parsed = JSON.parse(out);
        if (parsed.error) return reject(new Error('LLM error: ' + String(parsed.error).slice(0, 300)));
        resolve(parsed.content || '');
      } catch (e) {
        reject(new Error('Could not parse LLM vault helper output: ' + e.message));
      }
    });
    child.stdin.write(JSON.stringify({ messages, temperature, max_tokens: maxTokens }));
    child.stdin.end();
  });
}

// Returns { content, mode, provider }. Mode is 'direct' | 'vault' | 'mock'.
// In mock mode content is '' — callers must not invent findings from it.
// opts.byom is a per-request BYOM override; its apiKey is never returned.
async function chat(messages, opts = {}) {
  const mode = llmMode(opts.byom);
  if (mode === 'mock') return { content: '', mode, provider: providerDescriptor(opts.byom) };
  if (mode === 'direct') return { content: await chatDirect(messages, opts), mode, provider: providerDescriptor(opts.byom) };
  return { content: await chatViaVault(messages, opts), mode, provider: providerDescriptor(opts.byom) };
}

module.exports = { chat, chatDirect, chatViaVault, extractJson, llmMode, resolveProvider, providerDescriptor, listProviders, testProvider, PROVIDERS, PROVIDER_INFO };
