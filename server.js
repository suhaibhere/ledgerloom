const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Busboy = require('busboy');
const ledger = require('./services/ledger');
const store = require('./database/store');

const ROOT = __dirname;
require('dotenv').config({ path: path.join(ROOT, '.env') });
const isProd = process.env.NODE_ENV === 'production';
const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || (isProd ? '0.0.0.0' : '127.0.0.1');
const DATA_DIR = path.resolve(ROOT, process.env.DATABASE_PATH || './data/ledgerloom.sqlite');
const RECEIPT_DIR = path.join(path.dirname(DATA_DIR), 'receipts');
if (isProd && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('Set SESSION_SECRET (at least 32 characters) for production.');
if (!process.env.DATABASE_URL && !isProd) { fs.mkdirSync(path.dirname(DATA_DIR), { recursive: true }); fs.mkdirSync(RECEIPT_DIR, { recursive: true }); }

const q = (sql, params = [], client) => store.query(sql, params, client);
const one = async (sql, params = [], client) => (await q(sql, params, client)).rows[0] || null;
const all = async (sql, params = [], client) => (await q(sql, params, client)).rows;
const run = async (sql, params = [], client) => q(sql, params, client);
const safeUser = row => row ? ({ id: row.id, email: row.email, fullName: row.name }) : null;
const publicTransaction = row => row ? ({ id: row.id, date: row.transaction_date, amount: Number(row.amount), type: row.type, merchant: row.merchant, description: row.description, paymentMethod: row.payment_method, transactionReference: row.transaction_reference, source: row.source, category: row.category, subcategory: row.subcategory, confidence: Number(row.confidence), notes: row.notes, duplicateOf: row.duplicate_of, createdAt: row.created_at }) : null;
const hash = value => crypto.createHmac('sha256', process.env.SESSION_SECRET || 'ledgerloom-local-development-key').update(value).digest('hex');
const cookieName = 'ledgerloom_session';
const loginFailures = new Map();

function cookies(req) { return Object.fromEntries((req.headers.cookie || '').split(';').map(value => value.trim().split('=').map(decodeURIComponent)).filter(parts => parts.length === 2)); }
function setCookie(res, token, maxAge) { res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isProd ? '; Secure' : ''}`); }
async function userFromRequest(req) {
  const token = cookies(req)[cookieName];
  if (!token) return null;
  return one('SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?', [hash(token), new Date().toISOString()]);
}
function send(res, status, data, headers = {}) { const body = data === undefined ? '' : JSON.stringify(data); res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers }); res.end(body); }
function fail(res, status, message) { send(res, status, { error: message }); }
function readJSON(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(Object.assign(Error('Request body is too large.'), { status: 413 })); req.destroy(); return; } chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(Object.assign(Error('Invalid JSON body.'), { status: 400 })); } }); req.on('error', reject);
  });
}
function validString(value, max = 200) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
function validISODate(value) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false; const parsed = new Date(`${value}T12:00:00Z`); return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === value; }
function multipart(req, accept) {
  return new Promise((resolve, reject) => {
    let file = null, filename = '', mime = '', parser;
    try { parser = Busboy({ headers: req.headers, limits: { files: 1, fileSize: 10 * 1024 * 1024, fields: 5 } }); } catch { reject(Object.assign(Error('Expected a multipart file upload.'), { status: 400 })); return; }
    parser.on('file', (name, stream, info) => {
      if (name !== 'file') { stream.resume(); return; }
      filename = path.basename(info.filename || 'upload'); mime = info.mimeType; const chunks = [];
      stream.on('data', chunk => chunks.push(chunk)); stream.on('limit', () => reject(Object.assign(Error('Files must be 10 MB or smaller.'), { status: 413 })));
      stream.on('end', () => { file = Buffer.concat(chunks); });
    });
    parser.on('error', reject); parser.on('finish', () => { if (!file || !accept(filename, mime)) { reject(Object.assign(Error('Unsupported file. Please upload a CSV or XLSX statement.'), { status: 415 })); return; } resolve({ file, filename, mime }); }); req.pipe(parser);
  });
}
function checkZipSize(buffer, maxUnpacked = 100 * 1024 * 1024) {
  if (buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) throw Object.assign(Error('This file is not a valid XLSX workbook.'), { status: 415 });
  let end = -1; for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) if (buffer.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw Object.assign(Error('This workbook is incomplete or invalid.'), { status: 415 });
  const entries = buffer.readUInt16LE(end + 10), offset = buffer.readUInt32LE(end + 16); if (entries > 2000) throw Object.assign(Error('This workbook contains too many archive entries.'), { status: 413 });
  let position = offset, total = 0; for (let n = 0; n < entries; n++) { if (position + 46 > buffer.length || buffer.readUInt32LE(position) !== 0x02014b50) throw Object.assign(Error('This workbook is incomplete or invalid.'), { status: 415 }); total += buffer.readUInt32LE(position + 24); if (total > maxUnpacked) throw Object.assign(Error('The uncompressed workbook is too large to process safely.'), { status: 413 }); position += 46 + buffer.readUInt16LE(position + 28) + buffer.readUInt16LE(position + 30) + buffer.readUInt16LE(position + 32); }
}
async function importRows(filename, buffer) {
  const ext = path.extname(filename).toLowerCase(); if (ext === '.csv' || ext === '.txt') return ledger.parseCSV(buffer);
  if (ext === '.xlsx') { checkZipSize(buffer); const readXlsxFile = (await import('read-excel-file/node')).default; const sheets = await readXlsxFile(buffer); const rows = Array.isArray(sheets?.[0]?.data) ? sheets[0].data : sheets; if (!Array.isArray(rows) || rows.length < 2) throw Error('The workbook needs a header row and at least one transaction.'); if (rows.length > 50001 || rows.some(row => row.length > 100)) throw Error('This workbook has too many rows or columns to import safely.'); return rows.map(row => row.map(value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? ''))); }
  throw Object.assign(Error('Unsupported file format. Upload CSV or XLSX.'), { status: 415 });
}
async function customRules(userId) { const rows = await all('SELECT * FROM merchant_rules WHERE user_id=?', [userId]); return new Map(rows.map(row => [ledger.norm(row.canonical_name), { category: row.category, subcategory: row.subcategory }])); }
async function transactionsFor(userId) { return (await all('SELECT * FROM transactions WHERE user_id=? ORDER BY transaction_date DESC,created_at DESC', [userId])).map(publicTransaction); }
async function userTransaction(userId, id) { return one('SELECT * FROM transactions WHERE user_id=? AND id=?', [userId, id]); }
async function insertOne(userId, transaction, source = transaction.source || 'Manual entry', client) {
  const existing = await one('SELECT id FROM transactions WHERE user_id=? AND transaction_date=? AND merchant=? COLLATE NOCASE AND amount=? AND type=? AND source=?', [userId, transaction.date, transaction.merchant, transaction.amount, transaction.type, source], client);
  if (existing) return false;
  const duplicate = await one('SELECT id FROM transactions WHERE user_id=? AND transaction_date=? AND merchant=? COLLATE NOCASE AND amount=? AND type=? ORDER BY created_at LIMIT 1', [userId, transaction.date, transaction.merchant, transaction.amount, transaction.type], client);
  await run('INSERT INTO transactions(id,user_id,transaction_date,amount,type,merchant,description,payment_method,transaction_reference,source,category,subcategory,confidence,notes,duplicate_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)', [transaction.id || crypto.randomUUID(), userId, transaction.date, transaction.amount, transaction.type, transaction.merchant, transaction.description || '', transaction.paymentMethod || 'UPI', transaction.transactionReference || null, source, transaction.category, transaction.subcategory || '', transaction.confidence ?? 1, transaction.notes || '', duplicate?.id || null], client);
  return true;
}
function jsonSafeError(res, error) { if (error.status) { fail(res, error.status, error.message); return; } console.error(error); fail(res, 500, 'The request could not be completed. Please try again.'); }

async function handleAPI(req, res, url) {
  const method = req.method, route = url.pathname;
  if (route === '/api/health' && method === 'GET') return send(res, 200, { status: 'ok', database: store.kind });
  if (route === '/api/auth/register' && method === 'POST') {
    const body = await readJSON(req), email = String(body.email || '').trim().toLowerCase(), name = String(body.name || '').trim(), password = body.password;
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254) return fail(res, 400, 'Enter a valid email address.');
    if (!validString(name, 80)) return fail(res, 400, 'Name must be between 1 and 80 characters.');
    if (typeof password !== 'string' || password.length < 10 || password.length > 200) return fail(res, 400, 'Password must contain at least 10 characters.');
    if (body.confirmPassword !== password) return fail(res, 400, 'Passwords do not match.');
    const id = crypto.randomUUID(), salt = crypto.randomBytes(16).toString('hex'), passwordHash = `scrypt$${salt}$${crypto.scryptSync(password, salt, 64).toString('hex')}`;
    try { await run('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)', [id, email, name, passwordHash]); }
    catch (error) { if (error.code === '23505' || String(error.code || '').startsWith('SQLITE_CONSTRAINT') || /unique constraint failed/i.test(error.message)) return fail(res, 409, 'An account with this email already exists.'); throw error; }
    const token = crypto.randomBytes(32).toString('base64url'); await run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [hash(token), id, new Date(Date.now() + 30 * 86400000).toISOString()]); setCookie(res, token, 30 * 86400); return send(res, 201, { user: { id, email, fullName: name } });
  }
  if (route === '/api/auth/login' && method === 'POST') {
    const body = await readJSON(req), email = String(body.email || '').trim().toLowerCase(), user = await one('SELECT * FROM users WHERE lower(email)=lower(?)', [email]);
    const attemptKey = `${req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'local'}:${email}`, previous = loginFailures.get(attemptKey);
    if (previous && previous.until > Date.now() && previous.count >= 8) return fail(res, 429, 'Too many sign-in attempts. Please wait 15 minutes and try again.');
    const parts = user?.password_hash.split('$'); let ok = false;
    if (parts?.length === 3 && parts[0] === 'scrypt') { const candidate = crypto.scryptSync(String(body.password || ''), parts[1], 64); ok = crypto.timingSafeEqual(candidate, Buffer.from(parts[2], 'hex')); }
    if (!ok) { const active = previous && previous.until > Date.now() ? previous : { count: 0, until: Date.now() + 15 * 60 * 1000 }; active.count++; loginFailures.set(attemptKey, active); return fail(res, 401, 'Email or password is incorrect.'); }
    loginFailures.delete(attemptKey); const token = crypto.randomBytes(32).toString('base64url'); await run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', [hash(token), user.id, new Date(Date.now() + 30 * 86400000).toISOString()]); setCookie(res, token, 30 * 86400); return send(res, 200, { user: safeUser(user) });
  }
  if (route === '/api/auth/logout' && method === 'POST') { const token = cookies(req)[cookieName]; if (token) await run('DELETE FROM sessions WHERE token_hash=?', [hash(token)]); setCookie(res, '', 0); return send(res, 200, { ok: true }); }
  if (route === '/api/auth/me' && method === 'GET') { const user = await userFromRequest(req); return user ? send(res, 200, { user: safeUser(user) }) : fail(res, 401, 'Sign in to continue.'); }

  const user = await userFromRequest(req); if (!user) return fail(res, 401, 'Sign in to continue.'); const uid = user.id;
  if (route === '/api/dashboard' && method === 'GET') { const tx = await transactionsFor(uid), months = Math.min(12, Math.max(1, Number(url.searchParams.get('months') || 6))), metrics = ledger.dashboardMetrics(tx, new Date(), months); const imports = await all('SELECT id,filename,status,transaction_count AS "transactionCount",duplicate_count AS "duplicateCount",created_at AS "createdAt" FROM imports WHERE user_id=? ORDER BY created_at DESC LIMIT 10', [uid]); return send(res, 200, { ...metrics, recent: tx.slice(0, 8), imports }); }
  if (route === '/api/transactions' && method === 'GET') {
    const page = Math.min(100000, Math.max(1, Number(url.searchParams.get('page') || 1))), limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit') || 50))), params = [uid]; let where = 'user_id=?';
    for (const [key, column] of [['type', 'type'], ['category', 'category'], ['merchant', 'merchant']]) { const value = url.searchParams.get(key); if (value && value !== 'all') { where += ` AND ${column}=?`; params.push(value); } }
    const search = url.searchParams.get('search'); if (search) { where += ' AND (merchant LIKE ? OR description LIKE ? OR notes LIKE ?)'; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    const from = url.searchParams.get('from'), to = url.searchParams.get('to'); if (from && validISODate(from)) { where += ' AND transaction_date>=?'; params.push(from); } if (to && validISODate(to)) { where += ' AND transaction_date<=?'; params.push(to); }
    const sort = url.searchParams.get('sort'), order = sort === 'oldest' ? 'transaction_date ASC' : sort === 'highest' ? 'amount DESC' : sort === 'lowest' ? 'amount ASC' : 'transaction_date DESC';
    const count = await one(`SELECT COUNT(*) AS n FROM transactions WHERE ${where}`, params), rows = await all(`SELECT * FROM transactions WHERE ${where} ORDER BY ${order},created_at DESC LIMIT ? OFFSET ?`, [...params, limit, (page - 1) * limit]); const total = Number(count.n);
    return send(res, 200, { items: rows.map(publicTransaction), page, limit, total, pages: Math.max(1, Math.ceil(total / limit)) });
  }
  if (route === '/api/transactions' && method === 'POST') {
    const body = await readJSON(req); if (!ledger.CATEGORIES.includes(body.category) || !ledger.TYPES.includes(body.type) || !validISODate(body.date) || !Number.isFinite(Number(body.amount)) || Number(body.amount) <= 0 || Number(body.amount) > 1_000_000_000 || !validString(body.merchant, 100)) return fail(res, 400, 'Provide a merchant, amount, valid date, type and category.');
    const transaction = { id: crypto.randomUUID(), date: body.date, amount: Number(body.amount), type: body.type, merchant: body.merchant.trim(), description: String(body.description || '').slice(0, 500), paymentMethod: String(body.paymentMethod || 'Manual').slice(0, 80), transactionReference: String(body.transactionReference || '').slice(0, 120), category: body.category, subcategory: String(body.subcategory || '').slice(0, 100), notes: String(body.notes || '').slice(0, 500), confidence: 1 };
    await insertOne(uid, transaction); return send(res, 201, { transaction: publicTransaction(await userTransaction(uid, transaction.id)) });
  }
  const match = route.match(/^\/api\/transactions\/([a-f0-9-]+)$/i);
  if (match && method === 'PUT') {
    const id = match[1], existing = await userTransaction(uid, id); if (!existing) return fail(res, 404, 'Transaction not found.'); const body = await readJSON(req), merged = { ...publicTransaction(existing), ...body };
    if (!ledger.CATEGORIES.includes(merged.category) || !ledger.TYPES.includes(merged.type) || !validISODate(merged.date) || !Number.isFinite(Number(merged.amount)) || Number(merged.amount) <= 0 || Number(merged.amount) > 1_000_000_000 || !validString(merged.merchant, 100)) return fail(res, 400, 'Transaction details are invalid.');
    await run('UPDATE transactions SET transaction_date=?,amount=?,type=?,merchant=?,description=?,payment_method=?,transaction_reference=?,category=?,subcategory=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?', [merged.date, Number(merged.amount), merged.type, merged.merchant.trim(), String(merged.description || '').slice(0, 500), String(merged.paymentMethod || 'UPI').slice(0, 80), String(merged.transactionReference || '').slice(0, 120), merged.category, String(merged.subcategory || '').slice(0, 100), String(merged.notes || '').slice(0, 500), id, uid]);
    await run('INSERT INTO merchant_rules(id,user_id,merchant_key,canonical_name,category,subcategory) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,merchant_key) DO UPDATE SET category=excluded.category,subcategory=excluded.subcategory,canonical_name=excluded.canonical_name', [crypto.randomUUID(), uid, ledger.norm(merged.merchant), merged.merchant.trim(), merged.category, String(merged.subcategory || '')]);
    return send(res, 200, { transaction: publicTransaction(await userTransaction(uid, id)) });
  }
  if (match && method === 'DELETE') { const result = await run('DELETE FROM transactions WHERE id=? AND user_id=?', [match[1], uid]); if (!result.rowCount) return fail(res, 404, 'Transaction not found.'); return send(res, 200, { ok: true }); }
  if ((route === '/api/imports' || route === '/api/transactions/import') && method === 'POST') {
    const { file, filename } = await multipart(req, name => /\.(csv|txt|xlsx)$/i.test(name)); let imported = [], duplicateCount = 0; const importId = crypto.randomUUID();
    try {
      const rows = await importRows(filename, file); if (rows.length > 50001 || rows.some(row => row.length > 100)) throw Object.assign(Error('This statement has too many rows or columns to import safely.'), { status: 413 }); imported = ledger.normalizeRows(rows, await customRules(uid));
      await store.transaction(async client => { for (const transaction of imported) if (!await insertOne(uid, transaction, 'Imported statement', client)) duplicateCount++; await run("INSERT INTO imports(id,user_id,filename,status,transaction_count,duplicate_count) VALUES(?,?,?,'complete',?,?)", [importId, uid, filename, imported.length - duplicateCount, duplicateCount], client); });
      const count = imported.length - duplicateCount; return send(res, 201, { importId, filename, parsed: imported.length, imported: count, duplicates: duplicateCount, message: count ? `Imported ${count} transactions.` : 'All transactions in this statement were already imported.' });
    } catch (error) { await run("INSERT INTO imports(id,user_id,filename,status,transaction_count) VALUES(?,?,?,'failed',0)", [importId, uid, filename]).catch(() => {}); return fail(res, error.status || 422, error.message || 'Statement parsing failed.'); }
  }
  if (route === '/api/transactions/summary' && method === 'GET') { const metrics = ledger.dashboardMetrics(await transactionsFor(uid)); return send(res, 200, { totalSpent: metrics.totalSpent, income: metrics.income, refunds: metrics.refunds, transfers: metrics.transfers, transactionCount: metrics.transactionCount, topCategory: metrics.categories[0] || null, topMerchant: metrics.merchants[0] || null }); }
  if (route === '/api/transactions/categories' && method === 'GET') return send(res, 200, { items: ledger.dashboardMetrics(await transactionsFor(uid)).categories });
  if (route === '/api/transactions/merchants' && method === 'GET') return send(res, 200, { items: await all("SELECT merchant,COUNT(*) AS \"transactionCount\",SUM(CASE WHEN type='EXPENSE' THEN amount ELSE 0 END) AS \"totalSpent\" FROM transactions WHERE user_id=? GROUP BY merchant ORDER BY merchant COLLATE NOCASE", [uid]) });
  if (route === '/api/receipts' && method === 'GET') return send(res, 200, { items: await all('SELECT id,filename,mime_type AS "mimeType",size_bytes AS "sizeBytes",status,created_at AS "createdAt" FROM receipts WHERE user_id=? ORDER BY created_at DESC', [uid]) });
  if (route === '/api/receipts' && method === 'POST') {
    const { file, filename, mime } = await multipart(req, (name, type) => /\.(png|jpe?g|pdf)$/i.test(name) && ['image/png', 'image/jpeg', 'application/pdf'].includes(type)); if (file.length > 8 * 1024 * 1024) return fail(res, 413, 'Receipts must be 8 MB or smaller.');
    const signatureOK = mime === 'image/png' ? file.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) : mime === 'image/jpeg' ? file[0] === 255 && file[1] === 216 && file[2] === 255 : file.subarray(0, 5).toString() === '%PDF-'; if (!signatureOK) return fail(res, 415, 'The file contents do not match the selected receipt format.');
    const id = crypto.randomUUID(), ext = path.extname(filename).toLowerCase(); let filePath = '';
    if (!process.env.DATABASE_URL) { filePath = path.join(RECEIPT_DIR, `${id}${ext}`); fs.writeFileSync(filePath, file, { flag: 'wx' }); }
    await run('INSERT INTO receipts(id,user_id,filename,mime_type,file_path,size_bytes,file_data,status) VALUES(?,?,?,?,?,?,?,?)', [id, uid, filename, mime, filePath, file.length, process.env.DATABASE_URL ? file : null, 'needs_review']);
    return send(res, 201, { receipt: { id, filename, mimeType: mime, sizeBytes: file.length, status: 'needs_review', message: 'Receipt stored securely. OCR is not configured in this MVP; review and enter the transaction details manually.' } });
  }
  if (route.startsWith('/api/')) return fail(res, 404, 'API route not found.');
  return null;
}

const staticFiles = new Map([['/', 'index.html'], ['/index.html', 'index.html'], ['/styles.css', 'styles.css'], ['/app.js', 'app.js'], ['/sample-upi-statement.csv', 'sample-upi-statement.csv']]);
function serveStatic(req, res, url) { const name = staticFiles.get(url.pathname); if (!name) return fail(res, 404, 'Not found.'); const filename = path.join(ROOT, name), type = name.endsWith('.css') ? 'text/css' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.csv') ? 'text/csv' : 'text/html'; res.writeHead(200, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': name === 'index.html' ? 'no-cache' : 'public, max-age=300' }); fs.createReadStream(filename).pipe(res); }
const server = http.createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('X-Frame-Options', 'DENY'); res.setHeader('Referrer-Policy', 'same-origin'); res.setHeader('Permissions-Policy', 'camera=(),microphone=(),geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url = new URL(req.url, 'http://localhost');
  try { if (url.pathname.startsWith('/api/')) { if (['POST', 'PUT', 'DELETE', 'PATCH'].includes(req.method)) { const origin = req.headers.origin, host = req.headers['x-forwarded-host'] || req.headers.host; if (origin && origin !== `http://${host}` && origin !== `https://${host}`) return fail(res, 403, 'Cross-origin requests are not allowed.'); } const handled = await handleAPI(req, res, url); if (handled === null) return fail(res, 404, 'API route not found.'); return; } if (req.method !== 'GET' && req.method !== 'HEAD') return fail(res, 405, 'Method not allowed.'); return serveStatic(req, res, url); }
  catch (error) { jsonSafeError(res, error); }
});
function listenAtAvailablePort(port, attempt = 0) {
  const onError = error => { server.removeListener('listening', onListening); if (error.code === 'EADDRINUSE' && attempt < 20) { listenAtAvailablePort(port + 1, attempt + 1); return; } console.error(`LedgerLoom could not start on port ${port}: ${error.message}`); process.exitCode = 1; };
  const onListening = () => { server.removeListener('error', onError); const address = server.address(), displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST; console.log(`LedgerLoom running at http://${displayHost}:${address.port} (${store.kind})`); };
  server.once('error', onError); server.once('listening', onListening); server.listen(port, HOST);
}
store.initialize().then(() => listenAtAvailablePort(PORT)).catch(error => { console.error(`LedgerLoom database could not initialize: ${error.message}`); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { store.close().finally(() => server.close(() => process.exit(0))); });
