'use strict';
/**
 * What is installed, so the report can say which skills, slash commands and
 * subagents never fired. Covers user scope, every installed plugin, and the
 * project scope of each repository that appears in the logs.
 */

const fs = require('fs');
const path = require('path');

const { claudeHome } = require('./common');

function readFrontMatter(file) {
  const res = { name: null, description: null };
  let head;
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.allocUnsafe(8192);
      const n = fs.readSync(fd, buf, 0, 8192, 0);
      head = buf.toString('utf8', 0, n);
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    return res;
  }
  const lines = head.split(/\r?\n/);
  if (!lines.length || lines[0].trim() !== '---') return res;
  for (let i = 1; i < lines.length && i < 60; i++) {
    if (lines[i].trim() === '---') break;
    let m = /^\s*name\s*:\s*(.+)$/.exec(lines[i]);
    if (m) {
      res.name = m[1].trim().replace(/^["']|["']$/g, '');
      continue;
    }
    m = /^\s*description\s*:\s*(.+)$/.exec(lines[i]);
    if (m) res.description = m[1].trim().replace(/^["']|["']$/g, '');
  }
  return res;
}

function addItem(bag, kind, name, scope, filePath, description) {
  if (!name) return;
  const key = `${kind}::${name}`.toLowerCase();
  if (!bag[key]) bag[key] = { kind, name, scopes: [], paths: [], description: description || null };
  const it = bag[key];
  if (it.scopes.indexOf(scope) < 0) it.scopes.push(scope);
  if (it.paths.indexOf(filePath) < 0) it.paths.push(filePath);
  if (!it.description && description) it.description = description;
}

function listDirs(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => path.join(root, d.name));
  } catch (_) {
    return [];
  }
}

function listMarkdown(root, out) {
  const acc = out || [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return acc;
  }
  for (const ent of entries) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) listMarkdown(full, acc);
    else if (ent.isFile() && /\.md$/i.test(ent.name)) acc.push(full);
  }
  return acc;
}

function scanSkillDir(bag, root, scope, prefix) {
  for (const dir of listDirs(root)) {
    const sk = path.join(dir, 'SKILL.md');
    try {
      if (!fs.statSync(sk).isFile()) continue;
    } catch (_) {
      continue;
    }
    const fm = readFrontMatter(sk);
    let name = fm.name || path.basename(dir);
    if (prefix) name = `${prefix}:${name}`;
    addItem(bag, 'skill', name, scope, sk, fm.description);
  }
}

function scanMdDir(bag, kind, root, scope, prefix, requireDescription) {
  for (const file of listMarkdown(root)) {
    const fm = readFrontMatter(file);
    // A registered subagent carries a description in its frontmatter. Requiring
    // one keeps README.md and stray notes out of the inventory.
    if (requireDescription && !fm.description) continue;
    let name = fm.name || path.basename(file).replace(/\.md$/i, '');
    if (prefix) name = `${prefix}:${name}`;
    addItem(bag, kind, name, scope, file, fm.description);
  }
}

/** Installed plugins, from the registry when readable and the cache otherwise. */
function pluginRoots() {
  const home = claudeHome();
  const roots = [];
  const seen = new Set();
  const push = (name, dir) => {
    if (!dir || seen.has(dir)) return;
    try {
      if (!fs.statSync(dir).isDirectory()) return;
    } catch (_) {
      return;
    }
    seen.add(dir);
    roots.push({ name, path: dir });
  };

  try {
    const j = JSON.parse(fs.readFileSync(path.join(home, 'plugins', 'installed_plugins.json'), 'utf8'));
    for (const key of Object.keys(j.plugins || {})) {
      const name = String(key).split('@')[0];
      const entries = Array.isArray(j.plugins[key]) ? j.plugins[key] : [j.plugins[key]];
      for (const entry of entries) {
        if (entry && typeof entry === 'object' && typeof entry.installPath === 'string') push(name, entry.installPath);
      }
    }
  } catch (_) {
    /* registry shape varies by version; the cache walk below is the fallback */
  }

  // Fallback / top-up for a registry this version cannot read: walk the cache,
  // whose layout is plugins/cache/<marketplace>/<plugin>/<version>.
  //
  // Only the cache. plugins/marketplaces/ holds the catalogues themselves,
  // including plugins that are listed but NOT installed - counting those as
  // installed would inflate "installed but never fired", which is the headline
  // finding of section 1.
  const walk = (dir, depth) => {
    if (depth > 4) return;
    const manifest = path.join(dir, '.claude-plugin', 'plugin.json');
    let isPlugin = false;
    try {
      isPlugin = fs.statSync(manifest).isFile();
    } catch (_) {
      isPlugin = false;
    }
    if (isPlugin) {
      let name = path.basename(dir);
      try {
        const pj = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (pj && pj.name) name = String(pj.name);
      } catch (_) {
        /* keep the directory name */
      }
      push(name, dir);
      return; // a plugin does not contain another plugin
    }
    for (const sub of listDirs(dir)) walk(sub, depth + 1);
  };
  walk(path.join(home, 'plugins', 'cache'), 0);

  return roots;
}

/**
 * @param {string[]} projectRoots repository / cwd paths seen in the logs
 */
function buildInventory(projectRoots) {
  const home = claudeHome();
  const bag = {};

  scanSkillDir(bag, path.join(home, 'skills'), 'user', null);
  scanMdDir(bag, 'agent', path.join(home, 'agents'), 'user', null, true);
  scanMdDir(bag, 'command', path.join(home, 'commands'), 'user', null, false);

  for (const pr of pluginRoots()) {
    const scope = 'plugin:' + pr.name;
    scanSkillDir(bag, path.join(pr.path, 'skills'), scope, pr.name);
    scanMdDir(bag, 'agent', path.join(pr.path, 'agents'), scope, pr.name, true);
    scanMdDir(bag, 'command', path.join(pr.path, 'commands'), scope, pr.name, false);
  }

  for (const root of projectRoots || []) {
    const pc = path.join(root, '.claude');
    try {
      if (!fs.statSync(pc).isDirectory()) continue;
    } catch (_) {
      continue;
    }
    const scope = 'project:' + path.basename(root);
    scanSkillDir(bag, path.join(pc, 'skills'), scope, null);
    scanMdDir(bag, 'agent', path.join(pc, 'agents'), scope, null, true);
    scanMdDir(bag, 'command', path.join(pc, 'commands'), scope, null, false);
  }

  return Object.keys(bag).map((k) => bag[k]);
}

module.exports = { buildInventory, pluginRoots, readFrontMatter };
