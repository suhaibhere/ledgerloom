const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const usePostgres = Boolean(process.env.DATABASE_URL);
let sqlite;
let pool;

const postgresSchema = fs.readFileSync(path.join(__dirname, 'postgres.sql'), 'utf8');

function pgSQL(sql) {
  return sql.replace(/\?/g, (_, offset) => `$${(sql.slice(0, offset).match(/\?/g) || []).length + 1}`)
    .replace(/\s+COLLATE\s+NOCASE/gi, '')
    .replace(/\bLIKE\b/gi, 'ILIKE');
}

async function initialize() {
  if (usePostgres) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'disable' ? false : { rejectUnauthorized: false }, max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000 });
    await pool.query(postgresSchema);
    await pool.query("ALTER TABLE receipts ADD COLUMN IF NOT EXISTS file_data BYTEA");
    return;
  }
  if (process.env.NODE_ENV === 'production') throw new Error('DATABASE_URL must point to a persistent PostgreSQL database in production.');
  const filename = path.resolve(ROOT, process.env.DATABASE_PATH || './data/ledgerloom.sqlite');
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  sqlite = new DatabaseSync(filename);
  sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
  sqlite.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  for (const migration of fs.readdirSync(path.join(ROOT, 'database/migrations')).filter(name => name.endsWith('.sql')).sort()) {
    if (sqlite.prepare('SELECT version FROM schema_migrations WHERE version=?').get(migration)) continue;
    sqlite.exec('BEGIN IMMEDIATE');
    try { sqlite.exec(fs.readFileSync(path.join(ROOT, 'database/migrations', migration), 'utf8')); sqlite.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(migration); sqlite.exec('COMMIT'); }
    catch (error) { sqlite.exec('ROLLBACK'); throw error; }
  }
  try { sqlite.exec('ALTER TABLE receipts ADD COLUMN file_data BLOB'); } catch (error) { if (!/duplicate column/i.test(error.message)) throw error; }
}

function normalize(sql, values = []) { return usePostgres ? { sql: pgSQL(sql), values } : { sql: sql.replace(/\$(\d+)/g, '?'), values }; }
async function query(sql, values = [], client = pool) {
  const stmt = normalize(sql, values);
  if (usePostgres) { const result = await client.query(stmt.sql, stmt.values); return { rows: result.rows, rowCount: result.rowCount }; }
  const q = sqlite.prepare(stmt.sql);
  if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(stmt.sql)) return { rows: q.all(...stmt.values), rowCount: 0 };
  const result = q.run(...stmt.values);
  return { rows: [], rowCount: result.changes, lastInsertRowid: result.lastInsertRowid };
}
async function transaction(fn) {
  if (usePostgres) {
    const client = await pool.connect();
    try { await client.query('BEGIN'); const value = await fn(client); await client.query('COMMIT'); return value; }
    catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }
  sqlite.exec('BEGIN IMMEDIATE');
  try { const value = await fn(sqlite); sqlite.exec('COMMIT'); return value; }
  catch (error) { sqlite.exec('ROLLBACK'); throw error; }
}
async function close() { if (pool) await pool.end(); if (sqlite) sqlite.close(); }

module.exports = { initialize, query, transaction, close, get kind() { return usePostgres ? 'postgres' : 'sqlite'; } };
