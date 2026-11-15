// scripts/test-mcp.js — MCP server smoke test (real stdio JSON-RPC).
// Spawns `node mcp-server.js`, does the MCP handshake, lists tools, and
// calls review_diff on the sample diff. Mock LLM mode (no key, no network).
// Exit 0 = all pass.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const diff = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'sample-pr.diff'), 'utf8');

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log('  PASS ' + name); }
  else { failed += 1; console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function run() {
  return new Promise((resolve) => {
    const child = spawn('node', [path.join(__dirname, '..', 'mcp-server.js')], {
      env: { ...process.env, AXOREVIEW_LLM: 'mock' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let buf = '';
    const pending = new Map();
    let nextId = 1;
    const send = (msg) => { child.stdin.write(JSON.stringify(msg) + '\n'); };
    const call = (method, params) => new Promise((res, rej) => {
      const id = nextId++;
      pending.set(id, { res, rej });
      send({ jsonrpc: '2.0', id, method, params });
      setTimeout(() => { if (pending.has(id)) { pending.delete(id); rej(new Error('timeout waiting for ' + method)); } }, 30000);
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buf += chunk;
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== undefined && pending.has(msg.id)) {
          const { res, rej } = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) rej(new Error(msg.error.message || 'MCP error'));
          else res(msg.result);
        }
      }
    });
    child.stderr.on('data', () => { /* server logs go to stderr, ignore */ });
    (async () => {
      try {
        const init = await call('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'axoreview-test', version: '1.0.0' } });
        check('MCP handshake: initialize returns axoreview server', init?.serverInfo?.name === 'axoreview', JSON.stringify(init?.serverInfo));
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        const list = await call('tools/list', {});
        const names = (list.tools || []).map((t) => t.name);
        check('MCP tools/list exposes 8 tools', names.length === 8, names.join(','));
        for (const want of ['review_diff', 'review_file', 'review_pr', 'line_by_line', 'explain', 'autofix', 'gates', 'providers']) {
          check('MCP tool present: ' + want, names.includes(want));
        }
        const prov = await call('tools/call', { name: 'providers', arguments: {} });
        const provText = JSON.parse(prov.content[0].text);
        check('MCP providers tool: 7 providers, Axofy $0', provText.providers?.length === 7 && provText.axofyCostUsd === 0, JSON.stringify(provText).slice(0, 120));
        const rev = await call('tools/call', { name: 'review_diff', arguments: { diff, depth: 'standard' } });
        const out = JSON.parse(rev.content[0].text);
        check('MCP review_diff: finds planted SQL injection', (out.findings || []).some((f) => f.source === 'check:sql-injection') || (out.lineByLine || []).some((v) => v.findings.some((f) => f.source === 'check:sql-injection')), '');
        check('MCP review_diff: line-by-line verdicts for every changed line', Array.isArray(out.lineByLine) && out.lineByLine.length > 0 && out.lineByLine.every((v) => v.verdict), 'lines=' + (out.lineByLine || []).length);
        check('MCP review_diff: SE summary with score 0-100', out.se && typeof out.se.score === 'number' && out.se.score >= 0 && out.se.score <= 100, JSON.stringify(out.se || null).slice(0, 120));
        const lbl = await call('tools/call', { name: 'line_by_line', arguments: { diff } });
        const lblOut = JSON.parse(lbl.content[0].text);
        const sqliLine = (lblOut.lineByLine || []).find((v) => v.file === 'src/users.js' && v.line === 15);
        check('MCP line_by_line: SQLi line verdict is critical', sqliLine && sqliLine.verdict === 'critical', JSON.stringify(sqliLine || null).slice(0, 200));
        const gates = await call('tools/call', { name: 'gates', arguments: { findings: [{ severity: 'critical', file: 'a.js', line: 1, title: 'x', source: 'check:x' }] } });
        check('MCP gates tool: critical finding fails the gate', JSON.parse(gates.content[0].text).pass === false, '');
        try {
          await call('tools/call', { name: 'no_such_tool', arguments: {} });
          check('MCP unknown tool returns an error', false, 'no error thrown');
        } catch { check('MCP unknown tool returns an error', true); }
      } catch (e) {
        check('MCP test completed without crashing', false, e.message);
      } finally {
        child.kill();
        resolve();
      }
    })();
  });
}

(async () => {
  console.log('Axofy Code Review MCP tests (mock LLM mode)');
  await run();
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
