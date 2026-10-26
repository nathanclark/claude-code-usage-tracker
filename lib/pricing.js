'use strict';
/**
 * Token rates and what to call the money column.
 *
 * The rates are bundled (lib/prices.json) rather than fetched: this tool makes
 * no network calls. Refresh them with scripts/update-prices.js, which is a
 * maintainer tool and the one thing here that does reach the network.
 */

const fs = require('fs');
const path = require('path');

const { num } = require('./common');

function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'prices.json'), 'utf8'));
  } catch (_) {
    return null;
  }
}

/** Longest matching key wins, so claude-opus-5.5 beats a bare "opus". */
function getRate(prices, model) {
  if (!prices || !prices.models) return null;
  const m = String(model || '').toLowerCase();
  let best = null;
  let bestLen = -1;
  for (const key of Object.keys(prices.models)) {
    const k = key.toLowerCase();
    if (m && m.indexOf(k) >= 0 && k.length > bestLen) {
      best = prices.models[key];
      bestLen = k.length;
    }
  }
  return best || prices.default || null;
}

function estimateCost(prices, tokens, model) {
  const r = getRate(prices, model);
  if (!r || !tokens) return 0;
  let c = 0;
  c += (num(tokens.input) / 1e6) * num(r.input);
  c += (num(tokens.output) / 1e6) * num(r.output);
  c += (num(tokens.cache_read) / 1e6) * num(r.cache_read);

  // Prefer the 5m/1h split when the log carries it: a 1-hour cache write costs
  // more than a 5-minute one, and Claude Code uses the 1-hour TTL for most
  // sessions. Pricing everything at the 5m rate understates it badly.
  const w5m = num(r.cache_write);
  const w1h = r.cache_write_1h === undefined || r.cache_write_1h === null ? w5m : num(r.cache_write_1h);
  const cc5m = num(tokens.cache_creation_5m);
  const cc1h = num(tokens.cache_creation_1h);
  const ccAll = num(tokens.cache_creation);
  if (cc5m + cc1h > 0) {
    c += (cc5m / 1e6) * w5m;
    c += (cc1h / 1e6) * w1h;
    const rest = ccAll - cc5m - cc1h; // reported only in the total
    if (rest > 0) c += (rest / 1e6) * w5m;
  } else {
    c += (ccAll / 1e6) * w5m;
  }
  return c;
}

/**
 * On a subscription the money figure is a way to rank projects by weight, not
 * an invoice. Say which it is, and when we cannot tell, say that too - rather
 * than print a number that reads like a bill nobody is paying.
 */
function billingLabels(mode, source) {
  const metered = mode === 'metered';
  const label = metered ? 'Est. cost' : 'List-price equiv.';
  const headline = metered ? 'Estimated cost' : 'Token value at list price';
  let note;
  if (metered) {
    note =
      '_Cost is an estimate at provider list price. It ignores volume discounts, free-tier credits, batch pricing and anything your gateway or reseller adds._';
  } else if (mode === 'subscription') {
    note =
      '_The money column is a **list-price equivalent, not a bill**: this account authenticates with a Claude subscription, so these tokens are not charged per token. Use it to rank projects by weight. Set `billing_mode` to `metered` in `config.json` if you move to per-token billing._';
  } else {
    note =
      '_The money column is a **list-price equivalent, not a bill**. No per-token billing credential was detected, so it is shown as what these tokens would list for, not as money spent. Set `billing_mode` to `metered` or `subscription` in `config.json` to say which it is._';
  }
  if (source === 'detected') {
    note += `\n\n_Billing mode was auto-detected as \`${mode}\`._`;
  }
  return { label, headline, note };
}

module.exports = { billingLabels, estimateCost, getRate, loadPrices };
