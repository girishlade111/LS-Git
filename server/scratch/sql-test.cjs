const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(':memory:');
db.exec(`CREATE TABLE project_redirects (owner_username TEXT NOT NULL, path TEXT NOT NULL COLLATE NOCASE, project_id INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (owner_username, path))`);
try {
  db.prepare(`INSERT OR REPLACE INTO project_redirects (owner_username, path, project_id, created_at)
   SELECT ?, ?, ?, ?
   WHERE NOT EXISTS (SELECT 1)`).run('a','b',1,'now');
  console.log('ok');
} catch (e) { console.log('ERR:', e.message); }
