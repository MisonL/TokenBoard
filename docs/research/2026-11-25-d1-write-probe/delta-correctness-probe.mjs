import { DatabaseSync } from 'node:sqlite'
const db = new DatabaseSync(':memory:')
db.exec(`
CREATE TABLE summary(user_id TEXT, d TEXT, model TEXT, tokens INT, PRIMARY KEY(user_id,d,model));
CREATE TABLE totals(user_id TEXT PRIMARY KEY, tokens INT DEFAULT 0, updated_at TEXT);
`)

// Scenario 1: totals row missing while summary rows already exist for other keys.
db.prepare("INSERT INTO summary VALUES('u',?,?,?)").run('2026-11-01','m',100)
db.prepare("INSERT INTO summary VALUES('u',?,?,?)").run('2026-11-02','m',200)
// init-then-delta as designed
const newVal = 300, key='2026-11-01'
db.prepare("INSERT OR IGNORE INTO totals(user_id,tokens,updated_at) VALUES(?,0,'t')").run('u')
db.prepare(`UPDATE totals SET tokens = tokens + ? - COALESCE((SELECT tokens FROM summary WHERE user_id=? AND d=? AND model=?),0) WHERE user_id=?`).run(newVal,'u',key,'m','u')
db.prepare("INSERT OR REPLACE INTO summary VALUES(?,?,?,?)").run('u',key,'m',newVal)
console.log('S1 totals after (expect 500):', db.prepare('SELECT tokens FROM totals').get().tokens)

// Scenario 2: summary row vanished but totals still counts it.
const db2 = new DatabaseSync(':memory:')
db2.exec(`CREATE TABLE summary(user_id TEXT, d TEXT, model TEXT, tokens INT, PRIMARY KEY(user_id,d,model));
CREATE TABLE totals(user_id TEXT PRIMARY KEY, tokens INT DEFAULT 0);`)
db2.prepare("INSERT INTO totals VALUES('u',100)").run()  // totals counted a summary that is now gone
db2.prepare(`UPDATE totals SET tokens = tokens + ? - COALESCE((SELECT tokens FROM summary WHERE user_id='u'),0)`).run(100)
console.log('S2 totals (expect 100 correct=200 double-count):', db2.prepare('SELECT tokens FROM totals').get().tokens)

// Scenario 3: strftime('now') across two statements in one transaction.
const db3 = new DatabaseSync(':memory:')
db3.exec("CREATE TABLE a(t TEXT); CREATE TABLE b(t TEXT);")
db3.exec('BEGIN')
db3.exec("INSERT INTO a VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
db3.exec("INSERT INTO b VALUES (strftime('%Y-%m-%dT%H:%M:%fZ','now'))")
db3.exec('COMMIT')
const a = db3.prepare('SELECT t FROM a').get().t, b = db3.prepare('SELECT t FROM b').get().t
console.log('S3 timestamps equal within txn?', a === b, a, b)
