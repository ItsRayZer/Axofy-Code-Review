// lib/custom-rules.js — plain-English custom rules (CodeAnt-style).
// A rule is a plain-English string from `custom_rules` in .axoreview.yaml
// (or the UI editor). Deterministic matching: keyword overlap (words >3
// chars) against file path + finding title/explanation/evidence, plus
// /regex/ rules. Matched rules become their own findings AND are injected
// into the LLM prompt, so the model enforces them too. A rule that matches
// nothing is reported as unmatched — never silently dropped, never faked.
'use strict';

function ruleKeywords(rule) {
  return String(rule || '').toLowerCase().split(/[^a-z0-9_]+/)?.filter((w) => w.length > 3);
}

function matchCustomRules(files, findings, rules) {
  const list = (rules || [])?.filter((r) => typeof r === 'string' && r.trim());
  if (!list.length) return { findings: [], unmatched: [] };
  const out = [];
  const unmatched = [];
  const haystacks = (findings || []).map((f) => ({
    f,
    text: ((f.file || '') + ' ' + (f.title || '') + ' ' + (f.explanation || '') + ' ' + (f.evidence || '')).toLowerCase(),
  }));
  const fileText = (files || []).map((x) => x.path).join(' ').toLowerCase();
  for (const rule of list) {
    const trimmed = rule.trim();
    let matched = null;
    const reMatch = trimmed.match(/^\/(.+)\/([a-z]*)$/);
    if (reMatch) {
      try {
        const re = new RegExp(reMatch[1], reMatch[2] || 'i');
        matched = haystacks.find((h) => re.test(h.text))?.f || (re.test(fileText) ? { file: (files[0] || {}).path || '', line: 1 } : null);
      } catch { matched = null; }
    } else {
      const kws = ruleKeywords(trimmed);
      const hit = haystacks.find((h) => kws.length && kws.some((k) => h.text.includes(k)));
      matched = hit ? hit.f : null;
      // A rule about a file area (e.g. "never use console.log in scripts/")
      // also matches when its keywords appear in a changed file path.
      if (!matched && kws.some((k) => fileText.includes(k))) {
        matched = { file: (files.find((x) => kws.some((k) => x.path.toLowerCase().includes(k))) || {}).path || '', line: 1 };
      }
    }
    if (matched) {
      out.push({
        source: 'custom-rule', file: matched.file || (files[0] || {}).path || '', line: matched.line || 1,
        position: 1, severity: 'minor', category: 'style',
        title: 'Custom rule: ' + trimmed.slice(0, 120),
        explanation: 'This change conflicts with a plain-English team rule: "' + trimmed + '". Matched on: ' + (matched.title || matched.file || 'changed files') + '.',
        suggestedFix: 'Follow the team rule above, or update the rule in .axoreview.yaml if it no longer applies.',
        confidence: 0.7, evidence: matched.evidence || matched.file || '',
      });
    } else unmatched.push(trimmed);
  }
  return { findings: out, unmatched };
}

function customRulesPrompt(rules) {
  const list = (rules || [])?.filter((r) => typeof r === 'string' && r.trim());
  if (!list.length) return '';
  return 'Team custom rules (plain English — enforce them like review rules, cite the rule in the finding title):\n- ' + list.join('\n- ');
}

module.exports = { matchCustomRules, customRulesPrompt, ruleKeywords };
