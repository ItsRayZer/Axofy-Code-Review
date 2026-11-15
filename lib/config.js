// lib/config.js — .axoreview.yaml (small subset, no YAML dependency).
// Supports: profile (quiet|chill|assertive), language, tone,
// reviews.path_filters (globs, ! = exclude), reviews.path_instructions
// (glob -> text), reviews.tools.<name>.enabled, reviews.pre_merge_checks
// (list of {name, prompt, severity}), learnings.enabled.
// Anything unparsable falls back to defaults; never throws on bad config.
'use strict';

const DEFAULTS = {
  profile: 'chill',
  language: 'en-US',
  tone: 'neutral',
  pathFilters: [],
  pathInstructions: [],
  tools: {},
  preMergeChecks: [],
  learningsEnabled: true,
  depth: 'standard', // quick | standard | deep — see lib/review-methods.js
  maxContextChars: 24000, // token budget cap: truncate context beyond this
  cacheEnabled: true, // 7-day response cache (hash of diff+config+profile)
  // Quality gates (CodeAnt-style, free): block merge on critical/secrets.
  qualityGates: { blockOnCritical: true, blockOnSecrets: true, blockOnHigh: false, maxMajor: null, requireTests: false },
  // SE mode (agent-first line-by-line): reviews.se false disables the
  // deterministic SE notes on each line verdict. Default on.
  seEnabled: true,
  chatAutoReply: true,
  summaryEnabled: true,
  walkthroughEnabled: true,
  labelsEnabled: true,
  reviewersEnabled: true,
  autoApprovals: { enabled: false },
  kbFilePatterns: [],
};

function globToRegExp(glob) {
  // ** -> .*, * -> [^/]*, ? -> [^/]; escape the rest.
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i += 1; if (glob[i + 1] === '/') i += 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

function matchGlob(glob, path) {
  try { return globToRegExp(glob).test(path); } catch { return false; }
}

// Is this file reviewed, given path_filters? Empty filter list = all files.
// A matching `!` exclusion wins over an inclusion.
function fileAllowed(path, filters) {
  if (!filters || filters.length === 0) return true;
  let allowed = false;
  for (const f of filters) {
    if (f.startsWith('!')) { if (matchGlob(f.slice(1), path)) return false; }
    else if (matchGlob(f, path)) allowed = true;
  }
  return allowed;
}

function instructionsFor(path, pathInstructions) {
  return (pathInstructions || [])
    .filter((pi) => matchGlob(pi.glob, path))
    .map((pi) => pi.text);
}



// Minimal indentation-based YAML parser (no dependency). Handles nested
// maps, lists of scalars, lists of maps, inline [a, b] lists, quoted
// strings, booleans and numbers. Returns {} on any parse problem — a bad
// config file must never break a review.
function parseYamlSubset(text) {
  const rawLines = String(text || '').split('\n');
  const lines = [];
  for (const raw of rawLines) {
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const stripped = raw.replace(/\s+#.*$/, '');
    if (!stripped.trim()) continue;
    lines.push({ indent: stripped.match(/^ */)[0].length, text: stripped.trim() });
  }
  if (lines.length === 0) return {};
  try {
    const parsed = parseNode(lines, 0, lines[0].indent);
    const v = parsed.value;
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function parseNode(lines, i, indent) {
  if (i >= lines.length || lines[i].indent < indent) return { value: {}, next: i };
  if (lines[i].text === '-' || lines[i].text.startsWith('- ')) return parseList(lines, i, indent);
  return parseMap(lines, i, indent);
}

function parseMap(lines, i, indent) {
  const obj = {};
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent || line.indent > indent) break;
    if (line.text === '-' || line.text.startsWith('- ')) break;
    const m = line.text.match(/^([\w-]+):\s*(.*)$/);
    if (!m) { i += 1; continue; }
    const key = m[1];
    const val = m[2].trim();
    i += 1;
    if (val) { obj[key] = parseScalarOrInlineList(val); continue; }
    if (i < lines.length && lines[i].indent > indent) {
      const nested = parseNode(lines, i, lines[i].indent);
      obj[key] = nested.value;
      i = nested.next;
    } else {
      obj[key] = {};
    }
  }
  return { value: obj, next: i };
}

function parseList(lines, i, indent) {
  const items = [];
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < indent || line.indent > indent) break;
    if (!(line.text === '-' || line.text.startsWith('- '))) break;
    const rest = line.text === '-' ? '' : line.text.slice(2).trim();
    const itemIndent = line.indent + 2;
    i += 1;
    if (!rest) {
      if (i < lines.length && lines[i].indent > indent) {
        const nested = parseNode(lines, i, lines[i].indent);
        items.push(nested.value);
        i = nested.next;
      } else items.push(null);
      continue;
    }
    const m = rest.match(/^([\w-]+):\s*(.*)$/);
    if (!m) { items.push(parseScalarOrInlineList(rest)); continue; }
    const item = {};
    item[m[1]] = m[2].trim() ? parseScalarOrInlineList(m[2].trim()) : {};
    while (i < lines.length && lines[i].indent >= itemIndent && !(lines[i].text === '-' || lines[i].text.startsWith('- '))) {
      if (lines[i].indent < itemIndent) break;
      const km = lines[i].text.match(/^([\w-]+):\s*(.*)$/);
      if (!km) { i += 1; continue; }
      const kv = km[2].trim();
      const keyIndent = lines[i].indent;
      i += 1;
      if (kv) item[km[1]] = parseScalarOrInlineList(kv);
      else if (i < lines.length && lines[i].indent > keyIndent) {
        const nested = parseNode(lines, i, lines[i].indent);
        item[km[1]] = nested.value;
        i = nested.next;
      } else item[km[1]] = {};
    }
    items.push(item);
  }
  return { value: items, next: i };
}

function parseScalarOrInlineList(v) {
  const s = String(v).trim();
  if (s.startsWith('[') && s.endsWith(']')) {
    const inner = s.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((x) => parseScalar(x.trim()));
  }
  return parseScalar(s);
}

function parseScalar(v) {
  const s = String(v).trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1);
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  return s;
}

function loadConfig(yamlText) {
  const cfg = { ...DEFAULTS };
  if (!yamlText || !yamlText.trim()) return cfg;
  let raw;
  try { raw = parseYamlSubset(yamlText); } catch { return cfg; }

  if (typeof raw.profile === 'string' && ['quiet', 'chill', 'assertive'].includes(raw.profile)) cfg.profile = raw.profile;
  if (typeof raw.depth === 'string' && ['quick', 'standard', 'deep'].includes(raw.depth)) cfg.depth = raw.depth;
  if (typeof raw.language === 'string') cfg.language = raw.language;
  if (typeof raw.tone === 'string') cfg.tone = raw.tone;

  // general: { language, tone, early_access } — same as .coderabbit.yaml.
  const general = (raw.general && typeof raw.general === 'object') ? raw.general : {};
  if (typeof general.language === 'string') cfg.language = general.language;
  if (typeof general.tone === 'string') cfg.tone = general.tone;
  // chat: { auto_reply } — same as .coderabbit.yaml.
  const chatCfg = (raw.chat && typeof raw.chat === 'object') ? raw.chat : {};
  if (chatCfg.auto_reply === false) cfg.chatAutoReply = false;

  const reviews = (raw.reviews && typeof raw.reviews === 'object') ? raw.reviews : {};
  if (typeof reviews.profile === 'string' && ['quiet', 'chill', 'assertive'].includes(reviews.profile)) cfg.profile = reviews.profile;
  if (typeof reviews.depth === 'string' && ['quick', 'standard', 'deep'].includes(reviews.depth)) cfg.depth = reviews.depth;
  if (reviews.summary === false) cfg.summaryEnabled = false;
  if (typeof reviews.se === 'boolean') cfg.seEnabled = reviews.se;
  if (typeof raw.se === 'boolean') cfg.seEnabled = raw.se;
  if (reviews.walkthrough === false) cfg.walkthroughEnabled = false;
  if (reviews.labels === false) cfg.labelsEnabled = false;
  if (reviews.reviewers === false) cfg.reviewersEnabled = false;
  if (reviews.auto_approvals && typeof reviews.auto_approvals === 'object') {
    cfg.autoApprovals = { enabled: reviews.auto_approvals.enabled === true, ...(reviews.auto_approvals || {}) };
  }
  // path_filters may be an inline list or a block list — our subset parser
  // returns block lists as arrays of strings when written with "- ".
  if (Array.isArray(reviews.path_filters)) cfg.pathFilters = reviews.path_filters.filter((x) => typeof x === 'string');
  if (Array.isArray(reviews.path_instructions)) {
    cfg.pathInstructions = reviews.path_instructions
      .filter((x) => x && typeof x === 'object' && x.glob)
      .map((x) => ({ glob: String(x.glob), text: String(x.text || x.instructions || '') }));
  }
  if (reviews.tools && typeof reviews.tools === 'object') {
    for (const [name, t] of Object.entries(reviews.tools)) {
      cfg.tools[name] = { enabled: !(t && typeof t === 'object' && t.enabled === false) };
    }
  }
  if (Array.isArray(reviews.pre_merge_checks)) {
    cfg.preMergeChecks = reviews.pre_merge_checks
      .filter((c) => c && typeof c === 'object' && c.prompt)
      .map((c) => ({ name: String(c.name || 'check'), prompt: String(c.prompt), severity: String(c.severity || 'warning') }));
  }
  const kb = (raw.knowledge_base && typeof raw.knowledge_base === 'object') ? raw.knowledge_base : {};
  if (kb.opt_out === true) cfg.learningsEnabled = false;
  if (kb.code_guidelines && Array.isArray(kb.code_guidelines.filePatterns)) cfg.kbFilePatterns = kb.code_guidelines.filePatterns.filter((x) => typeof x === 'string');
  if (typeof reviews.token_budget_chars === 'number' && reviews.token_budget_chars > 0) cfg.maxContextChars = reviews.token_budget_chars;
  if (reviews.cache_enabled === false) cfg.cacheEnabled = false;
  // Quality gates: reviews.quality_gates (snake_case in YAML).
  const qg = (reviews.quality_gates && typeof reviews.quality_gates === 'object') ? reviews.quality_gates : {};
  if (qg.block_on_critical === false) cfg.qualityGates.blockOnCritical = false;
  if (qg.block_on_secrets === false) cfg.qualityGates.blockOnSecrets = false;
  if (qg.block_on_high === true) cfg.qualityGates.blockOnHigh = true;
  if (typeof qg.max_major === 'number') cfg.qualityGates.maxMajor = qg.max_major;
  if (qg.require_tests === true) cfg.qualityGates.requireTests = true;
  // Plain-English custom rules: reviews.custom_rules (list of strings).
  if (Array.isArray(reviews.custom_rules)) cfg.customRules = reviews.custom_rules.filter((x) => typeof x === 'string');
  if (Array.isArray(raw.custom_rules)) cfg.customRules = raw.custom_rules.filter((x) => typeof x === 'string');
  return cfg;
}

module.exports = { DEFAULTS, loadConfig, fileAllowed, matchGlob, instructionsFor, parseYamlSubset };
