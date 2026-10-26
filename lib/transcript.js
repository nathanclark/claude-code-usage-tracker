'use strict';
/**
 * Per-session state plus the incremental transcript scan that produces token
 * counts.
 *
 * Hooks are not given token counts, so they come from the session transcript:
 * every assistant line carries message.usage. Each hook invocation reads only
 * the bytes appended since the last one, remembers a byte offset, and
 * de-duplicates by API message id - so a turn is never counted twice and a
 * long session never costs more to scan than a short one.
 */

const fs = require('fs');
const path = require('path');

const { ensureDir, localIso, num, stateRoot } = require('./common');

const TOKEN_KEYS = [
  'input',
  'output',
  'cache_read',
  'cache_creation',
  'cache_creation_5m',
  'cache_creation_1h',
  'thinking',
];

function zeroTokens() {
  const t = {};
  for (const k of TOKEN_KEYS) t[k] = 0;
  return t;
}

function zeroModelTokens() {
  return Object.assign(zeroTokens(), { requests: 0 });
}

function statePath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
  return path.join(stateRoot(), safe + '.json');
}

function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), 'utf8'));
  } catch (_) {
    return null;
  }
}

function writeState(sessionId, state) {
  const p = statePath(sessionId);
  ensureDir(path.dirname(p));
  const tmp = `${p}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, p);
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* ignore */
    }
  }
}

/**
 * A resumed, forked or compacted session inherits a transcript an earlier
 * session already accounted for. Baseline the offset at EOF so those turns are
 * not counted a second time.
 */
function newState(sessionId, transcriptPath, baseline) {
  let offset = 0;
  if (baseline && transcriptPath) {
    try {
      offset = fs.statSync(transcriptPath).size;
    } catch (_) {
      offset = 0;
    }
  }
  return {
    session_id: sessionId,
    transcript_path: transcriptPath,
    started: localIso(),
    offset,
    baseline_offset: offset,
    seen: [],
    requests: 0,
    totals: zeroTokens(),
    by_model: {},
    turns: 0,
    subagents: {},
  };
}

function addInto(target, src) {
  for (const k of TOKEN_KEYS) target[k] = num(target[k]) + num(src[k]);
  if ('requests' in target) target.requests = num(target.requests) + num(src.requests);
}

/**
 * Read the bytes appended since last time and sum message.usage from assistant
 * lines. Mutates `state`; returns the delta for this scan, including the
 * per-model split (one turn can span models, and they are not priced alike).
 */
function updateUsage(state, transcriptPath, maxScanBytes) {
  const delta = Object.assign(zeroTokens(), { requests: 0, models: [], by_model: {} });
  if (!transcriptPath) return delta;

  let size;
  try {
    size = fs.statSync(transcriptPath).size;
  } catch (_) {
    return delta;
  }

  let off = num(state.offset);
  if (size < off) off = 0; // transcript rewritten (compaction)
  if (size === off) return delta;

  const cap = maxScanBytes || 64 * 1024 * 1024;
  if (size - off > cap) off = size - cap; // never let one scan run away
  const toRead = size - off;

  let buf;
  let read = 0;
  let fd = null;
  try {
    fd = fs.openSync(transcriptPath, 'r');
    buf = Buffer.allocUnsafe(toRead);
    while (read < toRead) {
      const n = fs.readSync(fd, buf, read, toRead - read, off + read);
      if (n <= 0) break;
      read += n;
    }
  } catch (_) {
    return delta;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* ignore */
      }
    }
  }

  const text = buf.toString('utf8', 0, read);
  const lastNl = text.lastIndexOf('\n');
  if (lastNl < 0) return delta; // no complete line yet
  const complete = text.slice(0, lastNl + 1);
  const consumed = Buffer.byteLength(complete, 'utf8');

  const seen = new Set((state.seen || []).filter(Boolean).map(String));
  const models = new Set();
  if (!state.by_model || typeof state.by_model !== 'object') state.by_model = {};

  for (const line of complete.split('\n')) {
    if (!line.trim()) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch (_) {
      continue;
    }
    if (!o || o.type !== 'assistant') continue;
    const msg = o.message;
    if (!msg) continue;
    const u = msg.usage;
    if (!u) continue;

    const mid = String(msg.id || o.requestId || o.uuid || '');
    if (!mid) continue;
    if (seen.has(mid)) continue;
    seen.add(mid);

    const model = String(msg.model || 'unknown');
    models.add(model);

    const one = zeroModelTokens();
    one.input = num(u.input_tokens);
    one.output = num(u.output_tokens);
    one.cache_read = num(u.cache_read_input_tokens);
    one.cache_creation = num(u.cache_creation_input_tokens);
    one.thinking = u.output_tokens_details ? num(u.output_tokens_details.thinking_tokens) : 0;
    // A 1-hour cache write costs more than a 5-minute one, so keep them apart.
    if (u.cache_creation) {
      one.cache_creation_5m = num(u.cache_creation.ephemeral_5m_input_tokens);
      one.cache_creation_1h = num(u.cache_creation.ephemeral_1h_input_tokens);
    }
    one.requests = 1;

    addInto(delta, one);
    if (!delta.by_model[model]) delta.by_model[model] = zeroModelTokens();
    addInto(delta.by_model[model], one);
    if (!state.by_model[model]) state.by_model[model] = zeroModelTokens();
    addInto(state.by_model[model], one);
  }

  if (!state.totals || typeof state.totals !== 'object') state.totals = zeroTokens();
  addInto(state.totals, delta);
  state.requests = num(state.requests) + delta.requests;
  state.offset = off + consumed;

  const all = Array.from(seen);
  state.seen = all.length > 4000 ? all.slice(all.length - 4000) : all;
  delta.models = Array.from(models);
  return delta;
}

module.exports = {
  TOKEN_KEYS,
  newState,
  readState,
  statePath,
  updateUsage,
  writeState,
  zeroModelTokens,
  zeroTokens,
};
