const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');
const { XMLParser } = require('fast-xml-parser');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// DB setup
const db = new Database(path.join(__dirname, 'leads.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    email TEXT NOT NULL,
    message TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  )
`);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── INSIGHTS ─────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS articles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    guid TEXT UNIQUE,
    title TEXT,
    link TEXT,
    summary TEXT,
    source TEXT,
    category TEXT,
    pub_date TEXT,
    fetched_at TEXT DEFAULT (datetime('now'))
  )
`);

const FEEDS = [
  // Energy saving / efficiency
  { url: 'https://www.energy.gov/rss.xml',                          source: 'US Dept of Energy',        category: 'energy' },
  { url: 'https://feeds.feedburner.com/aseannow',                   source: 'ASEAN Now',                category: 'energy' },
  { url: 'https://www.renewableenergyworld.com/feed/',              source: 'Renewable Energy World',   category: 'energy' },
  { url: 'https://cleantechnica.com/feed/',                         source: 'CleanTechnica',            category: 'energy' },
  // Smart home / tech
  { url: 'https://www.smarthomebeginner.com/feed/',                 source: 'Smart Home Beginner',      category: 'smart-home' },
  { url: 'https://staceyoniot.com/feed/',                           source: 'Stacey on IoT',            category: 'smart-home' },
  { url: 'https://www.cnet.com/rss/smart-home/',                    source: 'CNET Smart Home',          category: 'smart-home' },
  // Government / rebates / policy
  { url: 'https://www.energy.gov/eere/articles/rss.xml',           source: 'DOE EERE',                 category: 'government' },
  { url: 'https://feeds.feedburner.com/GreenBiz',                   source: 'GreenBiz',                 category: 'government' },
  { url: 'https://www.climatechangenews.com/feed/',                 source: 'Climate Change News',      category: 'government' },
  // Land / property / construction
  { url: 'https://www.propertynews.com.au/feed/',                   source: 'Property News AU',         category: 'property' },
  { url: 'https://www.realestate.com.au/news/feed/',                source: 'REA News',                 category: 'property' },
  { url: 'https://www.constructionweekonline.com/rss.xml',          source: 'Construction Week',        category: 'property' },
  // Architecture / design
  { url: 'https://www.archdaily.com/feed',                          source: 'ArchDaily',                category: 'design' },
  { url: 'https://www.dezeen.com/feed/',                            source: 'Dezeen',                   category: 'design' },
  { url: 'https://inhabitat.com/feed/',                             source: 'Inhabitat',                category: 'design' },
];

function fetchUrl(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'EthosInsights/1.0' }, timeout: 8000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchUrl(res.headers.location).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function parseFeed(feed) {
  try {
    const xml = await fetchUrl(feed.url);
    const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
    const obj = parser.parse(xml);
    const channel = obj?.rss?.channel || obj?.feed;
    if (!channel) return [];
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
    console.error('Feed error', feed.source, e.message);
    return [];
  }
}

const insertArticle = db.prepare(`
  INSERT OR IGNORE INTO articles (guid, title, link, summary, source, category, pub_date)
  VALUES (@guid, @title, @link, @summary, @source, @category, @pub_date)
`);

async function refreshFeeds() {
  console.log('Refreshing insight feeds...');
  let count = 0;
  for (const feed of FEEDS) {
    const articles = await parseFeed(feed);
    for (const a of articles) {
      try { insertArticle.run(a); count++; } catch (_) {}
    }
  }
  console.log(`Feeds refreshed — ${count} new articles stored.`);
}

// Refresh on startup + every 3 hours
refreshFeeds();
setInterval(refreshFeeds, 3 * 60 * 60 * 1000);

// API: latest insights with optional category filter
app.get('/api/insights', (req, res) => {
  const { category, limit = 30, offset = 0 } = req.query;
  let rows;
  if (category && category !== 'all') {
    rows = db.prepare(
      'SELECT * FROM articles WHERE category = ? ORDER BY pub_date DESC LIMIT ? OFFSET ?'
    ).all(category, Number(limit), Number(offset));
  } else {
    rows = db.prepare(
      'SELECT * FROM articles ORDER BY pub_date DESC LIMIT ? OFFSET ?'
    ).all(Number(limit), Number(offset));
  }
  res.json(rows);
});

// Manual refresh trigger (admin only)
app.post('/api/insights/refresh', (req, res) => {
  const { pass } = req.query;
  if (pass !== ADMIN_PASS) return res.status(401).json({ error: 'Unauthorised' });
  refreshFeeds().then(() => res.json({ ok: true }));
});

// Submit lead
app.post('/submit', (req, res) => {
  const { name, email, message } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  db.prepare('INSERT INTO leads (name, email, message) VALUES (?, ?, ?)').run(name || '', email, message || '');
  res.json({ ok: true });
});

// Admin page — password protected
const ADMIN_PASS = process.env.ADMIN_PASS || 'ethos2026';
app.get('/admin', (req, res) => {
  const { pass } = req.query;
  if (pass !== ADMIN_PASS) {
    return res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
    <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b0f14;color:#e2e8f0;font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh}
    form{display:flex;flex-direction:column;gap:1rem;width:300px}input{padding:.75rem 1rem;background:#141b24;border:1px solid #1e2d3d;border-radius:8px;color:#e2e8f0;font-size:1rem}
    button{padding:.75rem;background:#3b82f6;color:#fff;border:none;border-radius:8px;font-size:1rem;font-weight:600;cursor:pointer}h2{text-align:center;font-weight:500}</style></head>
    <body><form method="GET"><h2>Admin</h2><input type="password" name="pass" placeholder="Password" autofocus><button type="submit">Enter</button></form></body></html>`);
  }
  const leads = db.prepare('SELECT * FROM leads ORDER BY created_at DESC').all();
  const rows = leads.map(l => `<tr><td>${l.id}</td><td>${l.created_at}</td><td>${l.name||''}</td><td>${l.email}</td><td>${l.message||''}</td></tr>`).join('');
  res.send(`<!DOCTYPE html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
  <style>*{margin:0;padding:0;box-sizing:border-box}body{background:#0b0f14;color:#e2e8f0;font-family:system-ui;padding:2rem}
  h1{margin-bottom:1.5rem;font-weight:500;color:#93c5fd}table{width:100%;border-collapse:collapse;font-size:.875rem}
  th{text-align:left;padding:.75rem 1rem;background:#141b24;color:#64748b;font-weight:600;border-bottom:1px solid #1e2d3d}
  td{padding:.75rem 1rem;border-bottom:1px solid #1a2332;vertical-align:top}tr:hover td{background:#0f1923}
  .count{color:#64748b;font-size:.875rem;margin-bottom:1rem}</style></head>
  <body><h1>Leads</h1><p class="count">${leads.length} total</p>
  <table><thead><tr><th>#</th><th>Date</th><th>Name</th><th>Email</th><th>Message</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`);
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log('Ethos running on port ' + PORT));
