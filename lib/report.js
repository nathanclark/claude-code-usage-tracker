'use strict';
/**
 * Summarise Claude Code usage from the append-only JSONL logs.
 *
 * Produces a markdown report plus three companion dumps:
 *   1. Skills, slash commands and subagents - used vs. installed-but-never-fired
 *   2. Repeated prompts (mechanical clusters + the full prompt text to theme)
 *   3. Friction - tool failures, denials, permission prompts, interrupts,
 *      corrections, API failures, compactions, long sessions
 *   4. Volume and token weight by project
 *   5. Rules in effect - instruction files loaded, with content hashes
 *
 * Nothing leaves the machine and nothing is written inside a repository.
 *
 * Usage:
 *   node lib/report.js
 *   node lib/report.js --days 7
 *   node lib/report.js --from 2026-09-01 --to 2026-09-30
 */

const fs = require('fs');
const path = require('path');

const { dayStamp, ensureDir, logRoot, num, readConfig, reportDir, resolveBillingMode } = require('./common');
const { buildInventory } = require('./inventory');
const { billingLabels, estimateCost, loadPrices } = require('./pricing');

// --------------------------------------------------------------------------- //
// Arguments
// --------------------------------------------------------------------------- //

function parseArgs(argv) {
  const o = { days: 30, from: null, to: null, outDir: null, topPrompts: 150, maxRows: 30, json: false, quiet: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--days' || a === '-d') o.days = parseInt(next(), 10) || o.days;
    else if (a === '--from') o.from = next();
    else if (a === '--to') o.to = next();
    else if (a === '--out-dir') o.outDir = next();
    else if (a === '--top-prompts') o.topPrompts = parseInt(next(), 10) || o.topPrompts;
    else if (a === '--max-rows') o.maxRows = parseInt(next(), 10) || o.maxRows;
    else if (a === '--json') o.json = true;
    else if (a === '--quiet' || a === '-q') o.quiet = true;
    else if (/^\d+$/.test(a)) o.days = parseInt(a, 10); // bare number = days
  }
  return o;
}

function parseDay(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) throw new Error(`Not a YYYY-MM-DD date: ${s}`);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

// --------------------------------------------------------------------------- //
// Formatting
// --------------------------------------------------------------------------- //

function fmtNum(n) {
  return Math.round(num(n)).toLocaleString('en-US');
}

function pct(n, d) {
  if (!d) return '0%';
  return `${((100 * num(n)) / num(d)).toFixed(1)}%`;
}

function money(n) {
  return `$${num(n).toFixed(2)}`;
}

/** '2026-10-26T15:10:05.123-05:00' -> '2026-10-26 15:10' */
function tsShort(ts) {
  if (!ts) return '';
  return String(ts).slice(0, 16).replace('T', ' ');
}

function oneLine(s, max) {
  let t = String(s === undefined || s === null ? '' : s).replace(/\r?\n/g, ' ');
  if (max && t.length > max) t = t.slice(0, max) + '…';
  return t;
}

/** Keep a value from breaking out of a markdown table cell. */
function cell(s, max) {
  return oneLine(s, max).replace(/\|/g, '\\|');
}

/**
 * A single-element array serialises as a scalar in PowerShell, so logs written
 * by the earlier PowerShell version carry `"correction_hits":"dont"` where this
 * version writes `["dont"]`. Normalise both, or every one-marker correction and
 * every single-model turn is silently dropped from the report.
 */
function asArray(v) {
  if (v === undefined || v === null) return [];
  return (Array.isArray(v) ? v : [v]).filter((x) => x !== null && x !== undefined && x !== '');
}

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}

function byCountDesc(a, b) {
  return b[1].length - a[1].length;
}

// --------------------------------------------------------------------------- //
// Main
// --------------------------------------------------------------------------- //

function run(argv) {
  const opt = parseArgs(argv);
  const cfg = readConfig();
  const root = logRoot();

  const toDate = opt.to ? parseDay(opt.to) : new Date();
  const fromDate = opt.from ? parseDay(opt.from) : new Date(toDate.getTime() - (Math.max(opt.days, 1) - 1) * 86400000);
  if (fromDate > toDate) throw new Error('--from is after --to');
  const rangeLabel = `${dayStamp(fromDate)}_to_${dayStamp(toDate)}`;
  const dayCount = Math.round((parseDay(dayStamp(toDate)) - parseDay(dayStamp(fromDate))) / 86400000) + 1;

  // ---- load ------------------------------------------------------------- //
  const events = [];
  const filesRead = [];
  let badLines = 0;
  for (let d = new Date(fromDate); dayStamp(d) <= dayStamp(toDate); d = new Date(d.getTime() + 86400000)) {
    const file = path.join(root, dayStamp(d) + '.jsonl');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (_) {
      continue;
    }
    filesRead.push(path.basename(file));
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch (_) {
        badLines++;
      }
    }
  }

  const ev = (name) => events.filter((e) => e.event === name);

  // ---- inventory -------------------------------------------------------- //
  const projectRoots = Array.from(new Set(events.map((e) => e.repo_root || e.cwd).filter(Boolean)));
  const inventory = buildInventory(projectRoots);

  // ---- 1. skill / command / agent activity ------------------------------ //
  const use = { skill: new Map(), command: new Map(), agent: new Map() };
  const bump = (m, key, project) => {
    if (!key) return;
    if (!m.has(key)) m.set(key, { count: 0, projects: new Map() });
    const rec = m.get(key);
    rec.count++;
    if (project) rec.projects.set(project, (rec.projects.get(project) || 0) + 1);
  };
  for (const e of events) {
    const proj = e.project;
    if (e.event === 'PostToolUse') {
      if (e.tool_name === 'Skill') bump(use.skill, e.input && e.input.skill, proj);
      else if (e.tool_name === 'Agent' || e.tool_name === 'Task') bump(use.agent, e.input && e.input.subagent_type, proj);
    } else if (e.event === 'UserPromptExpansion') {
      if (e.expansion_type === 'slash_command') bump(use.command, e.command_name, proj);
    } else if (e.event === 'SubagentStart') {
      bump(use.agent, e.subagent_type, proj);
    }
  }

  /** Match "skill", "plugin:skill" and the trailing-segment form. */
  function resolveUsed(m, name) {
    if (!name) return null;
    const n = String(name).toLowerCase();
    for (const [k, v] of m) {
      const kk = String(k).toLowerCase();
      if (kk === n) return v;
      if (kk.endsWith(':' + n) || n.endsWith(':' + kk)) return v;
      if (kk.split(':').pop() === n.split(':').pop()) return v;
    }
    return null;
  }

  // ---- 2. prompts ------------------------------------------------------- //
  const prompts = ev('UserPromptSubmit');

  function normalizePrompt(t) {
    if (!t) return '';
    return String(t)
      .toLowerCase()
      .replace(/[a-z]:\\[^\s"']+/g, ' <path> ')
      .replace(/\/[\w./-]{6,}/g, ' <path> ')
      .replace(/https?:\/\/\S+/g, ' <url> ')
      .replace(/`{1,3}[^`]*`{1,3}/g, ' <code> ')
      .replace(/\d+/g, ' <n> ')
      .replace(/[^a-z<>\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  const promptRows = prompts.map((p) => {
    const txt = String(p.prompt || '');
    const norm = normalizePrompt(txt);
    const w = norm.split(' ').filter(Boolean);
    return {
      ts: p.ts,
      project: p.project,
      session: p.session_id,
      chars: num(p.prompt_chars, txt.length),
      text: txt,
      norm,
      opener: w.slice(0, 6).join(' '),
      hits: asArray(p.correction_hits),
    };
  });

  const openerClusters = Array.from(groupBy(promptRows.filter((r) => r.opener), (r) => r.opener))
    .filter(([, g]) => g.length >= 2)
    .sort(byCountDesc);

  // repeated 4-grams appearing in >= 3 distinct prompts
  const gramDocs = new Map();
  for (const r of promptRows) {
    const w = r.norm.split(' ').filter(Boolean);
    if (w.length < 4) continue;
    const seen = new Set();
    for (let i = 0; i <= w.length - 4; i++) {
      const g = w.slice(i, i + 4).join(' ');
      if (g.indexOf('<') >= 0 || seen.has(g)) continue;
      seen.add(g);
      gramDocs.set(g, (gramDocs.get(g) || 0) + 1);
    }
  }
  const topGrams = Array.from(gramDocs)
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 30);

  // ---- 3. friction ------------------------------------------------------ //
  const failures = ev('PostToolUseFailure');
  const interrupts = failures.filter((f) => f.is_interrupt === true);
  const toolErrors = failures.filter((f) => f.is_interrupt !== true);
  const denied = ev('PermissionDenied');
  const permPrompts = ev('PermissionRequest');
  const apiFails = ev('StopFailure');
  const compactions = ev('PreCompact');
  const corrections = prompts.filter((p) => asArray(p.correction_hits).length > 0);
  const notifs = ev('Notification');
  const postTool = ev('PostToolUse');

  function errorSignature(e) {
    if (!e) return '(none)';
    let s = String(e).split('\n').map((x) => x.trim()).filter(Boolean)[0] || '(none)';
    s = s
      .replace(/[A-Za-z]:\\[^\s"']+/g, '<path>')
      .replace(/\/[\w./-]{6,}/g, '<path>')
      .replace(/\d+/g, '<n>');
    return s.slice(0, 120).trim();
  }

  const errSig = Array.from(
    groupBy(toolErrors, (f) => `${f.tool_name} | ${errorSignature(f.error)}`)
  ).sort(byCountDesc);

  // retries: same tool + same input summary, twice within 5 minutes, one session
  const calls = [];
  for (const t of postTool.concat(toolErrors)) {
    const inp = t.input;
    let k = '';
    if (inp && typeof inp === 'object') {
      k = Object.keys(inp)
        .sort()
        .map((n) => `${n}=${inp[n]}`)
        .join('|');
    }
    const ms = Date.parse(t.ts);
    if (Number.isNaN(ms)) continue;
    calls.push({ ms, session: t.session_id, project: t.project, key: `${t.tool_name}::${k}` });
  }
  const retryGroups = Array.from(groupBy(calls.filter((c) => !/::$/.test(c.key)), (c) => `${c.session}::${c.key}`))
    .filter(([, g]) => g.length >= 2)
    .map(([, g]) => {
      const o = g.slice().sort((a, b) => a.ms - b.ms);
      return {
        key: o[0].key,
        project: o[0].project,
        count: g.length,
        spanMin: Math.round(((o[o.length - 1].ms - o[0].ms) / 60000) * 10) / 10,
      };
    })
    .filter((r) => r.spanMin <= 5)
    .sort((a, b) => b.count - a.count);

  // ---- 4. volume and weight by project ---------------------------------- //
  const prices = loadPrices();
  const billing = resolveBillingMode(cfg);
  const labels = billingLabels(billing.mode, billing.source);

  const sessions = new Map();
  for (const e of events) {
    const sid = e.session_id;
    if (!sid) continue;
    if (!sessions.has(sid)) {
      sessions.set(sid, {
        session_id: sid,
        project: e.project,
        branch: e.branch,
        first: e.ts,
        last: e.ts,
        turns: 0,
        tools: 0,
        failures: 0,
        denials: 0,
        prompts: 0,
        compactions: 0,
        tokens: { input: 0, output: 0, cache_read: 0, cache_creation: 0, thinking: 0, requests: 0 },
        cost: 0,
        models: new Set(),
        source: null,
        end_reason: null,
      });
    }
    const s = sessions.get(sid);
    if (e.ts < s.first) s.first = e.ts;
    if (e.ts > s.last) s.last = e.ts;
    if (!s.project && e.project) s.project = e.project;

    switch (e.event) {
      case 'SessionStart':
        s.source = e.source;
        break;
      case 'SessionEnd':
        s.end_reason = e.reason;
        break;
      case 'UserPromptSubmit':
        s.prompts++;
        break;
      case 'PostToolUse':
        s.tools++;
        break;
      case 'PostToolUseFailure':
        s.failures++;
        break;
      case 'PermissionDenied':
        s.denials++;
        break;
      case 'PreCompact':
        s.compactions++;
        break;
      case 'Stop': {
        s.turns++;
        const d = e.tokens_delta;
        if (d) {
          for (const k of ['input', 'output', 'cache_read', 'cache_creation', 'thinking', 'requests']) {
            s.tokens[k] += num(d[k]);
          }
          for (const m of asArray(e.models)) s.models.add(String(m));
          // A turn can span models, and they are not priced alike. Price each
          // model's share at its own rate when the log carries the breakdown.
          const bym = e.tokens_by_model;
          if (bym && typeof bym === 'object' && Object.keys(bym).length) {
            for (const m of Object.keys(bym)) s.cost += estimateCost(prices, bym[m], m);
          } else {
            const m0 = asArray(e.models).length ? String(asArray(e.models)[0]) : 'unknown';
            s.cost += estimateCost(prices, d, m0);
          }
        }
        break;
      }
      default:
        break;
    }
  }

  const sessionRows = Array.from(sessions.values()).map((s) => {
    const a = Date.parse(s.first);
    const b = Date.parse(s.last);
    const minutes = Number.isNaN(a) || Number.isNaN(b) ? 0 : Math.round(((b - a) / 60000) * 10) / 10;
    return {
      session_id: s.session_id,
      project: s.project || '(none)',
      branch: s.branch,
      start: s.first,
      minutes,
      turns: s.turns,
      prompts: s.prompts,
      tools: s.tools,
      failures: s.failures,
      denials: s.denials,
      compactions: s.compactions,
      tokens_total: s.tokens.input + s.tokens.output + s.tokens.cache_read + s.tokens.cache_creation,
      input: s.tokens.input,
      output: s.tokens.output,
      cache_read: s.tokens.cache_read,
      cache_creation: s.tokens.cache_creation,
      requests: s.tokens.requests,
      cost: Math.round(s.cost * 100) / 100,
      models: Array.from(s.models).sort().join(','),
      source: s.source,
      end_reason: s.end_reason,
    };
  });

  const sum = (arr, k) => arr.reduce((t, x) => t + num(x[k]), 0);

  const projectRows = Array.from(groupBy(sessionRows, (s) => s.project))
    .map(([name, g]) => ({
      project: name,
      sessions: g.length,
      turns: sum(g, 'turns'),
      prompts: sum(g, 'prompts'),
      tools: sum(g, 'tools'),
      failures: sum(g, 'failures'),
      denials: sum(g, 'denials'),
      hours: Math.round((sum(g, 'minutes') / 60) * 10) / 10,
      tokens: sum(g, 'tokens_total'),
      output: sum(g, 'output'),
      cost: Math.round(sum(g, 'cost') * 100) / 100,
    }))
    .sort((a, b) => b.tokens - a.tokens);

  // ---- 5. rules in effect ----------------------------------------------- //
  const rules = Array.from(groupBy(ev('InstructionsLoaded'), (r) => r.file_path || '(unknown)'))
    .map(([file, g]) => {
      const ordered = g.slice().sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
      const hashes = Array.from(new Set(g.map((x) => x.content_sha256).filter(Boolean)));
      const last = ordered[ordered.length - 1];
      return {
        file_path: file,
        memory_type: Array.from(new Set(g.map((x) => x.memory_type).filter(Boolean))).join(','),
        loads: g.length,
        sessions: new Set(g.map((x) => x.session_id)).size,
        projects: Array.from(new Set(g.map((x) => x.project).filter(Boolean))).join(','),
        distinct_versions: hashes.length,
        last_hash: hashes.length ? hashes[hashes.length - 1].slice(0, 12) : '',
        last_loaded: last ? last.ts : '',
        size_bytes: last ? last.size_bytes : null,
      };
    })
    .sort((a, b) => b.loads - a.loads);

  // ---- markdown --------------------------------------------------------- //
  const outDir = opt.outDir || reportDir();
  ensureDir(outDir);
  const reportPath = path.join(outDir, `usage-report-${rangeLabel}.md`);
  const promptsPath = path.join(outDir, `prompts-${rangeLabel}.txt`);
  const frictionPath = path.join(outDir, `friction-${rangeLabel}.txt`);
  const inventoryPath = path.join(outDir, `inventory-${rangeLabel}.txt`);

  const out = [];
  const W = (s) => out.push(s === undefined ? '' : s);

  const totalTokens = sum(sessionRows, 'tokens_total');
  const totalCost = Math.round(sum(sessionRows, 'cost') * 100) / 100;

  W('# Claude Code usage report');
  W('');
  W(`**Range:** ${dayStamp(fromDate)} to ${dayStamp(toDate)}  (${dayCount} day(s))`);
  W(`**Generated:** ${new Date().toString().slice(0, 33)}`);
  W(`**Log files read:** ${filesRead.length}${badLines ? ` (skipped ${badLines} unparseable line(s))` : ''}`);
  if (!cfg.capture_prompt_text) {
    W('');
    W('> Prompt text capture is **off** (`capture_prompt_text: false`), so sections 2 and the prompt dump are empty by design.');
  }
  W('');
  W('## At a glance');
  W('');
  W('| Metric | Value |');
  W('|---|---|');
  W(`| Sessions | ${fmtNum(sessionRows.length)} |`);
  W(`| Turns (assistant replies) | ${fmtNum(sum(sessionRows, 'turns'))} |`);
  W(`| Prompts submitted | ${fmtNum(prompts.length)} |`);
  W(`| Tool calls | ${fmtNum(postTool.length)} |`);
  W(`| Tool failures | ${fmtNum(toolErrors.length)} (${pct(toolErrors.length, postTool.length + toolErrors.length)} of tool calls) |`);
  W(`| Interrupted tool calls | ${fmtNum(interrupts.length)} |`);
  W(`| Permission prompts | ${fmtNum(permPrompts.length)} |`);
  W(`| Permission denials | ${fmtNum(denied.length)} |`);
  W(`| Correction-style prompts | ${fmtNum(corrections.length)} (${pct(corrections.length, prompts.length)} of prompts) |`);
  W(`| API failures (StopFailure) | ${fmtNum(apiFails.length)} |`);
  W(`| Compactions | ${fmtNum(compactions.length)} |`);
  W(`| Tokens (all kinds) | ${fmtNum(totalTokens)} |`);
  W(`| ${labels.headline} | ${money(totalCost)} |`);
  W('');

  // ---- 1 ----
  W('## 1. Skills, slash commands and subagents');
  W('');
  const neverByKind = {};
  for (const kind of ['skill', 'command', 'agent']) {
    const dict = use[kind];
    const label = { skill: 'Skills (Skill tool)', command: 'Slash commands', agent: 'Subagents' }[kind];
    const installed = inventory.filter((i) => i.kind === kind);

    W(`### ${label}`);
    W('');
    if (dict.size === 0) {
      W('_Nothing fired in this range._');
    } else {
      W('| Name | Fires | Projects |');
      W('|---|---:|---|');
      for (const [k, v] of Array.from(dict).sort((a, b) => b[1].count - a[1].count)) {
        const projs = Array.from(v.projects)
          .sort((a, b) => b[1] - a[1])
          .map(([p, c]) => `${p} (${c})`)
          .join(', ');
        W(`| \`${cell(k)}\` | ${v.count} | ${cell(projs)} |`);
      }
    }
    W('');
    const never = installed.filter((i) => !resolveUsed(dict, i.name));
    neverByKind[kind] = never;
    W(`**Installed but never fired in this range: ${never.length} of ${installed.length}**`);
    W('');
    if (never.length) {
      W(`First ${Math.min(opt.maxRows, never.length)} by name (full list in \`${path.basename(inventoryPath)}\`):`);
      W('');
      W('| Name | Scope | Description (first line) |');
      W('|---|---|---|');
      for (const n of never.slice().sort((a, b) => a.name.localeCompare(b.name)).slice(0, opt.maxRows)) {
        W(`| \`${cell(n.name)}\` | ${cell(n.scopes.join(','))} | ${n.description ? cell(n.description, 110) : '_(no description)_'} |`);
      }
      if (never.length > opt.maxRows) {
        W('');
        W(`_…and ${never.length - opt.maxRows} more — see \`${path.basename(inventoryPath)}\`._`);
      }
    }
    W('');
  }

  // ---- 2 ----
  W('## 2. Repeated prompts (skill candidates)');
  W('');
  W(`${prompts.length} prompts captured. Full text is in \`${path.basename(promptsPath)}\` for thematic clustering.`);
  W('');
  W('### Repeated openings (same first 6 normalised words, 2+ times)');
  W('');
  if (!openerClusters.length) {
    W('_No repeated openings._');
  } else {
    W('| Count | Opening | Example |');
    W('|---:|---|---|');
    for (const [opener, g] of openerClusters.slice(0, 25)) {
      W(`| ${g.length} | \`${cell(opener)}\` | ${cell(g[0].text, 110)} |`);
    }
  }
  W('');
  W('### Phrases recurring across 3+ prompts');
  W('');
  if (!topGrams.length) {
    W('_No recurring phrases._');
  } else {
    W('| Prompts | Phrase |');
    W('|---:|---|');
    for (const [g, c] of topGrams) W(`| ${c} | \`${cell(g)}\` |`);
  }
  W('');
  W('### Longest prompts (often worth turning into a skill or a rule)');
  W('');
  W('| Chars | Project | When | Opening |');
  W('|---:|---|---|---|');
  for (const p of promptRows.slice().sort((a, b) => b.chars - a.chars).slice(0, 10)) {
    W(`| ${fmtNum(p.chars)} | ${cell(p.project)} | ${tsShort(p.ts)} | ${cell(p.text, 100)} |`);
  }
  W('');

  // ---- 3 ----
  W('## 3. Friction and corrections');
  W('');
  W('### Tool failures by signature');
  W('');
  if (!errSig.length) {
    W('_No tool failures._');
  } else {
    W('| Count | Tool / first error line |');
    W('|---:|---|');
    for (const [sig, g] of errSig.slice(0, 25)) W(`| ${g.length} | \`${cell(sig)}\` |`);
  }
  W('');
  W('### Failures by tool');
  W('');
  const callsByTool = new Map();
  for (const t of postTool) callsByTool.set(String(t.tool_name), (callsByTool.get(String(t.tool_name)) || 0) + 1);
  const byTool = Array.from(groupBy(toolErrors, (f) => String(f.tool_name))).sort(byCountDesc);
  if (!byTool.length) {
    W('_None._');
  } else {
    W('| Tool | Failures | Calls | Failure rate |');
    W('|---|---:|---:|---:|');
    for (const [tool, g] of byTool) {
      const total = (callsByTool.get(tool) || 0) + g.length;
      W(`| ${cell(tool)} | ${g.length} | ${total} | ${pct(g.length, total)} |`);
    }
  }
  W('');
  W('### Permission friction');
  W('');
  const topTools = (arr) =>
    Array.from(groupBy(arr, (x) => String(x.tool_name)))
      .sort(byCountDesc)
      .slice(0, 5)
      .map(([t, g]) => `${t} (${g.length})`)
      .join(', ');
  W('| Kind | Count | Top tools |');
  W('|---|---:|---|');
  W(`| Permission prompts | ${permPrompts.length} | ${cell(topTools(permPrompts))} |`);
  W(`| Denials | ${denied.length} | ${cell(topTools(denied))} |`);
  W('');
  if (denied.length) {
    W('Denial reasons:');
    W('');
    for (const [reason, g] of Array.from(groupBy(denied, (d) => String(d.reason || '(none)'))).sort(byCountDesc).slice(0, 10)) {
      W(`- ${g.length} × \`${cell(reason)}\``);
    }
    W('');
  }
  W('### Correction-style prompts');
  W('');
  const hitCounts = new Map();
  for (const c of corrections) {
    for (const h of asArray(c.correction_hits)) hitCounts.set(String(h), (hitCounts.get(String(h)) || 0) + 1);
  }
  if (!hitCounts.size) {
    W('_None detected._');
  } else {
    W('| Marker | Prompts |');
    W('|---|---:|');
    for (const [h, c] of Array.from(hitCounts).sort((a, b) => b[1] - a[1])) W(`| ${h} | ${c} |`);
    W('');
    W(`Full correction prompts are in \`${path.basename(frictionPath)}\` for thematic grouping.`);
  }
  W('');
  W('### Immediate retries (same tool + same input twice within 5 min)');
  W('');
  if (!retryGroups.length) {
    W('_None._');
  } else {
    W('| Times | Span (min) | Project | Call |');
    W('|---:|---:|---|---|');
    for (const r of retryGroups.slice(0, 15)) {
      W(`| ${r.count} | ${r.spanMin} | ${cell(r.project)} | \`${oneLine(r.key, 110).replace(/\|/g, '/')}\` |`);
    }
  }
  W('');
  W('### Interrupts, API failures and compaction');
  W('');
  W(`- Interrupted tool calls: **${interrupts.length}**`);
  let apiKinds = '';
  if (apiFails.length) {
    apiKinds =
      ' — ' +
      Array.from(groupBy(apiFails, (f) => String(f.error || f.reason || 'unknown')))
        .sort(byCountDesc)
        .map(([k, g]) => `${k} (${g.length})`)
        .join(', ');
  }
  W(`- API failures ending a turn: **${apiFails.length}**${apiKinds}`);
  W(`- Compactions: **${compactions.length}**`);
  W(`- Idle / permission notifications: **${notifs.filter((n) => n.friction === 'waiting_on_user').length}**`);
  W('');
  W('### Longest sessions');
  W('');
  W('| Minutes | Turns | Tools | Fails | Project | Session | Compactions |');
  W('|---:|---:|---:|---:|---|---|---:|');
  for (const s of sessionRows.slice().sort((a, b) => b.minutes - a.minutes).slice(0, 10)) {
    W(`| ${s.minutes} | ${s.turns} | ${s.tools} | ${s.failures} | ${cell(s.project)} | \`${String(s.session_id).slice(0, 8)}\` | ${s.compactions} |`);
  }
  W('');

  // ---- 4 ----
  W('## 4. Volume and weight by project');
  W('');
  W(`| Project | Sessions | Turns | Prompts | Tool calls | Fails | Hours | Tokens | Output tok | ${labels.label} |`);
  W('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const p of projectRows) {
    W(
      `| ${cell(p.project)} | ${p.sessions} | ${p.turns} | ${p.prompts} | ${p.tools} | ${p.failures} | ${p.hours} | ` +
        `${fmtNum(p.tokens)} | ${fmtNum(p.output)} | ${money(p.cost)} |`
    );
  }
  W('');
  W('### Heaviest sessions by tokens');
  W('');
  W(`| Tokens | ${labels.label} | Turns | Minutes | Project | Models | Start |`);
  W('|---:|---:|---:|---:|---|---|---|');
  for (const s of sessionRows.slice().sort((a, b) => b.tokens_total - a.tokens_total).slice(0, 10)) {
    W(
      `| ${fmtNum(s.tokens_total)} | ${money(s.cost)} | ${s.turns} | ${s.minutes} | ${cell(s.project)} | ` +
        `${cell(s.models)} | ${tsShort(s.start)} |`
    );
  }
  W('');
  W(
    '_Token counts come from the session transcript (`message.usage`), de-duplicated by message id, and priced per model per turn (a turn that spans models is split). Rates come from `lib/prices.json`; refresh them with `node scripts/update-prices.js`._'
  );
  W('');
  W(labels.note);
  W('');

  // ---- 5 ----
  W('## 5. Rules in effect');
  W('');
  if (!rules.length) {
    W('_No InstructionsLoaded events in this range._');
  } else {
    W('| File | Type | Loads | Sessions | Versions seen | Last hash | Bytes | Last loaded |');
    W('|---|---|---:|---:|---:|---|---:|---|');
    for (const r of rules) {
      W(
        `| \`${cell(r.file_path)}\` | ${cell(r.memory_type)} | ${r.loads} | ${r.sessions} | ${r.distinct_versions} | ` +
          `\`${r.last_hash}\` | ${fmtNum(r.size_bytes)} | ${tsShort(r.last_loaded)} |`
      );
    }
    W('');
    const churn = rules.filter((r) => r.distinct_versions > 1);
    if (churn.length) {
      W('Files whose content changed during the range (more than one hash seen):');
      W('');
      for (const c of churn) W(`- \`${cell(c.file_path)}\` — ${c.distinct_versions} versions`);
      W('');
    }
  }

  W('## Recommendations');
  W('');
  W(
    `_Mechanical findings are above. Thematic clustering and concrete recommendations are appended by the \`/usage-tracker:report\` slash command, which reads \`${path.basename(
      promptsPath
    )}\` and \`${path.basename(frictionPath)}\`._`
  );
  W('');

  fs.writeFileSync(reportPath, out.join('\n'), 'utf8');

  // ---- companion dumps -------------------------------------------------- //
  const pb = [`# All prompts ${rangeLabel} (newest last). Format: [ts] [project] text`, ''];
  for (const p of promptRows.slice(-opt.topPrompts)) {
    pb.push(`[${tsShort(p.ts)}] [${p.project || '-'}] ${String(p.text).replace(/\r?\n/g, ' ⏎ ')}`);
  }
  fs.writeFileSync(promptsPath, pb.join('\n') + '\n', 'utf8');

  const byTs = (a, b) => String(a.ts).localeCompare(String(b.ts));
  const fb = [`# Friction lines ${rangeLabel}`, '', '## Correction prompts'];
  for (const c of corrections.slice().sort(byTs)) {
    fb.push(
      `[${tsShort(c.ts)}] [${c.project || '-'}] (${asArray(c.correction_hits).join('+')}) ${String(
        c.prompt || ''
      ).replace(/\r?\n/g, ' ⏎ ')}`
    );
  }
  fb.push('', '## Tool failures');
  for (const f of toolErrors.slice().sort(byTs)) {
    fb.push(`[${tsShort(f.ts)}] [${f.project || '-'}] ${f.tool_name}: ${String(f.error || '').replace(/\r?\n/g, ' ⏎ ')}`);
  }
  fb.push('', '## Permission denials');
  for (const f of denied.slice().sort(byTs)) {
    fb.push(`[${tsShort(f.ts)}] [${f.project || '-'}] ${f.tool_name}: ${f.reason || ''}`);
  }
  fs.writeFileSync(frictionPath, fb.join('\n') + '\n', 'utf8');

  const ib = [
    `# Installed skills / commands / subagents ${rangeLabel}`,
    '# fires = times it fired in this range. 0 = candidate to prune or re-describe.',
    '',
  ];
  for (const kind of ['skill', 'command', 'agent']) {
    ib.push(`## ${kind}`);
    for (const item of inventory.filter((i) => i.kind === kind).sort((a, b) => a.name.localeCompare(b.name))) {
      const u = resolveUsed(use[kind], item.name);
      ib.push(`fires=${String(u ? u.count : 0).padEnd(4)} scope=${item.scopes.join(',').padEnd(22)} name=${item.name}`);
      ib.push(`                 desc: ${item.description || ''}`);
      ib.push(`                 path: ${item.paths.join('; ')}`);
    }
    ib.push('');
  }
  fs.writeFileSync(inventoryPath, ib.join('\n'), 'utf8');

  if (opt.json) {
    const jsonPath = path.join(outDir, `usage-report-${rangeLabel}.json`);
    const dictToObj = (m) => {
      const o = {};
      for (const [k, v] of m) o[k] = { count: v.count, projects: Object.fromEntries(v.projects) };
      return o;
    };
    fs.writeFileSync(
      jsonPath,
      JSON.stringify(
        {
          range: { from: dayStamp(fromDate), to: dayStamp(toDate) },
          billing: billing,
          totals: {
            sessions: sessionRows.length,
            prompts: prompts.length,
            tool_calls: postTool.length,
            failures: toolErrors.length,
            tokens: totalTokens,
            cost: totalCost,
          },
          skills: dictToObj(use.skill),
          commands: dictToObj(use.command),
          agents: dictToObj(use.agent),
          inventory,
          projects: projectRows,
          sessions_detail: sessionRows,
          rules,
        },
        null,
        2
      ),
      'utf8'
    );
  }

  if (!opt.quiet) {
    process.stdout.write(`REPORT   : ${reportPath}\n`);
    process.stdout.write(`PROMPTS  : ${promptsPath}\n`);
    process.stdout.write(`FRICTION : ${frictionPath}\n`);
    process.stdout.write(`INVENTORY: ${inventoryPath}\n`);
    process.stdout.write(
      `EVENTS   : ${events.length} across ${filesRead.length} log file(s); ${sessionRows.length} session(s)\n`
    );
  }

  return { reportPath, promptsPath, frictionPath, inventoryPath, events: events.length, sessions: sessionRows.length };
}

if (require.main === module) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`usage-report failed: ${(err && err.message) || err}\n`);
    process.exit(1);
  }
}

module.exports = { run };
