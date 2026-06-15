const express = require('express');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const { XMLParser } = require('fast-xml-parser');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_PASS = process.env.ADMIN_PASS || 'ethos2026';

// ── DB ────────────────────────────────────────────────────────────────────────

const db = new sqlite3.Database(path.join(__dirname, 'leads.db'), (err) => {
  if (err) console.error('DB init error:', err);
  else console.log('Database connected');
});

// Catch any unhandled statement-level errors so they don't crash the process
db.on('error', (err) => console.error('[DB error]', err.message));

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT, email TEXT NOT NULL, phone TEXT, state TEXT, message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE, title TEXT, link TEXT, summary TEXT,
    source TEXT, category TEXT, pub_date TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS feed_errors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    feed_source TEXT, feed_url TEXT NOT NULL,
    error_message TEXT NOT NULL, resolved INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
  db.run(`CREATE TABLE IF NOT EXISTS site_health (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    check_type TEXT, status TEXT, detail TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )`);
});

function runQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) { err ? reject(err) : resolve(this); });
  });
}
function allQuery(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
  });
}

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── FEEDS ─────────────────────────────────────────────────────────────────────

const FEEDS = [
  { url: 'https://www.energy.gov/rss.xml',                     source: 'US Dept of Energy',      category: 'energy' },
  { url: 'https://feeds.feedburner.com/aseannow',              source: 'ASEAN Now',               category: 'energy' },
  { url: 'https://www.renewableenergyworld.com/feed/',         source: 'Renewable Energy World',  category: 'energy' },
  { url: 'https://cleantechnica.com/feed/',                    source: 'CleanTechnica',           category: 'energy' },
  { url: 'https://www.smarthomebeginner.com/feed/',            source: 'Smart Home Beginner',     category: 'smart-home' },
  { url: 'https://staceyoniot.com/feed/',                      source: 'Stacey on IoT',           category: 'smart-home' },
  { url: 'https://www.cnet.com/rss/smart-home/',               source: 'CNET Smart Home',         category: 'smart-home' },
  { url: 'https://www.energy.gov/eere/articles/rss.xml',      source: 'DOE EERE',                category: 'government' },
  { url: 'https://feeds.feedburner.com/GreenBiz',             source: 'GreenBiz',                category: 'government' },
  { url: 'https://www.climatechangenews.com/feed/',           source: 'Climate Change News',     category: 'government' },
    { url: 'https://www.realestate.com.au/news/feed/',          source: 'REA News',                category: 'property' },
  { url: 'https://www.constructionweekonline.com/rss.xml',    source: 'Construction Week',       category: 'property' },
  { url: 'https://www.archdaily.com/feed',                    source: 'ArchDaily',               category: 'design' },
  { url: 'https://www.dezeen.com/feed/',                      source: 'Dezeen',                  category: 'design' },
  { url: 'https://inhabitat.com/feed/',                       source: 'Inhabitat',               category: 'design' },
];

function fetchUrl(url, retries = 2) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'EthosInsights/1.0' }, timeout: 12000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location, retries - 1).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode}`));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', e => {
      if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve).catch(reject), 2000);
      else reject(e);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function parseFeed(feed) {
  try {
    const xml = await fetchUrl(feed.url);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const obj = parser.parse(xml);
    const channel = obj?.rss?.channel || obj?.feed;
    if (!channel) throw new Error('No channel/feed element found');
    const items = channel.item || channel.entry || [];
    const arr = Array.isArray(items) ? items : [items];
    return arr.slice(0, 12).map(item => ({
      guid:     String(item.guid || item.id || item.link || Math.random()),
      title:    String(item.title || '').replace(/<[^>]+>/g, '').trim(),
      link:     String(item.link?.['@_href'] || item.link || item.url || ''),
      summary:  String(item.description || item.summary || item['content:encoded'] || '')
                  .replace(/<[^>]+>/g, '').trim().slice(0, 300),
      source:   feed.source,
      category: feed.category,
      pub_date: String(item.pubDate || item.published || item.updated || new Date().toISOString()),
    }));
  } catch (e) {
    console.error(`[Feed Error] ${feed.source}: ${e.message}`);
    db.run(
      'INSERT INTO feed_errors (feed_source, feed_url, error_message) VALUES (?, ?, ?)',
      [feed.source, feed.url, e.message],
      (dbErr) => { if (dbErr) console.error('[Feed Error Log]', dbErr.message); }
    );
    return [];
  }
}

async function refreshFeeds() {
  console.log('[Feeds] Refreshing...');
  let count = 0;
  const errors = [];
  for (const feed of FEEDS) {
    const articles = await parseFeed(feed);
    if (articles.length === 0) errors.push(feed.source);
    for (const a of articles) {
      try {
        const r = await runQuery(
          `INSERT OR IGNORE INTO articles (guid, title, link, summary, source, category, pub_date)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [a.guid, a.title, a.link, a.summary, a.source, a.category, a.pub_date]
        );
        if (r.changes) count++;
      } catch (e) { console.error('[Feed Insert Error]', e.message); }
    }
  }
  console.log(`[Feeds] Done — ${count} new articles. ${errors.length} feeds failed: ${errors.join(', ') || 'none'}`);
  return { count, errors };
}

// ── HEALTH CHECK + AUTO-HEAL ──────────────────────────────────────────────────

async function runHealthChecks() {
  const issues = [];

  // 1. Check DB is reachable
  try {
    await allQuery('SELECT 1');
  } catch (e) {
    issues.push({ type: 'db', detail: `DB unreachable: ${e.message}` });
  }

  // 2. Check articles table has recent data (within 12h)
  try {
    const rows = await allQuery(
      `SELECT COUNT(*) as cnt FROM articles WHERE fetched_at > datetime('now', '-12 hours')`
    );
    if (rows[0].cnt === 0) {
      issues.push({ type: 'stale_feeds', detail: 'No articles fetched in last 12 hours' });
    }
  } catch (e) {
    issues.push({ type: 'articles_check', detail: e.message });
  }

  // 3. Check for a spike in feed errors in last hour
  try {
    const rows = await allQuery(
      `SELECT COUNT(*) as cnt FROM feed_errors WHERE created_at > datetime('now', '-1 hour')`
    );
    if (rows[0].cnt >= 3) {
      issues.push({ type: 'feed_errors', detail: `${rows[0].cnt} feed errors in last hour` });
    }
  } catch (e) { /* non-fatal */ }

  // Log health check result
  const status = issues.length === 0 ? 'ok' : 'degraded';
  db.run(
    'INSERT INTO site_health (check_type, status, detail) VALUES (?, ?, ?)',
    ['auto', status, issues.map(i => i.detail).join(' | ') || 'All clear'],
    (dbErr) => { if (dbErr) console.error('[Health Log]', dbErr.message); }
  );

  if (issues.length === 0) {
    console.log('[Health] All clear');
    return { ok: true, issues: [] };
  }

  console.warn(`[Health] ${issues.length} issue(s) detected — auto-healing...`);

  // ── AUTO-HEAL ──────────────────────────────────────────────────────────────
  for (const issue of issues) {
    if (issue.type === 'stale_feeds' || issue.type === 'feed_errors') {
      console.log('[Auto-heal] Triggering feed refresh...');
      try {
        const result = await refreshFeeds();
        console.log(`[Auto-heal] Feed refresh done — ${result.count} new articles`);
      } catch (e) {
        console.error('[Auto-heal] Feed refresh failed:', e.message);
      }
    }
  }

  return { ok: false, issues };
}

// ── API ───────────────────────────────────────────────────────────────────────

app.get('/api/insights', (req, res) => {
  const { category, limit = 30, offset = 0 } = req.query;
  const query = category && category !== 'all'
    ? 'SELECT * FROM articles WHERE category = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?'
    : 'SELECT * FROM articles ORDER BY pub_date DESC LIMIT ? OFFSET ?';
  const params = category && category !== 'all'
    ? [category, Number(limit), Number(offset)]
    : [Number(limit), Number(offset)];
  db.all(query, params, (err, rows) => res.json(err ? [] : (rows || [])));
});

app.post('/api/insights/refresh', (req, res) => {
  if (req.query.pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorised' });
  refreshFeeds()
    .then(r => res.json({ ok: true, ...r }))
    .catch(e => res.status(500).json({ error: e.message }));
});

app.get('/api/health', (req, res) => {
  if (req.query.pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorised' });
  runHealthChecks().then(r => res.json(r)).catch(e => res.status(500).json({ error: e.message }));
});

app.post('/submit', (req, res) => {
  const { name, email, phone, state, message } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!state) return res.status(400).json({ error: 'State required' });
  db.run(
    'INSERT INTO leads (name, email, phone, state, message) VALUES (?, ?, ?, ?, ?)',
    [name || '', email, phone || '', state, message || ''],
    function(err) { res.json(err ? { error: err.message } : { ok: true }); }
  );
});

// ── ADMIN ─────────────────────────────────────────────────────────────────────

app.get('/admin', async (req, res) => {
  const { pass } = req.query;
  if (pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b0f14;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
    form{display:flex;flex-direction:column;gap:1rem;width:300px}input{padding:.75rem 1rem;background:#141b24;border:1px solid #1e2d3d;border-radius:8px;color:#e2e8f0;font-size:1rem}
    button{padding:.75rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}h2{text-align:center;font-weight:500}</style></head>
    <body><form method="GET"><h2>Admin</h2><input type="password" name="pass" placeholder="Password" autofocus><button type="submit">Enter</button></form></body></html>`);
  }

  try {
    const [leads, feedErrors, health] = await Promise.all([
      allQuery('SELECT * FROM leads ORDER BY created_at DESC'),
      allQuery('SELECT * FROM feed_errors ORDER BY created_at DESC LIMIT 100'),
      allQuery('SELECT * FROM site_health ORDER BY created_at DESC LIMIT 20'),
    ]);

    const leadRows = leads.map(l =>
      `<tr><td>${l.id}</td><td>${l.created_at}</td><td>${l.name||''}</td><td>${l.email}</td><td>${l.state||''}</td><td>${l.phone||''}</td><td>${l.message||''}</td></tr>`
    ).join('');

    const errorRows = feedErrors.length
      ? feedErrors.map(e =>
          `<tr><td>${e.created_at}</td><td>${e.feed_source||''}</td><td style="color:#f87171">${e.error_message}</td></tr>`
        ).join('')
      : '<tr><td colspan="3" style="color:#4ade80;text-align:center">No errors</td></tr>';

    const healthRows = health.map(h =>
      `<tr><td>${h.created_at}</td><td style="color:${h.status==='ok'?'#4ade80':'#f87171'}">${h.status}</td><td>${h.detail}</td></tr>`
    ).join('');

    res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>
      *{margin:0;padding:0;box-sizing:border-box}
      body{background:#0b0f14;color:#e2e8f0;font-family:system-ui;padding:2rem}
      h1{margin-bottom:.5rem;font-weight:500;color:#93c5fd}
      h2{margin:2.5rem 0 .75rem;font-weight:500;color:#7dd3fc;font-size:1rem;text-transform:uppercase;letter-spacing:.05em}
      table{width:100%;border-collapse:collapse;font-size:.8rem;margin-bottom:1rem}
      th{text-align:left;padding:.6rem .8rem;background:#141b24;color:#64748b;font-weight:600;border-bottom:1px solid #1e2d3d}
      td{padding:.6rem .8rem;border-bottom:1px solid #1a2332;vertical-align:top;word-break:break-word}
      tr:hover td{background:#0f1923}
      .count{color:#64748b;font-size:.8rem;margin-bottom:.75rem}
      .actions{display:flex;gap:1rem;margin-bottom:2rem;flex-wrap:wrap}
      .btn{padding:.5rem 1.2rem;border-radius:6px;text-decoration:none;font-size:.85rem;font-weight:600;border:none;cursor:pointer;color:#fff}
      .btn-blue{background:#3b82f6}.btn-green{background:#16a34a}.btn-red{background:#dc2626}
    </style></head>
    <body>
      <h1>Admin Dashboard</h1>
      <div class="actions">
        <a class="btn btn-green" href="/api/insights/refresh?pass=${pass}">Refresh Feeds Now</a>
        <a class="btn btn-blue" href="/api/health?pass=${pass}">Run Health Check</a>
      </div>

      <h2>Site Health Log</h2>
      <table><thead><tr><th>Time</th><th>Status</th><th>Detail</th></tr></thead>
      <tbody>${healthRows || '<tr><td colspan="3">No checks yet</td></tr>'}</tbody></table>

      <h2>Feed Errors</h2>
      <table><thead><tr><th>Time</th><th>Feed</th><th>Error</th></tr></thead>
      <tbody>${errorRows}</tbody></table>

      <h2>Leads</h2>
      <p class="count">${leads.length} total</p>
      <table><thead><tr><th>#</th><th>Date</th><th>Name</th><th>Email</th><th>State</th><th>Phone</th><th>Message</th></tr></thead>
      <tbody>${leadRows || '<tr><td colspan="7" style="text-align:center;color:#64748b">No leads yet</td></tr>'}</tbody></table>
    </body></html>`);
  } catch (e) {
    res.status(500).send(`Error: ${e.message}`);
  }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// ── STARTUP ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log('Ethos running on port ' + PORT);
  // Initial feed load
  refreshFeeds();
  // Re-fetch feeds every 6 hours
  setInterval(refreshFeeds, 6 * 60 * 60 * 1000);
  // Health check every 15 minutes
  setInterval(runHealthChecks, 15 * 60 * 1000);
});
