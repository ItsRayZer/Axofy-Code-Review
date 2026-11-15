// lib/repro.js — Steps of Reproduction for each finding (CodeAnt-style).
// Deterministic templates for known bug classes; the LLM may fill in a
// richer repro when it has one, but a finding never ships without this
// field — in mock mode the template is the repro. Never invented: every
// step cites the file:line and the exact evidence line.
'use strict';

function buildRepro(f) {
  const file = f.file || 'unknown file';
  const line = f.line || 0;
  const ev = String(f.evidence || f.title || '').trim().slice(0, 200);
  const src = String(f.source || '');
  const title = String(f.title || '').toLowerCase();
  const fix = String(f.suggestedFix || f.explanation || '').trim().slice(0, 200);
  const base = {
    inputs: 'The changed code at ' + file + ':' + line,
    executionPath: file + ':' + line + ' — ' + ev,
    expected: fix ? ('Fixed behaviour: ' + fix) : 'The code behaves as its surrounding code expects.',
    actual: String(f.explanation || f.title || '').slice(0, 300),
  };
  if (src.includes('sql') || title.includes('sql injection')) {
    return { inputs: 'An attacker-controlled id, e.g. `1 OR 1=1` (or any value from req.query / request input) passed as the lookup id.', executionPath: '1. Caller supplies the id (untrusted input).\n2. ' + file + ':' + line + ' concatenates it into the SQL string: `' + ev + '`\n3. The database executes the concatenated string as SQL.', expected: 'The query uses a parameterised / prepared statement with placeholders, so the input is data, never SQL.', actual: 'The input is concatenated into the SQL string, so injected SQL runs as code.' };
  }
  if (title.includes('eval') || src.includes('eval')) {
    return { inputs: 'An attacker-controlled string, e.g. `term = "1); maliciousCode();//"` passed to the function at ' + file + ':' + line + '.', executionPath: '1. Caller supplies the string (untrusted input).\n2. ' + file + ':' + line + ': `' + ev + '`\n3. eval() executes the string as code with server privileges.', expected: 'Data is parsed (JSON.parse / a safe expression parser), never executed as code.', actual: 'The supplied string is executed as code.' };
  }
  if (title.includes('off-by-one') || src.includes('off-by-one')) {
    return { inputs: 'An array with N items (e.g. scores of length 3).', executionPath: '1. Loop at ' + file + ':' + line + ': `' + ev + '`\n2. The loop runs one step past the last valid index (i = N).\n3. scores[N] is undefined and the total becomes NaN.', expected: 'The loop stops at the last valid index (i < length) and the total is correct.', actual: 'The loop reads one past the end; the result is undefined / NaN.' };
  }
  if (title.includes('secret') || title.includes('hardcoded') || src.includes('secret')) {
    return { inputs: 'No input — the secret is already in the committed code at ' + file + ':' + line + '.', executionPath: '1. The secret is committed in source: `' + ev + '`\n2. Anyone with repo access (or a leaked clone) can read and use it.', expected: 'The secret lives in an environment variable / secrets manager and is never committed.', actual: 'The secret is hardcoded in the code and leaks with the repo.' };
  }
  if (title.includes('delete without where') || title.includes('drop table')) {
    return { inputs: 'Running the migration / query at ' + file + ':' + line + ' against a real database.', executionPath: '1. Execute: `' + ev + '`\n2. The statement applies to every row / the whole table.', expected: 'The statement is scoped (WHERE clause / staged migration with backup) so only intended rows are affected.', actual: 'Every row is deleted / the table is dropped with no rollback.' };
  }
  return base;
}

module.exports = { buildRepro };
