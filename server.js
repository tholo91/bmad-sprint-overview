const express = require('express');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { marked } = require('marked');
const simpleGit = require('simple-git');

const app = express();
const PORT = process.env.PORT || 3333;
const REPOS_ROOT = process.env.REPOS_ROOT || path.resolve(__dirname, '..');
const CONFIG_FILE = path.join(__dirname, 'config.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Config (extra repo paths) ──────────────────────────

function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); }
  catch { return { extraPaths: [] }; }
}

function writeConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── Discovery ──────────────────────────────────────────

function findProjects() {
  const cfg = readConfig();
  const seen = new Set();
  const projects = [];

  // Scan REPOS_ROOT
  scanRoot(REPOS_ROOT, projects, seen);

  // Scan extra paths from config
  for (const p of (cfg.extraPaths || [])) {
    // Extra paths can be individual repos OR root folders to scan
    if (!fs.existsSync(p)) continue;
    if (isRepoDir(p)) {
      const name = path.basename(p);
      if (!seen.has(p)) tryAddProject(p, name, projects, seen, { allowEmpty: true });
    } else {
      scanRoot(p, projects, seen);
    }
  }

  return projects;
}

function isRepoDir(p) {
  return hasSprintStatus(p) || fs.existsSync(path.join(p, '.git'));
}

function hasSprintStatus(p) {
  return [
    path.join(p, '_bmad-output', 'sprint-status.yaml'),
    path.join(p, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
  ].some(f => fs.existsSync(f));
}

function scanRoot(rootDir, projects, seen) {
  let entries;
  try { entries = fs.readdirSync(rootDir, { withFileTypes: true }); }
  catch { return; }

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const repoPath = path.join(rootDir, entry.name);
    tryAddProject(repoPath, entry.name, projects, seen);

    // One level deep for monorepos
    try {
      const subs = fs.readdirSync(repoPath, { withFileTypes: true });
      for (const sub of subs) {
        if (!sub.isDirectory() || sub.name.startsWith('.') || sub.name === 'node_modules') continue;
        tryAddProject(path.join(repoPath, sub.name), sub.name, projects, seen);
      }
    } catch {}
  }
}

function tryAddProject(repoPath, name, list, seen, { allowEmpty = false } = {}) {
  if (seen && seen.has(repoPath)) return;
  const locations = [
    path.join(repoPath, '_bmad-output', 'sprint-status.yaml'),
    path.join(repoPath, '_bmad-output', 'implementation-artifacts', 'sprint-status.yaml'),
  ];
  for (const loc of locations) {
    if (fs.existsSync(loc)) {
      if (seen) seen.add(repoPath);
      list.push({ id: name, name, path: repoPath, statusFile: loc });
      return;
    }
  }
  // Extra paths: show even without sprint status
  if (allowEmpty && fs.existsSync(path.join(repoPath, '.git'))) {
    if (seen) seen.add(repoPath);
    list.push({ id: name, name, path: repoPath, statusFile: null });
  }
}

// ── YAML Parsing ───────────────────────────────────────

function parseSprintStatus(statusFile, projectPath) {
  if (!statusFile) return null;
  try {
    const raw = fs.readFileSync(statusFile, 'utf8');
    const data = yaml.load(raw);
    if (!data) return null;
    // Format detection
    if (data.epics && Array.isArray(data.epics))   return parseHierarchical(data, statusFile);
    if (data.development_status)                    return parseFlat(data, statusFile, projectPath);
    if (data.next_up || data.done)                  return parsePriorityQueue(data, statusFile);
    return null;
  } catch (e) {
    console.error(`Parse error ${statusFile}: ${e.message}`);
    return null;
  }
}

// Format 1: epics[] with stories[] — Spießer main
function parseHierarchical(data, statusFile) {
  const dir = path.dirname(statusFile);
  return {
    format: 'hierarchical',
    sprint: data.sprint || 'Unknown',
    updated: data.updated || null,
    epics: (data.epics || []).map((epic, i) => ({
      id: String(i + 1),
      name: epic.name || `Epic ${i + 1}`,
      stories: (epic.stories || []).map(s => {
        const file = resolveFile(dir, s.file || s.plan);
        return {
          id: s.id || '?',
          title: s.title || 'Untitled',
          status: norm(s.status),
          file,
          mtime: fileMtime(file),
          created: s.created || null,
          notes: s.notes || null,
        };
      })
    }))
  };
}

// Format 2: development_status flat key-value — code-tasks, surv.ai
function parseFlat(data, statusFile, projectPath) {
  const implDir = path.dirname(statusFile);
  const status = data.development_status || {};
  const info = data.sprint_info || {};
  const epicNames = loadEpicNames(projectPath);
  const epicMap = {};

  for (const [key, val] of Object.entries(status)) {
    if (key.startsWith('epic-')) {
      const num = key.replace('epic-', '');
      if (!epicMap[num]) epicMap[num] = { stories: [] };
      epicMap[num].epicStatus = norm(val);
    } else {
      const m = key.match(/^(\d+)-(\d+)-(.+)$/);
      if (!m) continue;
      const [, eNum, sNum, slug] = m;
      if (!epicMap[eNum]) epicMap[eNum] = { stories: [] };
      const rawFile = path.join(implDir, `${key}.md`);
      const file = fs.existsSync(rawFile) ? rawFile : null;
      epicMap[eNum].stories.push({
        id: `${eNum}.${sNum}`,
        title: deslug(slug),
        status: norm(val),
        file,
        mtime: fileMtime(file),
      });
    }
  }

  return {
    format: 'flat',
    sprint: info.current_sprint || 'Unknown',
    updated: info.start_date || null,
    epics: Object.entries(epicMap)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([num, e]) => ({
        id: num,
        name: epicNames[num] ? `Epic ${num}: ${epicNames[num]}` : `Epic ${num}`,
        epicStatus: e.epicStatus,
        stories: e.stories.sort((a, b) => parseFloat(a.id.split('.')[1]) - parseFloat(b.id.split('.')[1]))
      }))
  };
}

// Format 3: next_up[] with priority P1/P2/P3 — spiesser-app
function parsePriorityQueue(data, statusFile) {
  const dir = path.dirname(statusFile);
  const groups = { P1: [], P2: [], P3: [] };

  for (const item of (data.next_up || [])) {
    const p = (item.priority || 'P3').toUpperCase();
    if (!groups[p]) groups[p] = [];
    const file = resolveFile(dir, item.file || item.plan);
    groups[p].push({
      id: item.id || '?',
      title: item.title || 'Untitled',
      status: norm(item.status),
      file,
      mtime: fileMtime(file),
      notes: item.notes || null,
    });
  }

  const LABELS = {
    P1: 'P1 — Launch Blockers',
    P2: 'P2 — Architecture & Sustainability',
    P3: 'P3 — Features',
  };

  const epics = Object.entries(groups)
    .filter(([, s]) => s.length > 0)
    .map(([p, stories]) => ({ id: p, name: LABELS[p] || p, stories }));

  // Flatten done summaries as a reference epic
  const doneItems = [];
  if (data.done && typeof data.done === 'object') {
    for (const [key, val] of Object.entries(data.done)) {
      doneItems.push({
        id: key,
        title: typeof val === 'string' ? val : deslug(key),
        status: 'done',
        file: null,
      });
    }
  }
  if (doneItems.length) epics.push({ id: 'done', name: 'Completed', stories: doneItems });

  return {
    format: 'priority-queue',
    sprint: data.sprint || 'Unknown',
    updated: data.updated || null,
    epics,
  };
}

// ── Helpers ────────────────────────────────────────────

function resolveFile(dir, ref) {
  if (!ref) return null;
  const resolved = path.resolve(dir, ref);
  return fs.existsSync(resolved) ? resolved : null;
}

function loadEpicNames(projectPath) {
  const candidates = [
    path.join(projectPath, '_bmad-output', 'planning-artifacts', 'epics.md'),
    path.join(projectPath, '_bmad-output', 'epics.md'),
  ];
  for (const f of candidates) {
    if (!fs.existsSync(f)) continue;
    const content = fs.readFileSync(f, 'utf8');
    const names = {};
    const re = /^##\s+Epic\s+(\d+)[:\s\u2014\u2013-]+(.+)$/gm;
    let m;
    while ((m = re.exec(content))) names[m[1]] = m[2].trim();
    if (Object.keys(names).length) return names;
  }
  return {};
}

function norm(s)    { return s ? String(s).toLowerCase().trim() : 'backlog'; }
function deslug(s)  { return s.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()); }
function fileMtime(f) {
  if (!f) return null;
  try { return fs.statSync(f).mtime.toISOString(); }
  catch { return null; }
}

// ── Stats ──────────────────────────────────────────────

function computeStats(parsed) {
  const s = { total: 0, done: 0, inProgress: 0, ready: 0, blocked: 0, other: 0 };
  if (!parsed) return s;
  for (const epic of parsed.epics) {
    for (const story of epic.stories) {
      s.total++;
      if (story.status === 'done')                                 s.done++;
      else if (story.status === 'in-progress' || story.status === 'review') s.inProgress++;
      else if (story.status === 'ready-for-dev')                   s.ready++;
      else if (story.status === 'blocked')                         s.blocked++;
      else                                                         s.other++;
    }
  }
  return s;
}

// ── Git ────────────────────────────────────────────────

function withTimeout(p, ms) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
}

async function getGitStatus(repoPath) {
  try {
    return await withTimeout((async () => {
      const git = simpleGit(repoPath);
      if (!(await git.checkIsRepo())) return null;
      const status = await git.status();
      let unpushed = 0;
      try {
        if (status.tracking) {
          const log = await git.log({ from: status.tracking, to: 'HEAD' });
          unpushed = log.total;
        }
      } catch {}
      return { branch: status.current, uncommitted: status.files.length, unpushed, clean: status.isClean() };
    })(), 5000);
  } catch { return null; }
}

// ── API ────────────────────────────────────────────────

app.get('/api/projects', async (_req, res) => {
  const all = findProjects();
  const results = await Promise.all(all.map(async p => {
    const parsed = parseSprintStatus(p.statusFile, p.path);
    const stats = computeStats(parsed);
    const git = await getGitStatus(p.path);
    return { id: p.id, name: p.name, sprint: parsed?.sprint || null, updated: parsed?.updated || null, format: parsed?.format || null, stats, git };
  }));
  res.json(results);
});

app.get('/api/project', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Missing id' });
  const all = findProjects();
  const p = all.find(x => x.id === id);
  if (!p) return res.status(404).json({ error: 'Not found' });
  const parsed = parseSprintStatus(p.statusFile, p.path);
  const stats = computeStats(parsed);
  const git = await getGitStatus(p.path);
  res.json({ id: p.id, name: p.name, path: p.path, ...parsed, stats, git });
});

app.get('/api/story', (req, res) => {
  const file = req.query.file;
  if (!file) return res.status(400).json({ error: 'Missing file' });
  const resolved = path.resolve(file);
  // Allow any path under REPOS_ROOT or any configured extra path
  const cfg = readConfig();
  const allowedRoots = [path.resolve(REPOS_ROOT), ...((cfg.extraPaths || []).map(p => path.resolve(p)))];
  if (!allowedRoots.some(r => resolved.startsWith(r))) return res.status(403).json({ error: 'Denied' });
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Not found' });
  const raw = fs.readFileSync(resolved, 'utf8');
  res.json({ html: marked(raw), file: resolved });
});

// ── Config API ─────────────────────────────────────────

app.get('/api/config', (_req, res) => {
  res.json({ ...readConfig(), reposRoot: REPOS_ROOT });
});

app.post('/api/config/add-path', (req, res) => {
  let { repoPath } = req.body;
  if (!repoPath) return res.status(400).json({ error: 'Missing repoPath' });
  repoPath = repoPath.replace(/^['"]|['"]$/g, '').trim();
  const resolved = path.resolve(repoPath);
  if (!fs.existsSync(resolved)) return res.status(404).json({ error: 'Path does not exist' });
  const cfg = readConfig();
  if (!cfg.extraPaths.includes(resolved)) {
    cfg.extraPaths.push(resolved);
    writeConfig(cfg);
  }
  res.json({ ok: true, path: resolved, extraPaths: cfg.extraPaths });
});

app.post('/api/config/remove-path', (req, res) => {
  const { repoPath } = req.body;
  const cfg = readConfig();
  cfg.extraPaths = cfg.extraPaths.filter(p => p !== path.resolve(repoPath));
  writeConfig(cfg);
  res.json({ ok: true, extraPaths: cfg.extraPaths });
});

// ── Start ──────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n  ◆ BMAD Sprint Overview`);
  console.log(`  → http://localhost:${PORT}`);
  console.log(`  → Scanning: ${REPOS_ROOT}\n`);
});
