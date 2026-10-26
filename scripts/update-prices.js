'use strict';
/**
 * Maintainer tool: regenerate lib/prices.json from the Vercel AI Gateway model
 * catalogue.
 *
 * THIS IS THE ONLY FILE IN THE REPOSITORY THAT MAKES A NETWORK CALL, and it is
 * never invoked by the hooks, the report or the scheduled run. The tracker
 * itself ships with these rates bundled and never phones anywhere.
 *
 * The gateway publishes per-model rates (input, output, cached reads, cache
 * writes) on an unauthenticated endpoint and charges provider list price with
 * no markup, which makes it a convenient public source for list prices.
 *
 * One rate it does not publish separately: a 1-hour cache write costs more than
 * a 5-minute one. The published input_cache_write is 1.25x input, which is the
 * 5-minute rate, so cache_write_1h is written as 2x input - Anthropic's
 * published 1-hour multiplier, and the one derived number in the file.
 *
 * Usage:
 *   node scripts/update-prices.js
 *   node scripts/update-prices.js --show-table
 *   node scripts/update-prices.js --provider anthropic --out lib/prices.json
 */

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const o = {
    endpoint: 'https://ai-gateway.vercel.sh/v1/models',
    providers: ['anthropic'],
    out: path.join(__dirname, '..', 'lib', 'prices.json'),
    showTable: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--endpoint') o.endpoint = argv[++i];
    else if (a === '--provider') o.providers = String(argv[++i]).split(',').map((s) => s.trim());
    else if (a === '--out') o.out = argv[++i];
    else if (a === '--show-table') o.showTable = true;
  }
  return o;
}

function round(n, dp) {
  const f = Math.pow(10, dp === undefined ? 4 : dp);
  return Math.round(n * f) / f;
}

async function fetchJson(url, timeoutMs) {
  if (typeof fetch !== 'function') {
    throw new Error('global fetch is unavailable; Node 18 or later is required for this script');
  }
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs || 60000);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Newest standard variant of a family: no -batch (half price), no -fast (double). */
function newestOfFamily(rows, family) {
  const cand = rows.filter(
    (r) => r.key.indexOf(family) >= 0 && !/-batch$/.test(r.key) && !/-fast$/.test(r.key)
  );
  if (!cand.length) return null;
  const ver = (k) => {
    const m = /(\d+(?:\.\d+)?)/.exec(k);
    return m ? parseFloat(m[1]) : 0;
  };
  return cand.slice().sort((a, b) => ver(a.key) - ver(b.key))[cand.length - 1];
}

function rateOf(r) {
  return {
    input: r.input,
    output: r.output,
    cache_read: r.cache_read,
    cache_write: r.cache_write,
    cache_write_1h: r.cache_write_1h,
  };
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  process.stdout.write(`Fetching ${opt.endpoint} ...\n`);
  const body = await fetchJson(opt.endpoint);
  const all = Array.isArray(body && body.data) ? body.data : [];
  if (!all.length) throw new Error(`No models returned from ${opt.endpoint}`);

  const rows = [];
  for (const m of all) {
    const id = String(m.id || '');
    const owner = id.split('/')[0];
    if (opt.providers.length && opt.providers.indexOf(owner) < 0) continue;
    const p = m.pricing;
    if (!p || p.input === undefined || p.input === null) continue;
    const inp = Number(p.input);
    rows.push({
      key: id.replace(/^[^/]+\//, ''), // transcript model ids carry no provider prefix
      id,
      input: round(inp * 1e6),
      output: round(Number(p.output) * 1e6),
      cache_read: round(Number(p.input_cache_read) * 1e6),
      cache_write: round(Number(p.input_cache_write) * 1e6),
      cache_write_1h: round(inp * 2 * 1e6),
    });
  }
  rows.sort((a, b) => a.key.localeCompare(b.key));
  if (!rows.length) throw new Error(`No priced models matched provider(s): ${opt.providers.join(', ')}`);

  const models = {};
  for (const r of rows) models[r.key] = rateOf(r);

  // Family fallbacks for an id the catalogue does not list yet (a new release,
  // or a harness-specific alias).
  let fallbacks = 0;
  for (const family of ['opus', 'sonnet', 'haiku', 'fable']) {
    const n = newestOfFamily(rows, family);
    if (!n) continue;
    models[family] = Object.assign(rateOf(n), { _from: n.id });
    fallbacks++;
  }

  const def = newestOfFamily(rows, 'sonnet') || rows[0];

  const prev = (() => {
    try {
      return JSON.parse(fs.readFileSync(opt.out, 'utf8'));
    } catch (_) {
      return {};
    }
  })();

  const out = {
    _source: opt.endpoint,
    _generated: new Date().toISOString(),
    _generated_by: 'scripts/update-prices.js',
    _note:
      prev._note ||
      'USD per 1,000,000 tokens at provider list price, as published by the Vercel AI Gateway catalogue (which charges list price with no markup). Matched against the transcript model id by substring; the longest matching key wins. Set a value to null to drop it from the calculation.',
    _derived:
      'cache_write is the published rate (1.25x input = the Anthropic 5-minute cache TTL). cache_write_1h is NOT published - it is 2x input, Anthropic published 1-hour multiplier. Claude Code uses the 1-hour TTL for most sessions.',
    _fields:
      'input = fresh input tokens, output = output tokens, cache_read = cached input reads, cache_write = 5-minute cache creation, cache_write_1h = 1-hour cache creation',
    _billing:
      'Whether these rates are a bill or only a size comparison is decided at report time by billing_mode in <log root>/config.json (default: auto-detected). This file holds rates only.',
    models,
    default: Object.assign(rateOf(def), { _from: def.id }),
  };

  fs.writeFileSync(opt.out, JSON.stringify(out, null, 2) + '\n', 'utf8');

  if (opt.showTable) {
    for (const r of rows) {
      process.stdout.write(
        `${r.key.padEnd(30)} in=${String(r.input).padStart(7)} out=${String(r.output).padStart(7)} ` +
          `read=${String(r.cache_read).padStart(7)} w5m=${String(r.cache_write).padStart(7)} w1h=${String(r.cache_write_1h).padStart(7)}\n`
      );
    }
  }
  process.stdout.write(`Wrote ${rows.length} model rate(s) + ${fallbacks} family fallback(s) to ${opt.out}\n`);
}

main().catch((err) => {
  process.stderr.write(`update-prices failed: ${(err && err.message) || err}\n`);
  process.exit(1);
});
