// lib/checks.js — deterministic checks (no LLM). Runs over added lines only,
// so it never flags pre-existing code. Findings use the same shape as the
// LLM pipeline so they merge and dedupe cleanly.
// Categories: security / bug / style / performance. Severities mirror CodeRabbit.
//
// Language-aware: every file is dispatched by extension to a language id
// (see LANGUAGES). Global rules run on all files; LANG_RULES run only on
// their languages. Every rule is evidence-based: it fires on the exact
// added line and cites it.
'use strict';

const EXT_TO_LANG = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  py: 'python', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', kts: 'kotlin',
  php: 'php', rb: 'ruby', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
  swift: 'swift', cs: 'csharp', sql: 'sql', sh: 'shell', bash: 'shell', zsh: 'shell',
  html: 'html', htm: 'html', css: 'css', scss: 'css',
  yml: 'config', yaml: 'config', json: 'config', toml: 'config',
  tf: 'terraform', tfvars: 'terraform',
};

const LANGUAGES = {
  javascript: { name: 'JavaScript', exts: ['js', 'mjs', 'cjs', 'jsx'] },
  typescript: { name: 'TypeScript', exts: ['ts', 'tsx', 'mts', 'cts'] },
  python: { name: 'Python', exts: ['py'] },
  go: { name: 'Go', exts: ['go'] },
  rust: { name: 'Rust', exts: ['rs'] },
  java: { name: 'Java', exts: ['java'] },
  kotlin: { name: 'Kotlin', exts: ['kt', 'kts'] },
  php: { name: 'PHP', exts: ['php'] },
  ruby: { name: 'Ruby', exts: ['rb'] },
  c: { name: 'C', exts: ['c', 'h'] },
  cpp: { name: 'C++', exts: ['cpp', 'cc', 'cxx', 'hpp'] },
  swift: { name: 'Swift', exts: ['swift'] },
  csharp: { name: 'C#', exts: ['cs'] },
  sql: { name: 'SQL', exts: ['sql'] },
  shell: { name: 'Shell', exts: ['sh', 'bash', 'zsh'] },
  html: { name: 'HTML', exts: ['html', 'htm'] },
  css: { name: 'CSS', exts: ['css', 'scss'] },
  config: { name: 'YAML/JSON/TOML', exts: ['yml', 'yaml', 'json', 'toml'] },
  terraform: { name: 'Terraform', exts: ['tf', 'tfvars'] },
  dockerfile: { name: 'Dockerfile', exts: [] },
};

function detectLanguage(filePath) {
  const base = String(filePath || '').split('/').pop();
  if (/^Dockerfile(\.|$)/i.test(base) || base.toLowerCase().endsWith('.dockerfile')) return 'dockerfile';
  if (/^Jenkinsfile$/.test(base)) return 'groovy';
  const ext = base.includes('.') ? base.split('.').pop().toLowerCase() : '';
  return EXT_TO_LANG[ext] || 'unknown';
}

// Global rules — run on every language.
const RULES = [
  { id: 'secret-aws-key', category: 'security', severity: 'critical', title: 'Possible AWS access key in code',
    re: /\bAKIA[0-9A-Z]{16}\b/, explanation: 'A hardcoded AWS access key was found. Keys in source control must be revoked and moved to a secrets manager.', fix: 'Remove the key, revoke it in AWS, and load it from an environment variable or secrets manager.' },
  { id: 'secret-github-token', category: 'security', severity: 'critical', title: 'Possible GitHub token in code',
    re: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/, explanation: 'A GitHub token pattern was found in added code. Tokens must never be committed.', fix: 'Remove the token, revoke it on GitHub, and read it from an environment variable.' },
  { id: 'secret-assignment', category: 'security', severity: 'major', title: 'Possible hardcoded secret',
    re: /\b(api[_-]?key|password|passwd|secret|private[_-]?key)\s*[:=]\s*['"][^'"]{8,}['"]/i, explanation: 'A credential-looking value is assigned inline. Hardcoded secrets leak when code is shared.', fix: 'Move the value to an environment variable or secrets manager and never commit the real value.' },
  { id: 'secret-unquoted', category: 'security', severity: 'major', title: 'Possible hardcoded secret (unquoted value)',
    re: /\b(api[_-]?key|password|passwd|secret)\s*[:=]\s*[^\s'"{}\[\]][^\s]{7,}/i, langs: ['config', 'terraform', 'dockerfile', 'yaml'],
    explanation: 'A credential-looking key is assigned an unquoted literal value in a config file. Secrets in config leak the same way as secrets in code.', fix: 'Move the value to an environment variable or a secrets manager and reference it instead.' },
  { id: 'todo-fixme', category: 'style', severity: 'nitpick', title: 'TODO / FIXME left in new code',
    re: /\b(TODO|FIXME|XXX|HACK)\b[:\s]/, explanation: 'Unfinished work is being merged. Track it in an issue or finish it before merging.', fix: 'Resolve the TODO/FIXME, or link it to a tracked issue.' },
];

// Per-language rules. `langs` = language ids from detectLanguage().
// Each rule needs a real sink on the line — no guessing from a bare word.
const LANG_RULES = [
  // ---- SQL injection (string-built queries) ----
  { id: 'sql-injection', category: 'security', severity: 'critical', title: 'Possible SQL injection — query built by string concatenation',
    langs: ['javascript', 'typescript', 'python', 'go', 'java', 'kotlin', 'php', 'ruby', 'csharp', 'swift', 'rust'],
    re: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\+\s*[A-Za-z_$][\w$]*\s*\+/i,
    explanation: 'A SQL query is built by concatenating user input. An attacker can inject SQL and read, change or delete data.', fix: 'Use a parameterised query / prepared statement with placeholders instead of string concatenation.' },
  { id: 'sql-template-injection', category: 'security', severity: 'critical', title: 'Possible SQL injection — user input interpolated into a query',
    langs: ['javascript', 'typescript'],
    re: /`[^`]*\b(SELECT|INSERT|UPDATE|DELETE)\b[^`]*\$\{/i,
    explanation: 'User input is interpolated directly into a SQL template string. This is injectable.', fix: 'Use a parameterised query / prepared statement with placeholders instead of interpolation.' },
  { id: 'sql-fstring-injection', category: 'security', severity: 'critical', title: 'Possible SQL injection — f-string query with interpolated input',
    langs: ['python'],
    re: /f["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*\{[^}]*\}/i,
    explanation: 'A SQL query is built with an f-string that interpolates a variable. An attacker can inject SQL through that value.', fix: 'Use a parameterised query (e.g. cursor.execute(sql, (value,))) instead of f-string interpolation.' },
  { id: 'sql-format-injection', category: 'security', severity: 'critical', title: 'Possible SQL injection — formatted query string',
    langs: ['go', 'rust', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift'],
    re: /\b(fmt\.Sprintf|Sprintf|String\.format|format!|sprintf|format)\s*\([^)]*\b(SELECT|INSERT|UPDATE|DELETE)\b/i,
    explanation: 'A SQL query is built by formatting a string with a variable. An attacker can inject SQL through that value.', fix: 'Use a parameterised query / prepared statement with placeholders instead of string formatting.' },
  { id: 'sql-php-concat', category: 'security', severity: 'critical', title: 'Possible SQL injection — PHP query concatenated with a variable',
    langs: ['php'],
    re: /\b(SELECT|INSERT|UPDATE|DELETE)\b[^;]*\.\s*\$/i,
    explanation: 'A PHP SQL query is concatenated with a variable (often $_GET/$_POST). An attacker can inject SQL.', fix: 'Use prepared statements (PDO prepare + bindParam) instead of concatenation.' },
  { id: 'sql-ruby-interp', category: 'security', severity: 'critical', title: 'Possible SQL injection — Ruby query with string interpolation',
    langs: ['ruby'],
    re: /["'][^"']*\b(SELECT|INSERT|UPDATE|DELETE)\b[^"']*#\{/i,
    explanation: 'A SQL query interpolates a variable with #{}. An attacker can inject SQL through that value.', fix: 'Use parameterised queries (e.g. ActiveRecord where with placeholders) instead of interpolation.' },
  { id: 'sql-dynamic-exec', category: 'security', severity: 'critical', title: 'Dynamic SQL executed from a string',
    langs: ['sql'],
    re: /\b(EXEC|EXECUTE)\s*\(/i,
    explanation: 'Dynamic SQL is built and executed from a string. If any part comes from input, it is injectable.', fix: 'Use parameterised dynamic SQL (sp_executesql with parameters) and validate identifiers against an allow-list.' },
  { id: 'sql-delete-no-where', category: 'security', severity: 'major', title: 'DELETE without WHERE — deletes every row',
    langs: ['sql'],
    re: /^\s*DELETE\s+FROM\s+[\w."]+\s*;?\s*$/i,
    explanation: 'A DELETE with no WHERE clause deletes every row in the table. This is usually a mistake, and in a migration it is data loss.', fix: 'Add a WHERE clause, or confirm the full-table delete is intended and back the table up first.' },
  { id: 'sql-drop-table', category: 'security', severity: 'major', title: 'DROP TABLE in a change',
    langs: ['sql'],
    re: /\bDROP\s+TABLE\b/i,
    explanation: 'Dropping a table destroys its data. In a migration this is irreversible without a backup.', fix: 'Confirm the drop is intended, back up first, and prefer a staged migration (rename, then drop later).' },

  // ---- eval / exec / command injection ----
  { id: 'insecure-eval', category: 'security', severity: 'critical', title: 'Insecure eval() on untrusted input',
    langs: ['javascript', 'typescript', 'python', 'php', 'ruby'],
    re: /\beval\s*\(/, explanation: 'eval() executes arbitrary code. If the input comes from a user, request, or file, an attacker can run any code in this process.', fix: 'Do not use eval(). Parse data with JSON.parse or a safe expression parser, and validate the input first.' },
  { id: 'insecure-exec', category: 'security', severity: 'critical', title: 'Command execution with a constructed string',
    langs: ['python'],
    re: /\b(os\.system|os\.popen|subprocess\.(call|run|Popen|check_output))\s*\([^)]*shell\s*=\s*True/i,
    explanation: 'A shell command is run with shell=True on a constructed string. Input in that string runs as a shell command.', fix: 'Pass the command as a list of arguments with shell=False, and validate/allow-list any user-supplied parts.' },
  { id: 'insecure-exec-go', category: 'security', severity: 'major', title: 'exec.Command with a shell — command injection risk',
    langs: ['go'],
    re: /\bexec\.Command\s*\(\s*"(sh|bash)"\s*,\s*"-c"/,
    explanation: 'Running a shell with -c on a constructed string lets input in that string execute as a shell command.', fix: 'Call the binary directly with exec.Command(binary, args...) and validate arguments.' },
  { id: 'insecure-exec-java', category: 'security', severity: 'major', title: 'Runtime.exec / ProcessBuilder with a constructed command',
    langs: ['java', 'kotlin'],
    re: /\b(Runtime\.getRuntime\(\)\.exec|new\s+ProcessBuilder)\s*\(/,
    explanation: 'Executing a constructed command string can let input run as an OS command. Validate every part of the command.', fix: 'Pass arguments as a list, never a single shell string, and allow-list user-supplied parts.' },
  { id: 'insecure-exec-php', category: 'security', severity: 'critical', title: 'Shell execution function on user input',
    langs: ['php'],
    re: /\b(exec|shell_exec|system|passthru|popen)\s*\(/,
    explanation: 'A PHP shell function runs a string as an OS command. Input in that string executes with the server privileges.', fix: 'Avoid shell execution; if unavoidable, escape arguments with escapeshellarg() and allow-list them.' },
  { id: 'insecure-exec-ruby', category: 'security', severity: 'critical', title: 'Shell execution with backticks / system()',
    langs: ['ruby'],
    re: /(`[^`]*#\{|system\s*\(|Kernel\.system\s*\()/,
    explanation: 'Backticks and system() run a string as a shell command. Interpolated input in that string executes as a command.', fix: 'Use Open3 with an argument list, and allow-list user-supplied parts.' },
  { id: 'insecure-exec-c', category: 'security', severity: 'critical', title: 'system() / popen() runs a shell command',
    langs: ['c', 'cpp'],
    re: /\b(system|popen)\s*\(/,
    explanation: 'system()/popen() run a string through the shell. Input in that string executes as a command.', fix: 'Use exec-family calls with an argument array, or validate the command against an allow-list.' },
  { id: 'insecure-exec-csharp', category: 'security', severity: 'major', title: 'Process.Start with a constructed command',
    langs: ['csharp'],
    re: /\bProcess\.Start\s*\(/,
    explanation: 'Starting a process with a constructed command line can let input run as an OS command.', fix: 'Set ProcessStartInfo with FileName and an ArgumentList, and validate arguments.' },
  { id: 'insecure-exec-shell', category: 'security', severity: 'critical', title: 'eval in a shell script',
    langs: ['shell'],
    re: /^\s*eval\s+/,
    explanation: 'eval in a shell script executes its argument as shell code. Input in that argument runs as a command.', fix: 'Remove eval; use arrays for arguments and quote expansions.' },
  { id: 'curl-pipe-shell', category: 'security', severity: 'critical', title: 'curl piped straight into a shell',
    langs: ['shell'],
    re: /\bcurl\b[^|]*\|\s*(sh|bash)\b/,
    explanation: 'Piping a downloaded script straight into a shell runs remote code sight-unseen, with no checksum or review.', fix: 'Download the file, verify its checksum/signature, inspect it, then run it.' },
  { id: 'function-constructor', category: 'security', severity: 'critical', title: 'new Function() — eval by another name',
    langs: ['javascript', 'typescript'],
    re: /\bnew\s+Function\s*\(/,
    explanation: 'new Function() compiles a string as code, exactly like eval(). Input in that string executes.', fix: 'Do not build functions from strings; use a safe parser or a lookup table of real functions.' },
  { id: 'node-child-exec', category: 'security', severity: 'major', title: 'child_process exec with a string command',
    langs: ['javascript', 'typescript'],
    re: /\bexec\s*\(\s*`[^`]*\$\{|exec\s*\(\s*["'][^"']*["']\s*\+/,
    explanation: 'child_process.exec runs a string through a shell. Interpolated input in that string executes as a command.', fix: 'Use execFile/spawn with an argument array instead of a shell string.' },

  // ---- unsafe deserialisation ----
  { id: 'unsafe-pickle', category: 'security', severity: 'critical', title: 'pickle.loads on untrusted data — arbitrary code execution',
    langs: ['python'],
    re: /\bpickle\.(loads|load)\s*\(/,
    explanation: 'Unpickling untrusted data executes arbitrary code during deserialisation. It is not a data format, it is code.', fix: 'Use JSON (or another safe format) instead of pickle for untrusted data.' },
  { id: 'unsafe-yaml-load', category: 'security', severity: 'critical', title: 'yaml.load without SafeLoader — arbitrary code execution',
    langs: ['python'],
    re: /\byaml\.load\s*\([^)]*\)/,
    explanation: 'yaml.load() with the default loader can construct arbitrary Python objects. Untrusted YAML can execute code.', fix: 'Use yaml.safe_load() instead.' },
  { id: 'unsafe-unserialize', category: 'security', severity: 'critical', title: 'unserialize() on untrusted data — object injection',
    langs: ['php'],
    re: /\bunserialize\s*\(/,
    explanation: 'unserialize() on untrusted input can instantiate arbitrary classes and trigger object-injection attacks.', fix: 'Use json_decode() for untrusted data, or unserialize() with an allowed_classes allow-list.' },
  { id: 'unsafe-marshal', category: 'security', severity: 'critical', title: 'Marshal/YAML.load on untrusted data',
    langs: ['ruby'],
    re: /\b(Marshal\.load|YAML\.load)\s*\(/,
    explanation: 'Marshal.load and YAML.load (without safe_load) can instantiate arbitrary objects from untrusted input.', fix: 'Use JSON.parse or YAML.safe_load with permitted_classes instead.' },
  { id: 'unsafe-java-deser', category: 'security', severity: 'critical', title: 'Java ObjectInputStream deserialisation of untrusted data',
    langs: ['java', 'kotlin'],
    re: /\bnew\s+ObjectInputStream\s*\(/,
    explanation: 'Java native deserialisation of untrusted bytes can execute gadget chains before any validation runs.', fix: 'Do not deserialise untrusted bytes with ObjectInputStream; use a safe format (JSON) or a validated allow-list filter.' },
  { id: 'unsafe-binary-formatter', category: 'security', severity: 'critical', title: 'BinaryFormatter deserialisation — insecure by design',
    langs: ['csharp'],
    re: /\bBinaryFormatter\b/,
    explanation: 'BinaryFormatter is insecure by design: deserialising untrusted data can execute arbitrary code.', fix: 'Use System.Text.Json or another safe serialiser instead of BinaryFormatter.' },
  { id: 'unsafe-swift-unarchiver', category: 'security', severity: 'major', title: 'NSKeyedUnarchiver on untrusted data',
    langs: ['swift'],
    re: /\bNSKeyedUnarchiver\b/,
    explanation: 'Unarchiving untrusted data can instantiate arbitrary classes. Require secure coding and an allow-list.', fix: 'Use requiresSecureCoding: true with an explicit allowed-classes list.' },

  // ---- XSS / HTML injection ----
  { id: 'xss-innerhtml', category: 'security', severity: 'major', title: 'innerHTML set from a variable — XSS risk',
    langs: ['javascript', 'typescript'],
    re: /\.innerHTML\s*=\s*[^"'\n]/,
    explanation: 'Assigning a variable to innerHTML inserts it as HTML. If the value contains user input, an attacker can inject scripts.', fix: 'Use textContent for text, or sanitise the HTML with a library (e.g. DOMPurify) before assigning it.' },
  { id: 'xss-dangerously-set', category: 'security', severity: 'major', title: 'dangerouslySetInnerHTML with a variable',
    langs: ['javascript', 'typescript'],
    re: /dangerouslySetInnerHTML\s*=\s*\{\s*\{\s*__html\s*:\s*[A-Za-z_$]/,
    explanation: 'dangerouslySetInnerHTML inserts raw HTML. A variable here is an XSS sink if it can contain user input.', fix: 'Sanitise the HTML first (DOMPurify) or render the content as React elements instead.' },
  { id: 'xss-template-html', category: 'security', severity: 'major', title: 'Template rendering without escaping (Go template.HTML)',
    langs: ['go'],
    re: /\btemplate\.HTML\s*\(/,
    explanation: 'template.HTML marks a string as safe HTML, bypassing Go template escaping. Input here renders as raw HTML.', fix: 'Do not use template.HTML on user-influenced strings; let the template escape them.' },
  { id: 'html-inline-handler', category: 'security', severity: 'minor', title: 'Inline event handler in HTML',
    langs: ['html'],
    re: /\son(click|load|error|submit|mouseover)\s*=/i,
    explanation: 'Inline handlers mix behaviour into markup and are blocked by a strict Content-Security-Policy.', fix: 'Attach handlers in JavaScript with addEventListener instead.' },

  // ---- unsafe C / memory ----
  { id: 'unsafe-rust', category: 'security', severity: 'major', title: 'unsafe block bypasses Rust safety guarantees',
    langs: ['rust'],
    re: /\bunsafe\s*\{/,
    explanation: 'An unsafe block bypasses the borrow checker and memory safety. A bug inside it can corrupt memory.', fix: 'Keep unsafe blocks minimal, document the safety invariant they rely on, and wrap them in a safe abstraction.' },
  { id: 'unsafe-strcpy', category: 'security', severity: 'critical', title: 'strcpy/strcat/gets — unbounded copy, buffer overflow',
    langs: ['c', 'cpp'],
    re: /\b(strcpy|strcat|gets|sprintf)\s*\(/,
    explanation: 'These functions copy without a length check and are a classic buffer-overflow source.', fix: 'Use strncpy/strncat/fgets/snprintf with explicit bounds, or a safe string type.' },

  // ---- error swallowing ----
  { id: 'empty-catch', category: 'bug', severity: 'minor', title: 'Empty catch block swallows errors',
    langs: ['javascript', 'typescript', 'java', 'kotlin', 'csharp', 'php', 'ruby', 'swift', 'go', 'rust'],
    re: /\bcatch\s*\([^)]*\)\s*\{\s*\}/,
    explanation: 'An empty catch hides failures, making bugs impossible to diagnose.', fix: 'Log the error, rethrow it, or handle it explicitly.' },
  { id: 'empty-except', category: 'bug', severity: 'minor', title: 'Bare except / except: pass swallows errors',
    langs: ['python'],
    re: /^\s*(except\s*:\s*pass|except\s*:\s*$|except\s+Exception\s*:\s*pass)/,
    explanation: 'A bare except (or except: pass) hides every failure, including bugs and KeyboardInterrupt.', fix: 'Catch the specific exception, log it, or re-raise.' },
  { id: 'empty-rescue', category: 'bug', severity: 'minor', title: 'Empty rescue swallows errors',
    langs: ['ruby'],
    re: /\brescue\b[^#\n]*$/,
    explanation: 'A rescue with no body silently swallows the error.', fix: 'Log the error or re-raise it.' },
  { id: 'ignored-error-go', category: 'bug', severity: 'minor', title: 'Error explicitly ignored with _ = in Go',
    langs: ['go'],
    re: /^\s*_\s*=\s*\w+\(/,
    explanation: 'Assigning an error to _ discards it. A failed call then looks successful.', fix: 'Check the error and return or log it.' },
  { id: 'unwrap-result', category: 'bug', severity: 'minor', title: '.unwrap() on a Result/Option — panics on failure',
    langs: ['rust'],
    re: /\.unwrap\(\)/,
    explanation: 'unwrap() panics on Err/None. In production code that is a crash on an input-dependent path.', fix: 'Handle the error with ? or a match, or use expect() with a message that explains the invariant.' },
  { id: 'try-bang-swift', category: 'bug', severity: 'minor', title: 'try! crashes on error in Swift',
    langs: ['swift'],
    re: /\btry!\b/,
    explanation: 'try! traps (crashes) if the call throws. A failure on real data crashes the app.', fix: 'Use do/catch or try? and handle the failure path.' },

  // ---- debug prints ----
  { id: 'console-log', category: 'style', severity: 'nitpick', title: 'console.log left in code',
    langs: ['javascript', 'typescript'],
    re: /\bconsole\.(log|debug|info)\s*\(/, explanation: 'Debug logging in shipped code is noisy and can leak internal data.', fix: 'Remove the console call or replace it with a proper logger behind a debug flag.' },
  { id: 'debugger', category: 'bug', severity: 'major', title: 'debugger statement left in code',
    langs: ['javascript', 'typescript'],
    re: /^\s*debugger\s*;?/, explanation: 'A debugger statement will pause execution for anyone running with devtools open.', fix: 'Remove the debugger statement.' },
  { id: 'print-debug-py', category: 'style', severity: 'nitpick', title: 'print() debug output left in code',
    langs: ['python'],
    re: /\bprint\s*\(/, explanation: 'print() debug output in shipped code is noisy and can leak data into logs.', fix: 'Remove it or replace it with a proper logger call.' },
  { id: 'print-debug-go', category: 'style', severity: 'nitpick', title: 'fmt.Println debug output left in code',
    langs: ['go'],
    re: /\bfmt\.Print(ln)?\s*\(/, explanation: 'fmt.Println debug output in shipped code is noisy.', fix: 'Remove it or use the structured logger.' },
  { id: 'print-debug-java', category: 'style', severity: 'nitpick', title: 'System.out.println debug output left in code',
    langs: ['java', 'kotlin'],
    re: /\bSystem\.out\.println\s*\(/, explanation: 'System.out.println debug output in shipped code is noisy and bypasses logging.', fix: 'Remove it or use the logger.' },
  { id: 'print-debug-php', category: 'style', severity: 'nitpick', title: 'var_dump / print_r debug output left in code',
    langs: ['php'],
    re: /\b(var_dump|print_r)\s*\(/, explanation: 'var_dump/print_r output in shipped code leaks internal data to users.', fix: 'Remove it or log through the logger.' },
  { id: 'print-debug-ruby', category: 'style', severity: 'nitpick', title: 'puts debug output left in code',
    langs: ['ruby'],
    re: /\bputs\s+["']/,
    explanation: 'puts debug output in shipped code is noisy.', fix: 'Remove it or use the logger.' },
  { id: 'print-debug-rust', category: 'style', severity: 'nitpick', title: 'println! debug output left in code',
    langs: ['rust'],
    re: /\bprintln!\s*\(/, explanation: 'println! debug output in shipped code is noisy.', fix: 'Remove it or use the log crate.' },
  { id: 'print-debug-csharp', category: 'style', severity: 'nitpick', title: 'Console.WriteLine debug output left in code',
    langs: ['csharp'],
    re: /\bConsole\.WriteLine\s*\(/, explanation: 'Console.WriteLine debug output in shipped code is noisy.', fix: 'Remove it or use the logger.' },
  { id: 'print-debug-swift', category: 'style', severity: 'nitpick', title: 'print() debug output left in code',
    langs: ['swift'],
    re: /\bprint\s*\(/, explanation: 'print() debug output in shipped code is noisy.', fix: 'Remove it or use os_log / Logger.' },
  { id: 'todo-macro-rust', category: 'style', severity: 'nitpick', title: 'todo!() / unimplemented!() left in code',
    langs: ['rust'],
    re: /\b(todo!|unimplemented!)\s*\(/, explanation: 'todo!() panics when reached — unfinished code is being merged.', fix: 'Implement it, or track it in an issue and remove the macro.' },
  { id: 'todo-kotlin', category: 'style', severity: 'nitpick', title: 'TODO() call left in code (throws at runtime)',
    langs: ['kotlin'],
    re: /\bTODO\s*\(/, explanation: 'Kotlin TODO() throws NotImplementedError at runtime — unfinished code is being merged.', fix: 'Implement it or track it in an issue.' },

  // ---- off-by-one / loops ----
  { id: 'off-by-one-length', category: 'bug', severity: 'major', title: 'Possible off-by-one — loop uses <= with .length',
    langs: ['javascript', 'typescript', 'java', 'kotlin', 'csharp', 'php', 'swift'],
    re: /\bfor\s*\([^;]*;\s*\w+\s*<=\s*[\w.]*\.length/,
    explanation: 'Looping with `i <= arr.length` reads one past the last element (arr[arr.length] is undefined). This usually crashes or silently produces wrong results.', fix: 'Use `i < arr.length` so the loop stops at the last valid index.' },
  { id: 'off-by-one-py', category: 'bug', severity: 'major', title: 'Possible off-by-one — range() with len() + 1',
    langs: ['python'],
    re: /\brange\s*\(\s*len\s*\([^)]*\)\s*\+\s*1\s*\)/,
    explanation: 'range(len(x) + 1) iterates one index past the last element and raises IndexError.', fix: 'Use range(len(x)) instead.' },
  { id: 'off-by-one-go', category: 'bug', severity: 'major', title: 'Possible off-by-one — loop uses <= with len()',
    langs: ['go'],
    re: /\bfor\s+\w+\s*:?=\s*0\s*;\s*\w+\s*<=\s*len\s*\(/,
    explanation: 'Looping with `i <= len(x)` reads one past the last element and panics.', fix: 'Use `i < len(x)` so the loop stops at the last valid index.' },

  // ---- weak crypto / auth ----
  { id: 'weak-md5-password', category: 'security', severity: 'major', title: 'MD5 used for a password / hash',
    langs: ['php', 'python', 'java', 'javascript', 'typescript', 'ruby', 'go'],
    re: /\b(md5|MD5)\s*\(/,
    explanation: 'MD5 is broken for passwords and integrity — collisions are trivial to compute.', fix: 'Use a password hash (bcrypt/argon2) for passwords, or SHA-256+ for integrity.' },
  { id: 'unsafe-random', category: 'security', severity: 'minor', title: 'Math.random / rand used where security matters',
    langs: ['javascript', 'typescript', 'python', 'java', 'go', 'php', 'ruby'],
    re: /\b(Math\.random|random\.random|rand\(\))\s*\(/,
    explanation: 'Non-cryptographic randomness must not generate tokens, passwords, or session ids.', fix: 'Use a CSPRNG (crypto.randomBytes / secrets / SecureRandom) for security-sensitive values.' },

  // ---- config / IaC ----
  { id: 'docker-latest', category: 'style', severity: 'minor', title: 'Docker base image uses :latest',
    langs: ['dockerfile'],
    re: /^\s*FROM\s+\S+:latest\b/i,
    explanation: ':latest moves under you — the same Dockerfile builds different images over time.', fix: 'Pin the base image to a specific version/digest.' },
  { id: 'docker-root-user', category: 'security', severity: 'major', title: 'Container runs as root (no USER set)',
    langs: ['dockerfile'],
    re: /^\s*USER\s+root\b/i,
    explanation: 'Running as root widens the impact of any container escape.', fix: 'Add a non-root USER (create one with a numeric UID if needed).' },
  { id: 'tf-open-ingress', category: 'security', severity: 'critical', title: 'Security group open to the world (0.0.0.0/0)',
    langs: ['terraform'],
    re: /0\.0\.0\.0\/0/,
    explanation: 'An ingress rule open to 0.0.0.0/0 exposes the port to the whole internet.', fix: 'Restrict cidr_blocks to the networks that actually need access.' },
  { id: 'tf-plaintext-password', category: 'security', severity: 'major', title: 'Plaintext password in Terraform',
    langs: ['terraform'],
    re: /\bpassword\s*=\s*"[^"]+"/,
    explanation: 'A plaintext password in Terraform state/config leaks into version control and state files.', fix: 'Read the password from a secrets manager or a variable marked sensitive.' },
  { id: 'img-no-alt', category: 'style', severity: 'minor', title: 'Image without alt text',
    langs: ['html'],
    re: /<img(?![^>]*\balt\s*=)[^>]*>/i,
    explanation: 'An <img> without alt text is invisible to screen readers.', fix: 'Add an alt attribute (alt="" for decorative images).' },
];

function toolEnabled(name, config) {
  if (!config || !config.tools) return true;
  const t = config.tools[name];
  return !t || t.enabled !== false;
}

function runChecks(files, config) {
  const findings = [];
  for (const f of files) {
    const lang = detectLanguage(f.path);
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l.type !== 'add') continue;
        for (const rule of RULES) {
          if (rule.langs && !rule.langs.includes(lang)) continue;
          if (!toolEnabled(rule.id, config)) continue;
          if (!rule.re.test(l.content)) continue;
          findings.push(makeFinding(rule, f, l));
        }
        for (const rule of LANG_RULES) {
          if (!rule.langs.includes(lang)) continue;
          if (!toolEnabled(rule.id, config)) continue;
          if (!rule.re.test(l.content)) continue;
          findings.push(makeFinding(rule, f, l));
        }
      }
    }
  }
  return findings;
}

function makeFinding(rule, f, l) {
  return {
    source: 'check:' + rule.id,
    file: f.path,
    line: l.newLine,
    position: l.position,
    severity: rule.severity,
    category: rule.category,
    title: rule.title,
    explanation: rule.explanation,
    suggestedFix: rule.fix,
    confidence: 0.95,
    evidence: l.content.trim().slice(0, 200),
  };
}

// Long-file / long-function heuristics need whole-file context; run over the
// added-line text of each file when we have it (best effort, cheap).
function runFileChecks(files, config) {
  const findings = [];
  for (const f of files) {
    const added = f.hunks.flatMap((h) => h.lines.filter((l) => l.type === 'add').map((l) => l.content));
    if (added.length > 500 && toolEnabled('long-file', config)) {
      findings.push({
        source: 'check:long-file', file: f.path, line: f.hunks[0]?.newStart || 1, position: f.hunks[0]?.headerPosition || 1,
        severity: 'minor', category: 'style', title: 'Very large change in one file (' + added.length + ' added lines)',
        explanation: 'Large diffs are hard to review and hide bugs. Split the change or add tests for the new behaviour.',
        suggestedFix: 'Split this file change into smaller, focused commits.',
        confidence: 0.8,
      });
    }
    // Long function: a single hunk adding 80+ lines with no blank-line
    // structure break is usually one function doing too much.
    for (const h of f.hunks) {
      const adds = h.lines.filter((l) => l.type === 'add');
      if (adds.length >= 80 && toolEnabled('long-function', config)) {
        findings.push({
          source: 'check:long-function', file: f.path, line: h.newStart, position: h.headerPosition,
          severity: 'minor', category: 'style', title: 'Very long function/block (' + adds.length + ' added lines in one hunk)',
          explanation: 'A single block this long is hard to test and usually mixes several responsibilities.',
          suggestedFix: 'Extract helpers for the distinct steps in this block.',
          confidence: 0.7,
          evidence: (adds[0]?.content || '').trim().slice(0, 200),
        });
        break;
      }
    }
  }
  return findings;
}

module.exports = { runChecks, runFileChecks, RULES, LANG_RULES, detectLanguage, LANGUAGES };
