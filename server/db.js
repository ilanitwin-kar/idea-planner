import sqlite3 from "sqlite3";

sqlite3.verbose();

export function openDb(path = "./data.sqlite") {
  const db = new sqlite3.Database(path);
  db.serialize(() => {
    db.run(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        endpoint TEXT NOT NULL UNIQUE,
        user_key TEXT NOT NULL DEFAULT 'local',
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    db.run(`
      CREATE TABLE IF NOT EXISTS reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subtask_id TEXT NOT NULL,
        reminder_key TEXT,
        user_key TEXT NOT NULL DEFAULT 'local',
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        url TEXT NOT NULL,
        fire_at INTEGER NOT NULL,
        sent_at INTEGER,
        created_at INTEGER NOT NULL
      )
    `);

    // Backwards-compatible migrations (ignore errors if already applied)
    db.run(`ALTER TABLE subscriptions ADD COLUMN user_key TEXT`, () => {});
    db.run(`ALTER TABLE reminders ADD COLUMN user_key TEXT`, () => {});
    db.run(`ALTER TABLE reminders ADD COLUMN reminder_key TEXT`, () => {});

    // Indexes (ignore errors if columns not present yet)
    db.run(`CREATE INDEX IF NOT EXISTS idx_reminders_fire_at ON reminders(fire_at)`, () => {});
    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reminders_pending_unique ON reminders(subtask_id, reminder_key, user_key) WHERE sent_at IS NULL`,
      () => {},
    );
  });
  return db;
}

export function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve({ changes: this.changes, lastID: this.lastID });
    });
  });
}

export function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

