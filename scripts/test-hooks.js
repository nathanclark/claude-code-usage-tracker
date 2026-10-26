'use strict';
/**
 * Fire one synthetic payload per registered hook event and check the contract.
 *
 * Everything is written to a throwaway directory, so your real logs are never
 * touched, and the transcript the token scanner reads is synthetic with known
 * numbers - which makes the token assertions exact rather than "it read
 * something", and lets this run identically in CI on Windows, macOS and Linux.
 *
 *   node scripts/test-hooks.js
 *   node scripts/test-hooks.js --keep     (leave the temp directory behind)
 *   node scripts/test-hooks.js --verbose  (print every captured line)
 *
 * Exits 0 when every check passes, 1 otherwise.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const HOOK = path.join(ROOT, 'lib', 'log-event.js');
const REPORT = path.join(ROOT, 'lib', 'report.js');

const opt = {
  keep: process.argv.indexOf('--keep') >= 0,
  verbose: process.argv.indexOf('--verbose') >= 0,
};

const checks = [];
function check(name, ok, detail) {
  checks.push({ name, ok: !!ok, detail: detail || '' });
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  -- ${detail}` : ''}\n`);
}

// --------------------------------------------------------------------------- //
// Fixtures
// --------------------------------------------------------------------------- //

const SID = 'hooktest-' + Date.now();

/** Two priced turns plus an exact duplicate, to prove de-duplication by id. */
const TRANSCRIPT_LINES = [
  { type: 'user', message: { role: 'user', content: 'hello' } },
  {
    type: 'assistant',
    message: {
      id: 'msg_test_a',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1000000,
        output_tokens: 200000,
        cache_read_input_tokens: 3000000,
        cache_creation_input_tokens: 400000,
        cache_creation: { ephemeral_1h_input_tokens: 400000, ephemeral_5m_input_tokens: 0 },
        output_tokens_details: { thinking_tokens: 50000 },
      },
    },
  },
  {
    type: 'assistant',
    message: {
      id: 'msg_test_b',
      model: 'claude-sonnet-5',
      usage: {
        input_tokens: 100000,
        output_tokens: 20000,
        cache_read_input_tokens: 300000,
        cache_creation_input_tokens: 40000,
        cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 40000 },
      },
    },
  },
  // same id as the first: must be ignored
  {
    type: 'assistant',
    message: {
      id: 'msg_test_a',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 1000000,
        output_tokens: 200000,
        cache_read_input_tokens: 3000000,
        cache_creation_input_tokens: 400000,
      },
    },
  },
];

const EXPECTED_DELTA = {
  input: 1100000,
  output: 220000,
  cache_read: 3300000,
  cache_creation: 440000,
  cache_creation_5m: 40000,
  cache_creation_1h: 400000,
  thinking: 50000,
  requests: 2,
};

/** The two priced turns above, as the report's per-model pricing sees them. */
const EXPECTED_BY_MODEL = {
  'claude-opus-5': {
    input: 1000000,
    output: 200000,
    cache_read: 3000000,
    cache_creation: 400000,
    cache_creation_5m: 0,
    cache_creation_1h: 400000,
  },
  'claude-sonnet-5': {
    input: 100000,
    output: 20000,
    cache_read: 300000,
    cache_creation: 40000,
    cache_creation_5m: 40000,
    cache_creation_1h: 0,
  },
};

function fixtures(ctx) {
  return {
    SessionStart: { source: 'startup', model: 'claude-opus-5', context_tokens: 18240 },
    InstructionsLoaded: { file_path: ctx.rulesFile, memory_type: 'User', load_reason: 'session_start' },
    UserPromptSubmit: {
      prompt: 'Add a health check endpoint to the API and wire it into the smoke tests',
      prompt_id: 'p-1',
    },
    UserPromptExpansion: {
      expansion_type: 'slash_command',
      command_name: 'usage-tracker:report',
      command_args: '7',
      command_source: 'user',
      prompt: '/usage-tracker:report 7',
    },
    PostToolUse: {
      tool_name: 'Edit',
      tool_input: { file_path: path.join('repo', 'src', 'api', 'health.ts'), old_string: 'a', new_string: 'b' },
      tool_response: { type: 'update' },
      tool_use_id: 'toolu_t1',
      duration_ms: 18,
    },
    PostToolUseFailure: {
      tool_name: 'Bash',
      tool_input: { command: 'npm run test:smoke', description: 'smoke tests' },
      tool_use_id: 'toolu_t2',
      error: 'Exit code 1\nError: connect ECONNREFUSED 127.0.0.1:3000',
      is_interrupt: false,
      duration_ms: 5231,
    },
    PermissionRequest: { tool_name: 'Bash', tool_input: { command: 'rm -rf dist', description: 'clean build output' } },
    PermissionDenied: {
      tool_name: 'Bash',
      tool_input: { command: 'git push --force' },
      tool_use_id: 'toolu_t3',
      reason: '[Irreversible Remote Change]',
    },
    SubagentStart: { agent_id: 'agent-t1', agent_type: 'Explore' },
    SubagentStop: {
      agent_id: 'agent-t1',
      agent_type: 'Explore',
      stop_hook_active: false,
      last_assistant_message: 'Found the three call sites.',
      agent_transcript_path: path.join(ctx.dir, 'agent-t1.jsonl'),
    },
    Notification: {
      notification_type: 'permission_prompt',
      title: 'Permission needed',
      message: 'Claude needs your permission to use Bash',
    },
    PreCompact: { trigger: 'auto', custom_instructions: null },
    Stop: {
      stop_hook_active: false,
      last_assistant_message: 'Added the endpoint and the smoke test.',
      background_tasks: [],
      session_crons: [],
    },
    StopFailure: { error: 'rate_limit', error_details: '429 Too Many Requests', last_assistant_message: 'API Error' },
    SessionEnd: { reason: 'prompt_input_exit' },
    // An MCP-shaped tool call: the summary must carry key names only, no values.
    'PostToolUse#mcp': {
      event: 'PostToolUse',
      tool_name: 'mcp__secrets__read',
      tool_input: { token: 'sk-should-never-be-logged', path: '/etc/shadow' },
      tool_use_id: 'toolu_t4',
      mcp_server: 'secrets',
    },
    // A correcting prompt, so the friction branch is exercised too.
    'UserPromptSubmit#correction': {
      event: 'UserPromptSubmit',
      prompt: "No, that's wrong - undo the last edit, I said use the existing helper",
      prompt_id: 'p-2',
    },
  };
}

// --------------------------------------------------------------------------- //

function fire(ctx, eventName, extra, envOverrides) {
  const payload = Object.assign(
    {
      session_id: SID,
      transcript_path: ctx.transcript,
      cwd: ctx.cwd,
      permission_mode: 'default',
      hook_event_name: eventName,
    },
    extra
  );
  delete payload.event;
  const t0 = Date.now();
  const res = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CC_USAGE_LOG_DIR: ctx.dir }, envOverrides || {}),
    windowsHide: true,
  });
  return {
    ms: Date.now() - t0,
    status: res.status,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || ''),
    error: res.error,
  };
}

function readLines(ctx) {
  const out = [];
  for (const f of fs.readdirSync(ctx.dir)) {
    if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
    for (const line of fs.readFileSync(path.join(ctx.dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch (_) {
        out.push({ __unparseable: line });
      }
    }
  }
  return out;
}

function main() {
  // ---- set up a throwaway world ---------------------------------------- //
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-test-'));
  const cwd = path.join(dir, 'fake-repo');
  fs.mkdirSync(cwd, { recursive: true });
  // a plain directory, not a git repo: project resolution must still work
  const rulesFile = path.join(cwd, 'CLAUDE.md');
  fs.writeFileSync(rulesFile, '# Project rules\n\nAlways run the smoke tests.\n', 'utf8');
  const transcript = path.join(dir, 'transcript.jsonl');
  fs.writeFileSync(transcript, TRANSCRIPT_LINES.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');

  const ctx = { dir, cwd, rulesFile, transcript };
  process.stdout.write(`\nTemp log dir : ${dir}\nNode         : ${process.version}\nPlatform     : ${process.platform}\nSession      : ${SID}\n\n`);

  // ---- which events are registered? ------------------------------------- //
  let registered = [];
  try {
    const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    registered = Object.keys(hooksJson.hooks || {});
  } catch (err) {
    check('hooks/hooks.json parses', false, String((err && err.message) || err));
  }
  check('hooks/hooks.json parses and registers events', registered.length > 0, `${registered.length} event(s)`);

  const fx = fixtures(ctx);
  const missingFixture = registered.filter((e) => !fx[e]);
  check('every registered event has a test fixture', missingFixture.length === 0, missingFixture.join(', '));

  // Fire in the order a real session produces, not the order hooks.json happens
  // to list: SessionEnd runs a closing transcript scan, so firing it before Stop
  // would consume the transcript and leave Stop with nothing to count.
  const ORDER = [
    'SessionStart',
    'InstructionsLoaded',
    'UserPromptSubmit',
    'UserPromptExpansion',
    'PostToolUse',
    'PostToolUse#mcp',
    'PostToolUseFailure',
    'PermissionRequest',
    'PermissionDenied',
    'SubagentStart',
    'SubagentStop',
    'Notification',
    'PreCompact',
    'Stop',
    'StopFailure',
    'UserPromptSubmit#correction',
    'SessionEnd',
  ];
  const unordered = registered.filter((e) => ORDER.indexOf(e) < 0);
  check('the lifecycle order covers every registered event', unordered.length === 0, unordered.join(', '));

  // Every registered hook must be async, or the logger lands on the critical path.
  try {
    const hooksJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'hooks', 'hooks.json'), 'utf8'));
    const notAsync = [];
    for (const [evt, groups] of Object.entries(hooksJson.hooks || {})) {
      for (const g of groups) for (const h of g.hooks || []) if (h.async !== true) notAsync.push(evt);
    }
    check('every hook is registered async', notAsync.length === 0, notAsync.join(', '));
  } catch (_) {
    /* already reported above */
  }

  // ---- fire everything -------------------------------------------------- //
  const runs = [];
  for (const key of ORDER) {
    const spec = fx[key];
    if (!spec) continue;
    const eventName = spec.event || key;
    runs.push({ key, eventName, res: fire(ctx, eventName, spec) });
  }

  const nonZero = runs.filter((r) => r.res.status !== 0 || r.res.error);
  check(
    'every hook exits 0',
    nonZero.length === 0,
    nonZero.map((r) => `${r.key}=${r.res.status}${r.res.error ? '/' + r.res.error.code : ''}`).join(', ')
  );

  const noisy = runs.filter((r) => r.res.stdout.trim() !== '');
  check(
    'no hook writes to stdout',
    noisy.length === 0,
    noisy.map((r) => `${r.key}: ${r.res.stdout.trim().slice(0, 60)}`).join(' | ')
  );

  const slow = runs.filter((r) => r.res.ms > 5000);
  check('no hook took longer than 5s', slow.length === 0, slow.map((r) => `${r.key}=${r.res.ms}ms`).join(', '));

  // ---- the error log must be empty -------------------------------------- //
  const errLog = path.join(dir, 'hook-errors.log');
  let errText = '';
  try {
    errText = fs.readFileSync(errLog, 'utf8').trim();
  } catch (_) {
    errText = '';
  }
  check('hook-errors.log is empty', errText === '', errText.slice(0, 300));

  // ---- every event produced a line -------------------------------------- //
  const lines = readLines(ctx);
  if (opt.verbose) for (const l of lines) process.stdout.write('  ' + JSON.stringify(l) + '\n');
  check('no unparseable log lines', lines.every((l) => !l.__unparseable));

  const captured = new Set(lines.map((l) => l.event));
  const missing = registered.filter((e) => !captured.has(e));
  check('every registered event was captured', missing.length === 0, missing.join(', '));
  check('one line per fired hook', lines.length === runs.length, `${lines.length} line(s) for ${runs.length} hook(s)`);

  // ---- envelope --------------------------------------------------------- //
  const bad = lines.filter((l) => !l.ts || !l.event || l.session_id !== SID || l.project !== 'fake-repo');
  check('every line carries ts, event, session_id and project', bad.length === 0, `${bad.length} bad line(s)`);
  check(
    'timestamps are local ISO with an offset',
    lines.every((l) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}[+-]\d{2}:\d{2}$/.test(l.ts))
  );

  // ---- token scan ------------------------------------------------------- //
  const stop = lines.find((l) => l.event === 'Stop');
  const delta = (stop && stop.tokens_delta) || {};
  const wrong = Object.keys(EXPECTED_DELTA).filter((k) => delta[k] !== EXPECTED_DELTA[k]);
  check(
    'the transcript scan produced exactly the expected tokens',
    wrong.length === 0,
    wrong.map((k) => `${k}: got ${delta[k]}, want ${EXPECTED_DELTA[k]}`).join('; ')
  );
  check(
    'the duplicate message id was counted once',
    delta.requests === 2,
    `requests=${delta.requests} (3 assistant lines, one a duplicate)`
  );
  const byModel = (stop && stop.tokens_by_model) || {};
  check(
    'tokens are split per model',
    !!byModel['claude-opus-5'] && !!byModel['claude-sonnet-5'],
    Object.keys(byModel).join(', ')
  );
  check(
    'the 1-hour and 5-minute cache writes are kept apart',
    delta.cache_creation_1h === EXPECTED_DELTA.cache_creation_1h &&
      delta.cache_creation_5m === EXPECTED_DELTA.cache_creation_5m,
    `1h=${delta.cache_creation_1h} 5m=${delta.cache_creation_5m}`
  );

  // ---- rules hashing ---------------------------------------------------- //
  const rules = lines.find((l) => l.event === 'InstructionsLoaded');
  check(
    'the instructions file was hashed',
    !!(rules && /^[0-9a-f]{64}$/.test(String(rules.content_sha256))) && rules.size_bytes > 0,
    rules ? String(rules.content_sha256).slice(0, 16) : 'no event'
  );

  // ---- friction --------------------------------------------------------- //
  const corr = lines.filter((l) => l.event === 'UserPromptSubmit' && l.correction_hits);
  check('the correcting prompt was flagged', corr.length === 1, `${corr.length} flagged of 2 prompts`);
  check(
    'the plain prompt was not flagged',
    lines.filter((l) => l.event === 'UserPromptSubmit').length === 2 && corr.length === 1
  );
  const fail = lines.find((l) => l.event === 'PostToolUseFailure');
  check('a tool failure is marked as friction', !!fail && fail.friction === 'tool_failure', fail && fail.friction);

  // ---- tool input summarisation ----------------------------------------- //
  const mcp = lines.find((l) => l.event === 'PostToolUse' && l.tool_name === 'mcp__secrets__read');
  const mcpInputOk =
    mcp &&
    Array.isArray(mcp.input && mcp.input.input_keys) &&
    mcp.input.input_keys.indexOf('token') >= 0 &&
    JSON.stringify(mcp).indexOf('sk-should-never-be-logged') < 0 &&
    JSON.stringify(mcp).indexOf('/etc/shadow') < 0;
  check('an unrecognised/MCP tool logs key names only, never values', !!mcpInputOk);

  const edit = lines.find((l) => l.event === 'PostToolUse' && l.tool_name === 'Edit');
  check(
    'a file tool logs the path but not the content',
    !!edit && !!(edit.input && edit.input.file_path) && JSON.stringify(edit).indexOf('new_string') < 0
  );

  // ---- the privacy switch ----------------------------------------------- //
  const privDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-priv-'));
  const privCtx = Object.assign({}, ctx, { dir: privDir });
  fire(privCtx, 'UserPromptSubmit', { prompt: 'this text must not be stored anywhere' }, { CC_USAGE_CAPTURE_PROMPTS: '0' });
  const privLines = readLines(privCtx);
  const privOk =
    privLines.length === 1 &&
    privLines[0].prompt === undefined &&
    privLines[0].prompt_captured === false &&
    privLines[0].prompt_chars === 'this text must not be stored anywhere'.length &&
    JSON.stringify(privLines[0]).indexOf('must not be stored') < 0;
  check('CC_USAGE_CAPTURE_PROMPTS=0 stops prompt text being written', privOk, JSON.stringify(privLines[0] || {}).slice(0, 160));

  // ---- concurrency ------------------------------------------------------ //
  const conDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-usage-con-'));
  const conCtx = Object.assign({}, ctx, { dir: conDir });
  const big = 'x'.repeat(20000);
  const kids = [];
  for (let i = 0; i < 8; i++) {
    kids.push(
      spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          session_id: SID + '-' + i,
          cwd: conCtx.cwd,
          hook_event_name: 'UserPromptSubmit',
          prompt: `${i} ${big}`,
        }),
        encoding: 'utf8',
        env: Object.assign({}, process.env, { CC_USAGE_LOG_DIR: conDir }),
        windowsHide: true,
      })
    );
  }
  const conLines = readLines(conCtx);
  check(
    'concurrent writers each append one intact line',
    conLines.length === 8 && conLines.every((l) => !l.__unparseable && l.prompt && l.prompt.length === big.length + 2),
    `${conLines.length} line(s), ${conLines.filter((l) => l.__unparseable).length} corrupt`
  );
  check('no lock files are left behind', fs.readdirSync(conDir).filter((f) => /\.lock$/.test(f)).length === 0);

  // ---- the report runs end to end --------------------------------------- //
  const outDir = path.join(dir, 'reports-out');
  const rep = spawnSync(process.execPath, [REPORT, '--days', '2', '--out-dir', outDir], {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { CC_USAGE_LOG_DIR: dir }),
    windowsHide: true,
  });
  check('the report generator exits 0', rep.status === 0, String(rep.stderr || '').slice(0, 300));
  const produced = (() => {
    try {
      return fs.readdirSync(outDir);
    } catch (_) {
      return [];
    }
  })();
  check(
    'the report writes its four files',
    ['usage-report-', 'prompts-', 'friction-', 'inventory-'].every((p) => produced.some((f) => f.startsWith(p))),
    produced.join(', ')
  );
  const mdFile = produced.find((f) => f.startsWith('usage-report-'));
  const md = mdFile ? fs.readFileSync(path.join(outDir, mdFile), 'utf8') : '';
  check('the report has all five sections', [1, 2, 3, 4, 5].every((n) => md.indexOf(`## ${n}. `) >= 0));
  const { estimateCost, loadPrices } = require(path.join(ROOT, 'lib', 'pricing.js'));
  const bundled = loadPrices();
  const expectedCost =
    Math.round(
      Object.keys(EXPECTED_BY_MODEL).reduce((t, m) => t + estimateCost(bundled, EXPECTED_BY_MODEL[m], m), 0) * 100
    ) / 100;
  const shown = /\|\s*(?:Token value at list price|Estimated cost)\s*\|\s*\$([\d,.]+)\s*\|/.exec(md);
  check(
    'the report prices the synthetic tokens per model, including the 1h cache split',
    !!shown && Number(String(shown[1]).replace(/,/g, '')) === expectedCost,
    `report says $${shown ? shown[1] : 'nothing'}, pricing module says $${expectedCost.toFixed(2)}`
  );
  check('the report says whether the money column is a bill', /not a bill|list price|list-price/i.test(md));
  check(
    'the report has no mojibake',
    md.indexOf('Ã¢') < 0 && md.indexOf('â\u0080') < 0 && md.indexOf('�') < 0
  );

  // ---- clean up --------------------------------------------------------- //
  if (!opt.keep) {
    for (const d of [dir, privDir, conDir]) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch (_) {
        /* best effort */
      }
    }
  } else {
    process.stdout.write(`\nKept: ${dir}\n      ${privDir}\n      ${conDir}\n`);
  }

  const failed = checks.filter((c) => !c.ok);
  process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
  if (failed.length) {
    process.stdout.write('\nFailed:\n' + failed.map((f) => `  - ${f.name}${f.detail ? `: ${f.detail}` : ''}`).join('\n') + '\n');
  }
  return failed.length ? 1 : 0;
}

let code = 1;
try {
  code = main();
} catch (err) {
  process.stderr.write(`\ntest harness crashed: ${(err && err.stack) || err}\n`);
  code = 1;
}
process.exit(code);
