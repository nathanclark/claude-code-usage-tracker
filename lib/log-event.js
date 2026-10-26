'use strict';
/**
 * The hook handler: one entry point for every event the plugin subscribes to.
 *
 * Contract, which the test harness asserts:
 *   * reads the hook payload as JSON on stdin
 *   * appends exactly one JSON line to <log root>/YYYY-MM-DD.jsonl
 *   * writes NOTHING to stdout, so Claude never sees it
 *   * always exits 0
 *   * any failure is swallowed and appended to <log root>/hook-errors.log
 *
 * Every hook is registered with "async": true, so Claude Code starts this
 * process and carries on without waiting for it.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  appendJsonl,
  compact,
  dayStamp,
  localIso,
  logHookError,
  logRoot,
  num,
  readConfig,
  repoInfo,
  trunc,
} = require('./common');
const { newState, readState, updateUsage, writeState } = require('./transcript');

const COMMON_FIELDS = new Set([
  'session_id',
  'transcript_path',
  'cwd',
  'hook_event_name',
  'permission_mode',
  'effort',
  'prompt_id',
  'scratchpad_dir',
  'agent_id',
  'agent_type',
]);

// Cheap markers for "this prompt was correcting Claude". The full text is kept
// too; these just make the report's query trivial.
const CORRECTION_PATTERNS = [
  ['no', /^\s*(no|nope|nah)\b/im],
  ['stop', /^\s*(stop|halt|hold on|wait)\b/im],
  ['actually', /\bactually\b/i],
  ['thats-wrong', /\bthat(?:'|’)?s (?:wrong|not right|incorrect|not what)\b/i],
  ['wrong', /\b(wrong|incorrect)\b/i],
  ['undo', /\b(undo|revert|roll ?back|put it back)\b/i],
  ['not-what', /\bnot what i (asked|wanted|meant|said)\b/i],
  ['i-said', /\bi (said|told you|asked for)\b/i],
  ['you-broke', /\byou (broke|missed|forgot|removed|deleted|changed)\b/i],
  ['still-broken', /\bstill (broken|failing|wrong|not working|doesn)\b/i],
  ['doesnt-work', /\b(does ?n(?:'|’)?t work|not working|didn(?:'|’)?t work)\b/i],
  ['try-again', /\b(try again|again please|redo)\b/i],
  ['dont', /\b(don(?:'|’)?t|do not) (do|use|change|touch|add)\b/i],
];

function correctionHits(text) {
  if (!text || !text.trim()) return [];
  const probe = text.length > 2000 ? text.slice(0, 2000) : text;
  const hits = [];
  for (const [name, re] of CORRECTION_PATTERNS) {
    if (re.test(probe)) hits.push(name);
  }
  return hits;
}

/**
 * Enough of a tool call to analyse usage, small enough to keep for months.
 * Values are summarised rather than dumped, except where the text is the point
 * (a Bash command, a search pattern, a skill or agent name). Anything
 * unrecognised, MCP tools included, contributes key names only - never values.
 */
function toolSummary(toolName, toolInput) {
  const s = {};
  if (!toolInput || typeof toolInput !== 'object') return s;
  const n = String(toolName || '');

  if (n === 'Skill') {
    s.skill = toolInput.skill;
    s.args = trunc(toolInput.args, 200);
  } else if (n === 'Agent' || n === 'Task') {
    s.subagent_type = toolInput.subagent_type;
    s.description = trunc(toolInput.description, 200);
    s.model = toolInput.model;
    s.prompt_chars = String(toolInput.prompt || '').length;
  } else if (n === 'Bash' || n === 'PowerShell') {
    s.command = trunc(toolInput.command, 500);
    s.description = trunc(toolInput.description, 200);
    s.background = toolInput.run_in_background;
  } else if (n === 'Read' || n === 'Write' || n === 'Edit' || n === 'NotebookEdit') {
    s.file_path = trunc(toolInput.file_path, 400);
  } else if (n === 'Glob' || n === 'Grep') {
    s.pattern = trunc(toolInput.pattern, 200);
    s.path = trunc(toolInput.path, 300);
    s.glob = trunc(toolInput.glob, 120);
  } else if (n === 'WebFetch') {
    s.url = trunc(toolInput.url, 300);
  } else if (n === 'WebSearch' || n === 'ToolSearch') {
    s.query = trunc(toolInput.query, 300);
  } else if (n === 'SlashCommand') {
    s.command = trunc(toolInput.command, 200);
  } else {
    try {
      s.input_keys = Object.keys(toolInput);
    } catch (_) {
      /* ignore */
    }
  }
  return compact(s);
}

/** Copy scalar payload fields we have no specific handling for. */
function copyScalars(payload, target) {
  for (const k of Object.keys(payload)) {
    if (COMMON_FIELDS.has(k)) continue;
    const v = payload[k];
    const t = typeof v;
    if (t === 'string' || t === 'number' || t === 'boolean') target[k] = trunc(v, 600);
  }
}

function hashFile(filePath, target) {
  try {
    const st = fs.statSync(filePath);
    if (!st.isFile()) return;
    target.size_bytes = st.size;
    target.modified = localIso(st.mtime);
    if (st.size > 4 * 1024 * 1024) return; // not an instructions file; don't read it
    const buf = fs.readFileSync(filePath);
    target.content_sha256 = crypto.createHash('sha256').update(buf).digest('hex');
  } catch (_) {
    /* ignore */
  }
}

function pickTokens(d) {
  return {
    input: num(d.input),
    output: num(d.output),
    cache_read: num(d.cache_read),
    cache_creation: num(d.cache_creation),
    cache_creation_5m: num(d.cache_creation_5m),
    cache_creation_1h: num(d.cache_creation_1h),
    thinking: num(d.thinking),
    requests: num(d.requests),
  };
}

function main() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch (err) {
    logHookError('read-stdin', err);
    return;
  }
  if (!raw || !raw.trim()) return;

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    logHookError('parse-stdin', err);
    return;
  }

  const cfg = readConfig();
  const evt = String(payload.hook_event_name || 'Unknown');
  const sid = payload.session_id ? String(payload.session_id) : '';
  const cwd = payload.cwd ? String(payload.cwd) : '';
  const tpath = payload.transcript_path ? String(payload.transcript_path) : '';
  const repo = repoInfo(cwd);
  const now = new Date();

  const e = {
    ts: localIso(now),
    event: evt,
    session_id: sid,
    cwd,
    project: repo.project,
    repo_root: repo.repo_root,
    branch: repo.branch,
  };
  for (const opt of ['prompt_id', 'permission_mode', 'effort', 'agent_id', 'agent_type', 'session_title']) {
    if (payload[opt] !== undefined && payload[opt] !== null && payload[opt] !== '') e[opt] = payload[opt];
  }

  const scanLimit = num(cfg.max_scan_bytes, 64 * 1024 * 1024);

  switch (evt) {
    case 'SessionStart': {
      const src = payload.source ? String(payload.source) : '';
      e.source = src;
      e.model = payload.model;
      e.context_tokens = payload.context_tokens;
      e.seconds_since_last_response = payload.seconds_since_last_response;
      e.transcript_path = tpath;
      // Baseline the scan at EOF for an inherited transcript.
      const baseline = ['resume', 'fork', 'compact', 'clear'].indexOf(src) >= 0;
      let st = readState(sid);
      if (!st) st = newState(sid, tpath, baseline);
      else st.transcript_path = tpath;
      writeState(sid, st);
      break;
    }

    case 'SessionEnd': {
      e.reason = payload.reason;
      let st = readState(sid);
      if (!st) st = newState(sid, tpath, false);
      // SessionEnd hooks share a 1.5s budget and a plugin's own `timeout` does
      // not raise it, so keep the closing scan small. Nothing is lost if it is
      // skipped: Stop already wrote cumulative totals for every turn.
      updateUsage(st, tpath, Math.min(scanLimit, 8 * 1024 * 1024));
      writeState(sid, st);
      e.turns = st.turns;
      e.requests = st.requests;
      e.tokens = st.totals;
      e.by_model = st.by_model;
      e.started = st.started;
      const started = Date.parse(st.started);
      if (!Number.isNaN(started)) e.duration_sec = Math.round((now.getTime() - started) / 1000);
      break;
    }

    case 'Stop': {
      let st = readState(sid);
      if (!st) st = newState(sid, tpath, false);
      const d = updateUsage(st, tpath, scanLimit);
      st.turns = num(st.turns) + 1;
      writeState(sid, st);
      e.turn = st.turns;
      e.stop_hook_active = payload.stop_hook_active;
      e.reply_chars = String(payload.last_assistant_message || '').length;
      e.tokens_delta = pickTokens(d);
      e.models = d.models;
      e.tokens_by_model = d.by_model;
      e.tokens_total = st.totals;
      if (Array.isArray(payload.background_tasks) && payload.background_tasks.length) {
        e.background_tasks = payload.background_tasks.length;
      }
      break;
    }

    case 'StopFailure': {
      // An API-level failure ended the turn: rate limit, overload, auth, etc.
      copyScalars(payload, e);
      e.friction = 'api_failure';
      break;
    }

    case 'UserPromptSubmit': {
      const p = String(payload.prompt || '');
      if (cfg.capture_prompt_text) e.prompt = p; // full text, local only
      else e.prompt_captured = false;
      e.prompt_chars = p.length;
      e.prompt_words = p.split(/\s+/).filter(Boolean).length;
      const hits = correctionHits(p);
      if (hits.length) {
        e.correction_hits = hits;
        e.friction = 'correction_signal';
      }
      break;
    }

    case 'UserPromptExpansion': {
      e.expansion_type = payload.expansion_type;
      e.command_name = payload.command_name;
      e.command_args = trunc(payload.command_args, 300);
      e.command_source = payload.command_source;
      if (cfg.capture_prompt_text) e.prompt = trunc(payload.prompt, 1000);
      break;
    }

    case 'PostToolUse': {
      e.tool_name = payload.tool_name;
      e.tool_use_id = payload.tool_use_id;
      e.duration_ms = payload.duration_ms;
      e.mcp_server = payload.mcp_server;
      e.input = toolSummary(payload.tool_name, payload.tool_input);
      break;
    }

    case 'PostToolUseFailure': {
      e.tool_name = payload.tool_name;
      e.tool_use_id = payload.tool_use_id;
      e.duration_ms = payload.duration_ms;
      e.mcp_server = payload.mcp_server;
      e.is_interrupt = payload.is_interrupt;
      e.error = trunc(payload.error, 1200);
      e.input = toolSummary(payload.tool_name, payload.tool_input);
      e.friction = payload.is_interrupt === true ? 'interrupt' : 'tool_failure';
      break;
    }

    case 'PermissionRequest': {
      e.tool_name = payload.tool_name;
      e.mcp_server = payload.mcp_server;
      e.input = toolSummary(payload.tool_name, payload.tool_input);
      e.friction = 'permission_prompt';
      break;
    }

    case 'PermissionDenied': {
      e.tool_name = payload.tool_name;
      e.tool_use_id = payload.tool_use_id;
      e.mcp_server = payload.mcp_server;
      e.reason = trunc(payload.reason, 400);
      e.input = toolSummary(payload.tool_name, payload.tool_input);
      e.friction = 'permission_denied';
      break;
    }

    case 'SubagentStart': {
      e.subagent_type = payload.agent_type;
      const st = readState(sid);
      const aid = payload.agent_id ? String(payload.agent_id) : '';
      if (st && aid) {
        if (!st.subagents || typeof st.subagents !== 'object') st.subagents = {};
        st.subagents[aid] = localIso(now);
        writeState(sid, st);
      }
      break;
    }

    case 'SubagentStop': {
      e.subagent_type = payload.agent_type;
      e.agent_transcript_path = payload.agent_transcript_path;
      e.reply_chars = String(payload.last_assistant_message || '').length;
      const st = readState(sid);
      const aid = payload.agent_id ? String(payload.agent_id) : '';
      if (st && aid && st.subagents && st.subagents[aid]) {
        const started = Date.parse(st.subagents[aid]);
        if (!Number.isNaN(started)) e.duration_sec = Math.round((now.getTime() - started) / 1000);
      }
      break;
    }

    case 'InstructionsLoaded': {
      const fp = payload.file_path ? String(payload.file_path) : '';
      e.file_path = fp;
      e.memory_type = payload.memory_type;
      e.load_reason = payload.load_reason;
      if (fp) hashFile(fp, e);
      break;
    }

    case 'Notification': {
      e.notification_type = payload.notification_type;
      e.title = trunc(payload.title, 200);
      e.message = trunc(payload.message, 400);
      if (['permission_prompt', 'idle_prompt'].indexOf(String(payload.notification_type)) >= 0) {
        e.friction = 'waiting_on_user';
      }
      break;
    }

    case 'PreCompact': {
      e.trigger = payload.trigger;
      e.custom_instructions = trunc(payload.custom_instructions, 600);
      e.friction = 'context_pressure';
      break;
    }

    default: {
      copyScalars(payload, e);
      break;
    }
  }

  const file = path.join(logRoot(), dayStamp(now) + '.jsonl');
  appendJsonl(file, JSON.stringify(compact(e)));
}

try {
  main();
} catch (err) {
  logHookError('main', err);
}
process.exit(0);
