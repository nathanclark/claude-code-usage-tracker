'use strict';
/**
 * Shared helpers for the usage tracker: paths, config, timestamps, the
 * concurrency-safe JSONL append, and git/project resolution.
 *
 * Zero dependencies on purpose. Claude Code runs on Node, so this is the one
 * runtime every machine that can run the hooks already has.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

// --------------------------------------------------------------------------- //
// Paths
// --------------------------------------------------------------------------- //

function claudeHome() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
}

/**
 * Logs live next to the user's other Claude Code data rather than in the
 * plugin directory: ${CLAUDE_PLUGIN_ROOT} is a per-version cache that changes
 * on every plugin update, so nothing durable may be written there.
 */
function logRoot() {
  return process.env.CC_USAGE_LOG_DIR || path.join(claudeHome(), 'usage-log');
}

function stateRoot() {
  return path.join(logRoot(), '.state');
}

function reportDir() {
  return path.join(logRoot(), 'reports');
}

function errorLogPath() {
  return path.join(logRoot(), 'hook-errors.log');
}

function ensureDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    /* ignore */
  }
}

// --------------------------------------------------------------------------- //
// Config
// --------------------------------------------------------------------------- //

const DEFAULT_CONFIG = {
  // Full prompt text is the input for "what do I keep asking for". It never
  // leaves the machine. Set false to log only length and correction markers.
  capture_prompt_text: true,
  // 'auto' | 'subscription' | 'metered' - see detectBillingMode().
  billing_mode: 'auto',
  // Hard ceiling on one incremental transcript scan, so a single hook can
  // never turn into a long read.
  max_scan_bytes: 64 * 1024 * 1024,
};

function truthy(v) {
  if (v === undefined || v === null || v === '') return undefined;
  return !/^(0|false|no|off)$/i.test(String(v).trim());
}

function readConfig() {
  const cfg = Object.assign({}, DEFAULT_CONFIG);
  const file = path.join(logRoot(), 'config.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    Object.assign(cfg, JSON.parse(raw));
  } catch (_) {
    /* no config file is the normal case */
  }
  const capture = truthy(process.env.CC_USAGE_CAPTURE_PROMPTS);
  if (capture !== undefined) cfg.capture_prompt_text = capture;
  if (process.env.CC_USAGE_BILLING_MODE) cfg.billing_mode = process.env.CC_USAGE_BILLING_MODE;
  return cfg;
}

/**
 * Is this account charged per token, or is token usage already covered by a
 * subscription? Getting this wrong in the other direction is the expensive
 * mistake - printing a dollar figure that looks like a bill when nothing is
 * being billed - so anything we cannot establish resolves to 'unknown', which
 * the report labels as a list-price equivalent rather than a cost.
 */
function detectBillingMode() {
  const e = process.env;
  if (truthy(e.CLAUDE_CODE_USE_BEDROCK) || truthy(e.CLAUDE_CODE_USE_VERTEX)) return 'metered';

  if (e.ANTHROPIC_BASE_URL) {
    // The desktop app injects the default host into child processes, so a base
    // URL on its own means nothing. Only a third-party host implies metering.
    try {
      const host = new URL(e.ANTHROPIC_BASE_URL).hostname;
      if (!/(^|\.)anthropic\.com$/i.test(host)) return 'metered';
    } catch (_) {
      /* unparseable: tells us nothing */
    }
  }
  if (e.CLAUDE_CODE_OAUTH_TOKEN) return 'subscription';

  // Classify a credential by its prefix, never by its presence: Claude Code
  // passes a subscription OAuth token to child processes in ANTHROPIC_AUTH_TOKEN
  // too, so "a token is set" says nothing about who pays per token. Only the
  // prefix is ever read - no credential value is logged or stored.
  for (const name of ['ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_API_KEY']) {
    const v = e[name];
    if (!v) continue;
    if (/^sk-ant-oat/.test(v)) return 'subscription';
    if (/^sk-ant-api/.test(v)) return 'metered';
    return 'unknown'; // a third-party or gateway key: we cannot tell
  }

  try {
    if (fs.existsSync(path.join(claudeHome(), '.credentials.json'))) return 'subscription';
  } catch (_) {
    /* ignore */
  }
  return 'unknown';
}

function resolveBillingMode(cfg) {
  const mode = (cfg && cfg.billing_mode) || 'auto';
  if (mode === 'subscription' || mode === 'metered') return { mode, source: 'config' };
  return { mode: detectBillingMode(), source: 'detected' };
}

// --------------------------------------------------------------------------- //
// Time
// --------------------------------------------------------------------------- //

function pad(n, w) {
  return String(Math.abs(n)).padStart(w || 2, '0');
}

/** Local time with offset, e.g. 2026-10-26T15:10:05.123-05:00 */
function localIso(d) {
  const t = d || new Date();
  const off = -t.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  return (
    `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}` +
    `T${pad(t.getHours())}:${pad(t.getMinutes())}:${pad(t.getSeconds())}.${pad(t.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.trunc(off / 60))}:${pad(off % 60)}`
  );
}

/** Local calendar day, e.g. 2026-10-26 */
function dayStamp(d) {
  const t = d || new Date();
  return `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
}

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      /* spin */
    }
  }
}

// --------------------------------------------------------------------------- //
// Append-only writer
// --------------------------------------------------------------------------- //

/**
 * Concurrent sessions write the same daily file. A single appendFileSync is one
 * write() call, which is atomic for short lines but not for a long prompt, so
 * take an advisory lock around it. Failing to get the lock is never a reason to
 * drop an event: after the timeout we append anyway.
 */
function withLock(lockPath, fn, timeoutMs) {
  const limit = timeoutMs === undefined ? 1500 : timeoutMs;
  const start = Date.now();
  let fd = null;
  for (;;) {
    try {
      fd = fs.openSync(lockPath, 'wx');
      break;
    } catch (err) {
      if (err.code !== 'EEXIST') break;
      try {
        const st = fs.statSync(lockPath);
        if (Date.now() - st.mtimeMs > 5000) {
          fs.unlinkSync(lockPath); // holder died
          continue;
        }
      } catch (_) {
        /* vanished under us: retry */
      }
      if (Date.now() - start > limit) break;
      sleepSync(15);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
      try {
        fs.unlinkSync(lockPath);
      } catch (_) {
        /* ignore */
      }
    }
  }
}

function appendJsonl(file, line) {
  ensureDir(path.dirname(file));
  withLock(file + '.lock', () => {
    fs.appendFileSync(file, line + '\n', 'utf8');
  });
}

function logHookError(stage, err) {
  try {
    ensureDir(logRoot());
    const msg = (err && (err.stack || err.message)) || String(err);
    fs.appendFileSync(errorLogPath(), `${localIso()} [${stage}] ${String(msg).replace(/\s+/g, ' ')}\n`, 'utf8');
  } catch (_) {
    /* a logger that throws while logging an error is worse than a lost line */
  }
}

// --------------------------------------------------------------------------- //
// Values
// --------------------------------------------------------------------------- //

function trunc(value, max) {
  if (value === null || value === undefined) return undefined;
  const limit = max || 400;
  const s = typeof value === 'string' ? value : String(value);
  if (s.length <= limit) return s;
  return s.slice(0, limit) + ` [+${s.length - limit} chars]`;
}

/** Drop null/undefined/'' and empty objects so log lines stay compact. */
function compact(obj) {
  const out = {};
  for (const k of Object.keys(obj)) {
    const v = obj[k];
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    if (!Array.isArray(v) && typeof v === 'object' && Object.keys(v).length === 0) continue;
    out[k] = v;
  }
  return out;
}

function num(v, d) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d || 0;
}

// --------------------------------------------------------------------------- //
// Project / repo / branch, read straight from .git (no git subprocess per event)
// --------------------------------------------------------------------------- //

function repoInfo(cwd) {
  const info = { project: undefined, repo_root: undefined, branch: undefined };
  if (!cwd) return info;

  let dir;
  try {
    dir = path.resolve(cwd);
  } catch (_) {
    return info;
  }
  info.project = path.basename(dir);

  let cur = dir;
  for (;;) {
    const dotGit = path.join(cur, '.git');
    let st = null;
    try {
      st = fs.statSync(dotGit);
    } catch (_) {
      st = null;
    }
    if (st) {
      info.repo_root = cur;
      info.project = path.basename(cur);
      let gitDir = dotGit;
      if (st.isFile()) {
        // worktree or submodule: ".git" is a file holding "gitdir: <path>"
        try {
          const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
          if (m) {
            const gd = m[1].trim();
            gitDir = path.isAbsolute(gd) ? gd : path.resolve(cur, gd);
          }
        } catch (_) {
          /* ignore */
        }
      }
      try {
        const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').split('\n')[0].trim();
        const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (ref) info.branch = ref[1].trim();
        else if (head) info.branch = 'detached:' + head.slice(0, 12);
      } catch (_) {
        /* ignore */
      }
      break;
    }
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return info;
}

module.exports = {
  DEFAULT_CONFIG,
  appendJsonl,
  claudeHome,
  compact,
  dayStamp,
  detectBillingMode,
  ensureDir,
  errorLogPath,
  localIso,
  logHookError,
  logRoot,
  num,
  readConfig,
  repoInfo,
  reportDir,
  resolveBillingMode,
  sleepSync,
  stateRoot,
  trunc,
  withLock,
};
