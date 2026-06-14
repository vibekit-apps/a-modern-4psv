const express = require('express');
const path = require('path');
const Database = require('better-sqlite3');

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
