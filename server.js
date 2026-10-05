const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const Busboy = require('busboy');
const ledger = require('./services/ledger');

const ROOT=__dirname;
require('dotenv').config({path:path.join(ROOT,'.env')});
const isProd=process.env.NODE_ENV==='production';const PORT=Number(process.env.PORT||4173);const HOST=process.env.HOST||(isProd?'0.0.0.0':'127.0.0.1');const DB_PATH=path.resolve(ROOT,process.env.DATABASE_PATH||'./data/ledgerloom.sqlite');
const DATA_DIR=path.dirname(DB_PATH);const RECEIPT_DIR=path.join(DATA_DIR,'receipts');
if(isProd&&(!process.env.SESSION_SECRET||process.env.SESSION_SECRET.length<32))throw new Error('Set SESSION_SECRET (at least 32 characters) for production.');
fs.mkdirSync(DATA_DIR,{recursive:true});fs.mkdirSync(RECEIPT_DIR,{recursive:true});
const db=new DatabaseSync(DB_PATH);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
for(const filename of fs.readdirSync(path.join(ROOT,'database/migrations')).filter(x=>x.endsWith('.sql')).sort()){
  if(db.prepare('SELECT version FROM schema_migrations WHERE version=?').get(filename))continue;
  db.exec('BEGIN IMMEDIATE');try{db.exec(fs.readFileSync(path.join(ROOT,'database/migrations',filename),'utf8'));db.prepare('INSERT INTO schema_migrations(version) VALUES(?)').run(filename);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
}

const insertTransaction=db.prepare(`INSERT INTO transactions(id,user_id,transaction_date,amount,type,merchant,description,payment_method,transaction_reference,source,category,subcategory,confidence,notes,duplicate_of) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
const userTransaction=(userId,id)=>db.prepare('SELECT * FROM transactions WHERE user_id=? AND id=?').get(userId,id);
const safeUser=row=>row?({id:row.id,email:row.email,fullName:row.name}):null;
const publicTransaction=row=>({id:row.id,date:row.transaction_date,amount:row.amount,type:row.type,merchant:row.merchant,description:row.description,paymentMethod:row.payment_method,transactionReference:row.transaction_reference,source:row.source,category:row.category,subcategory:row.subcategory,confidence:row.confidence,notes:row.notes,duplicateOf:row.duplicate_of,createdAt:row.created_at});
const hash=s=>crypto.createHmac('sha256',process.env.SESSION_SECRET||'ledgerloom-local-development-key').update(s).digest('hex');
const cookieName='ledgerloom_session';
const loginFailures=new Map();
function cookies(req){return Object.fromEntries((req.headers.cookie||'').split(';').map(x=>x.trim().split('=').map(decodeURIComponent)).filter(x=>x.length===2));}
function setCookie(res,token,maxAge){res.setHeader('Set-Cookie',`${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isProd?'; Secure':''}`);}
function userFromRequest(req){const token=cookies(req)[cookieName];if(!token)return null;const row=db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(hash(token),new Date().toISOString());return row||null;}
function send(res,status,data,headers={}){const body=data===undefined?'':JSON.stringify(data);res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store',...headers});res.end(body);}
function fail(res,status,message){send(res,status,{error:message});}
function readJSON(req,limit=1024*1024){return new Promise((resolve,reject)=>{let chunks=[],size=0;req.on('data',c=>{size+=c.length;if(size>limit){reject(Object.assign(Error('Request body is too large.'),{status:413}));req.destroy();return;}chunks.push(c);});req.on('end',()=>{try{resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')||'{}'));}catch{reject(Object.assign(Error('Invalid JSON body.'),{status:400}));}});req.on('error',reject);});}
function validString(v,max=200){return typeof v==='string'&&v.trim().length>0&&v.trim().length<=max;}
function validISODate(value){if(!/^\d{4}-\d{2}-\d{2}$/.test(String(value)))return false;const parsed=new Date(`${value}T12:00:00Z`);return !Number.isNaN(+parsed)&&parsed.toISOString().slice(0,10)===value;}
function insertOne(userId,t,source=t.source||'Manual entry'){
  const existing=db.prepare(`SELECT id FROM transactions WHERE user_id=? AND transaction_date=? AND merchant=? COLLATE NOCASE AND amount=? AND type=? AND source=?`).get(userId,t.date,t.merchant,t.amount,t.type,source);
  let duplicateOf=null;if(!existing){duplicateOf=db.prepare(`SELECT id FROM transactions WHERE user_id=? AND transaction_date=? AND merchant=? COLLATE NOCASE AND amount=? AND type=? ORDER BY created_at LIMIT 1`).get(userId,t.date,t.merchant,t.amount,t.type)?.id||null;}
  if(existing)return false;
  insertTransaction.run(t.id||crypto.randomUUID(),userId,t.date,t.amount,t.type,t.merchant,t.description||'',t.paymentMethod||'UPI',t.transactionReference||null,source,t.category,t.subcategory||'',t.confidence??1,t.notes||'',duplicateOf);return true;
}
function transactionsFor(userId){return db.prepare('SELECT * FROM transactions WHERE user_id=? ORDER BY transaction_date DESC,created_at DESC').all(userId).map(publicTransaction);}
function multipart(req,accept){return new Promise((resolve,reject)=>{let file=null,filename='',mime='';let parser;try{parser=Busboy({headers:req.headers,limits:{files:1,fileSize:10*1024*1024,fields:5}});}catch{reject(Object.assign(Error('Expected a multipart file upload.'),{status:400}));return;}parser.on('file',(name,stream,info)=>{if(name!=='file'){stream.resume();return;}filename=path.basename(info.filename||'upload');mime=info.mimeType;const chunks=[];stream.on('data',c=>chunks.push(c));stream.on('limit',()=>reject(Object.assign(Error('Files must be 10 MB or smaller.'),{status:413})));stream.on('end',()=>{file=Buffer.concat(chunks);});});parser.on('error',reject);parser.on('finish',()=>{if(!file||!accept(filename,mime)){reject(Object.assign(Error('Unsupported file. Please upload a CSV or XLSX statement.'),{status:415}));return;}resolve({file,filename,mime});});req.pipe(parser);});}
function checkZipSize(buffer,maxUnpacked=100*1024*1024){if(buffer.length<22||buffer.readUInt32LE(0)!==0x04034b50)throw Object.assign(Error('This file is not a valid XLSX workbook.'),{status:415});let end=-1;for(let i=buffer.length-22;i>=Math.max(0,buffer.length-65557);i--)if(buffer.readUInt32LE(i)===0x06054b50){end=i;break;}if(end<0)throw Object.assign(Error('This workbook is incomplete or invalid.'),{status:415});const entries=buffer.readUInt16LE(end+10),offset=buffer.readUInt32LE(end+16);if(entries>2000)throw Object.assign(Error('This workbook contains too many archive entries.'),{status:413});let position=offset,total=0;for(let n=0;n<entries;n++){if(position+46>buffer.length||buffer.readUInt32LE(position)!==0x02014b50)throw Object.assign(Error('This workbook is incomplete or invalid.'),{status:415});total+=buffer.readUInt32LE(position+24);if(total>maxUnpacked)throw Object.assign(Error('The uncompressed workbook is too large to process safely.'),{status:413});position+=46+buffer.readUInt16LE(position+28)+buffer.readUInt16LE(position+30)+buffer.readUInt16LE(position+32);}return true;}
async function importRows(filename,buf){const ext=path.extname(filename).toLowerCase();if(ext==='.csv'||ext==='.txt')return ledger.parseCSV(buf);if(ext==='.xlsx'){checkZipSize(buf);const readXlsxFile=(await import('read-excel-file/node')).default;const sheets=await readXlsxFile(buf);const rows=Array.isArray(sheets?.[0]?.data)?sheets[0].data:sheets;if(!Array.isArray(rows)||rows.length<2)throw Error('The workbook needs a header row and at least one transaction.');if(rows.length>50001||rows.some(row=>row.length>100))throw Error('This workbook has too many rows or columns to import safely.');return rows.map(row=>row.map(v=>v instanceof Date?v.toISOString().slice(0,10):String(v??'')));}throw Object.assign(Error('Unsupported file format. Upload CSV or XLSX.'),{status:415});}
function customRules(userId){const rows=db.prepare('SELECT * FROM merchant_rules WHERE user_id=?').all(userId);return new Map(rows.map(r=>[ledger.norm(r.canonical_name),{category:r.category,subcategory:r.subcategory}]));}
function jsonSafeError(res,error){if(error.status){fail(res,error.status,error.message);return;}console.error(error);fail(res,500,'The request could not be completed. Please try again.');}

async function handleAPI(req,res,url){
  const method=req.method;const route=url.pathname;
  if(route==='/api/health'&&method==='GET')return send(res,200,{status:'ok',database:'sqlite'});
  if(route==='/api/auth/register'&&method==='POST'){
    const body=await readJSON(req);const email=String(body.email||'').trim().toLowerCase();const name=String(body.name||'').trim();const password=body.password;
    if(!/^\S+@\S+\.\S+$/.test(email)||email.length>254)return fail(res,400,'Enter a valid email address.');if(!validString(name,80))return fail(res,400,'Name must be between 1 and 80 characters.');if(typeof password!=='string'||password.length<10||password.length>200)return fail(res,400,'Password must contain at least 10 characters.');
    if(db.prepare('SELECT id FROM users WHERE email=?').get(email))return fail(res,409,'An account with this email already exists.');
    if(body.confirmPassword!==password)return fail(res,400,'Passwords do not match.');
    const id=crypto.randomUUID(),salt=crypto.randomBytes(16).toString('hex');const passwordHash=`scrypt$${salt}$${crypto.scryptSync(password,salt,64).toString('hex')}`;
    try{db.prepare('INSERT INTO users(id,email,name,password_hash) VALUES(?,?,?,?)').run(id,email,name,passwordHash);}catch(error){if(String(error.code||'').startsWith('SQLITE_CONSTRAINT'))return fail(res,409,'An account with this email already exists.');throw error;}const token=crypto.randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token),id,new Date(Date.now()+30*86400000).toISOString());setCookie(res,token,30*86400);return send(res,201,{user:{id,email,fullName:name}});
  }
  if(route==='/api/auth/login'&&method==='POST'){
    const body=await readJSON(req);const email=String(body.email||'').trim().toLowerCase();const user=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    const attemptKey=`${req.socket.remoteAddress||'local'}:${email}`,previous=loginFailures.get(attemptKey);if(previous&&previous.until>Date.now()&&previous.count>=8)return fail(res,429,'Too many sign-in attempts. Please wait 15 minutes and try again.');
    const parts=user?.password_hash.split('$');let ok=false;if(parts?.length===3&&parts[0]==='scrypt'){const candidate=crypto.scryptSync(String(body.password||''),parts[1],64);ok=crypto.timingSafeEqual(candidate,Buffer.from(parts[2],'hex'));}
    if(!ok){const active=previous&&previous.until>Date.now()?previous:{count:0,until:Date.now()+15*60*1000};active.count++;loginFailures.set(attemptKey,active);return fail(res,401,'Email or password is incorrect.');}loginFailures.delete(attemptKey);const token=crypto.randomBytes(32).toString('base64url');db.prepare('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)').run(hash(token),user.id,new Date(Date.now()+30*86400000).toISOString());setCookie(res,token,30*86400);return send(res,200,{user:safeUser(user)});
  }
  if(route==='/api/auth/logout'&&method==='POST'){const token=cookies(req)[cookieName];if(token)db.prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(token));setCookie(res,'',0);return send(res,200,{ok:true});}
  if(route==='/api/auth/me'&&method==='GET'){const u=userFromRequest(req);return u?send(res,200,{user:safeUser(u)}):fail(res,401,'Sign in to continue.');}
  const user=userFromRequest(req);if(!user)return fail(res,401,'Sign in to continue.');const uid=user.id;
  if(route==='/api/dashboard'&&method==='GET'){const tx=transactionsFor(uid);const months=Math.min(12,Math.max(1,Number(url.searchParams.get('months')||6)));const metrics=ledger.dashboardMetrics(tx,new Date(),months);const imports=db.prepare('SELECT id,filename,status,transaction_count AS transactionCount,duplicate_count AS duplicateCount,created_at AS createdAt FROM imports WHERE user_id=? ORDER BY created_at DESC LIMIT 10').all(uid);return send(res,200,{...metrics,recent:tx.slice(0,8),imports});}
  if(route==='/api/transactions'&&method==='GET'){
    const p=Math.min(100000,Math.max(1,Number(url.searchParams.get('page')||1))),limit=Math.min(100,Math.max(1,Number(url.searchParams.get('limit')||50)));const params=[uid];let where='user_id=?';
    for(const [key,column] of [['type','type'],['category','category'],['merchant','merchant']]){const v=url.searchParams.get(key);if(v&&v!=='all'){where+=` AND ${column}=?`;params.push(v);}}
    const search=url.searchParams.get('search');if(search){where+=' AND (merchant LIKE ? OR description LIKE ? OR notes LIKE ?)';params.push(`%${search}%`,`%${search}%`,`%${search}%`);}
    const from=url.searchParams.get('from'),to=url.searchParams.get('to');if(from&&validISODate(from)){where+=' AND transaction_date>=?';params.push(from);}if(to&&validISODate(to)){where+=' AND transaction_date<=?';params.push(to);}
    const order=url.searchParams.get('sort');const orderBy=order==='oldest'?'transaction_date ASC':order==='highest'?'amount DESC':order==='lowest'?'amount ASC':'transaction_date DESC';const total=db.prepare(`SELECT COUNT(*) n FROM transactions WHERE ${where}`).get(...params).n;const rows=db.prepare(`SELECT * FROM transactions WHERE ${where} ORDER BY ${orderBy},created_at DESC LIMIT ? OFFSET ?`).all(...params,limit,(p-1)*limit);return send(res,200,{items:rows.map(publicTransaction),page:p,limit,total,pages:Math.max(1,Math.ceil(total/limit))});
  }
  if(route==='/api/transactions'&&method==='POST'){
    const b=await readJSON(req);if(!ledger.CATEGORIES.includes(b.category)||!ledger.TYPES.includes(b.type)||!validISODate(b.date)||!Number.isFinite(Number(b.amount))||Number(b.amount)<=0||Number(b.amount)>1_000_000_000||!validString(b.merchant,100))return fail(res,400,'Provide a merchant, amount from ₹0.01 to ₹1,000,000,000, valid date, type and category.');
    const t={id:crypto.randomUUID(),date:b.date,amount:Number(b.amount),type:b.type,merchant:b.merchant.trim(),description:String(b.description||'').slice(0,500),paymentMethod:String(b.paymentMethod||'Manual').slice(0,80),transactionReference:String(b.transactionReference||'').slice(0,120),category:b.category,subcategory:String(b.subcategory||'').slice(0,100),notes:String(b.notes||'').slice(0,500),confidence:1};insertOne(uid,t,'Manual entry');return send(res,201,{transaction:publicTransaction(userTransaction(uid,t.id))});
  }
  const match=route.match(/^\/api\/transactions\/([a-f0-9-]+)$/i);
  if(match&&method==='PUT'){
    const id=match[1],existing=userTransaction(uid,id);if(!existing)return fail(res,404,'Transaction not found.');const b=await readJSON(req);const merged={...publicTransaction(existing),...b};
    if(!ledger.CATEGORIES.includes(merged.category)||!ledger.TYPES.includes(merged.type)||!validISODate(merged.date)||!Number.isFinite(Number(merged.amount))||Number(merged.amount)<=0||Number(merged.amount)>1_000_000_000||!validString(merged.merchant,100))return fail(res,400,'Transaction details are invalid.');
    db.prepare(`UPDATE transactions SET transaction_date=?,amount=?,type=?,merchant=?,description=?,payment_method=?,transaction_reference=?,category=?,subcategory=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`).run(merged.date,Number(merged.amount),merged.type,merged.merchant.trim(),String(merged.description||'').slice(0,500),String(merged.paymentMethod||'UPI').slice(0,80),String(merged.transactionReference||'').slice(0,120),merged.category,String(merged.subcategory||'').slice(0,100),String(merged.notes||'').slice(0,500),id,uid);
    db.prepare(`INSERT INTO merchant_rules(id,user_id,merchant_key,canonical_name,category,subcategory) VALUES(?,?,?,?,?,?) ON CONFLICT(user_id,merchant_key) DO UPDATE SET category=excluded.category,subcategory=excluded.subcategory,canonical_name=excluded.canonical_name`).run(crypto.randomUUID(),uid,ledger.norm(merged.merchant),merged.merchant.trim(),merged.category,String(merged.subcategory||''));return send(res,200,{transaction:publicTransaction(userTransaction(uid,id))});
  }
  if(match&&method==='DELETE'){const result=db.prepare('DELETE FROM transactions WHERE id=? AND user_id=?').run(match[1],uid);if(!result.changes)return fail(res,404,'Transaction not found.');return send(res,200,{ok:true});}
  if((route==='/api/imports'||route==='/api/transactions/import')&&method==='POST'){
    const {file,filename}=await multipart(req,name=>/\.(csv|txt|xlsx)$/i.test(name));let imported=[],duplicateCount=0;const importId=crypto.randomUUID();
    try{const rows=await importRows(filename,file);if(rows.length>50001||rows.some(row=>row.length>100))throw Object.assign(Error('This statement has too many rows or columns to import safely.'),{status:413});imported=ledger.normalizeRows(rows,customRules(uid));db.exec('BEGIN IMMEDIATE');for(const t of imported){if(!insertOne(uid,t))duplicateCount++;}const count=imported.length-duplicateCount;db.prepare('INSERT INTO imports(id,user_id,filename,status,transaction_count,duplicate_count) VALUES(?,?,?,\'complete\',?,?)').run(importId,uid,filename,count,duplicateCount);db.exec('COMMIT');return send(res,201,{importId,filename,parsed:imported.length,imported:count,duplicates:duplicateCount,message:count?`Imported ${count} transactions.`:'All transactions in this statement were already imported.'});}
    catch(e){try{db.exec('ROLLBACK');}catch{}db.prepare('INSERT INTO imports(id,user_id,filename,status,transaction_count) VALUES(?,?,?,\'failed\',0)').run(importId,uid,filename);return fail(res,e.status||422,e.message||'Statement parsing failed.');}
  }
  if(route==='/api/transactions/summary'&&method==='GET'){const metrics=ledger.dashboardMetrics(transactionsFor(uid));return send(res,200,{totalSpent:metrics.totalSpent,income:metrics.income,refunds:metrics.refunds,transfers:metrics.transfers,transactionCount:metrics.transactionCount,topCategory:metrics.categories[0]||null,topMerchant:metrics.merchants[0]||null});}
  if(route==='/api/transactions/categories'&&method==='GET'){return send(res,200,{items:ledger.dashboardMetrics(transactionsFor(uid)).categories});}
  if(route==='/api/transactions/merchants'&&method==='GET'){return send(res,200,{items:db.prepare('SELECT merchant,COUNT(*) AS transactionCount,SUM(CASE WHEN type=\'EXPENSE\' THEN amount ELSE 0 END) AS totalSpent FROM transactions WHERE user_id=? GROUP BY merchant ORDER BY merchant COLLATE NOCASE').all(uid)});}
  if(route==='/api/receipts'&&method==='GET'){return send(res,200,{items:db.prepare('SELECT id,filename,mime_type AS mimeType,size_bytes AS sizeBytes,status,created_at AS createdAt FROM receipts WHERE user_id=? ORDER BY created_at DESC').all(uid)});}
  if(route==='/api/receipts'&&method==='POST'){
    const {file,filename,mime}=await multipart(req,(name,type)=>/\.(png|jpe?g|pdf)$/i.test(name)&&['image/png','image/jpeg','application/pdf'].includes(type));if(file.length>8*1024*1024)return fail(res,413,'Receipts must be 8 MB or smaller.');const signatureOK=mime==='image/png'?file.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):mime==='image/jpeg'?file[0]===255&&file[1]===216&&file[2]===255:file.subarray(0,5).toString()==='%PDF-';if(!signatureOK)return fail(res,415,'The file contents do not match the selected receipt format.');
    const id=crypto.randomUUID(),ext=path.extname(filename).toLowerCase(),filePath=path.join(RECEIPT_DIR,`${id}${ext}`);fs.writeFileSync(filePath,file,{flag:'wx'});db.prepare('INSERT INTO receipts(id,user_id,filename,mime_type,file_path,size_bytes,status) VALUES(?,?,?,?,?,?,?)').run(id,uid,filename,mime,filePath,file.length,'needs_review');return send(res,201,{receipt:{id,filename,mimeType:mime,sizeBytes:file.length,status:'needs_review',message:'Receipt stored securely. OCR is not configured in this MVP; review and enter the transaction details manually.'}});
  }
  if(route.startsWith('/api/'))return fail(res,404,'API route not found.');
  return null;
}

const staticFiles=new Map([['/','index.html'],['/index.html','index.html'],['/styles.css','styles.css'],['/app.js','app.js'],['/sample-upi-statement.csv','sample-upi-statement.csv']]);
function serveStatic(req,res,url){const name=staticFiles.get(url.pathname);if(!name)return fail(res,404,'Not found.');const filename=path.join(ROOT,name);const type=name.endsWith('.css')?'text/css':name.endsWith('.js')?'text/javascript':name.endsWith('.csv')?'text/csv':'text/html';res.writeHead(200,{'Content-Type':`${type}; charset=utf-8`,'Cache-Control':name==='index.html'?'no-cache':'public, max-age=300'});fs.createReadStream(filename).pipe(res);}
const server=http.createServer(async(req,res)=>{
  res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Frame-Options','DENY');res.setHeader('Referrer-Policy','same-origin');res.setHeader('Permissions-Policy','camera=(),microphone=(),geolocation=()');res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  const url=new URL(req.url,'http://localhost');try{if(url.pathname.startsWith('/api/')){if(['POST','PUT','DELETE','PATCH'].includes(req.method)){const origin=req.headers.origin;if(origin&&origin!==`http://${req.headers.host}`&&origin!==`https://${req.headers.host}`)return fail(res,403,'Cross-origin requests are not allowed.');}const handled=await handleAPI(req,res,url);if(handled===null)return fail(res,404,'API route not found.');return;}if(req.method!=='GET'&&req.method!=='HEAD')return fail(res,405,'Method not allowed.');return serveStatic(req,res,url);}catch(e){jsonSafeError(res,e);}
});
function listenAtAvailablePort(port,attempt=0){
  const onError=error=>{
    server.removeListener('listening',onListening);
    if(error.code==='EADDRINUSE'&&attempt<20){listenAtAvailablePort(port+1,attempt+1);return;}
    console.error(`LedgerLoom could not start on port ${port}: ${error.message}`);process.exitCode=1;
  };
  const onListening=()=>{
    server.removeListener('error',onError);
    const address=server.address(),displayHost=HOST==='0.0.0.0'?'localhost':HOST;
    console.log(`LedgerLoom running at http://${displayHost}:${address.port}`);
  };
  server.once('error',onError);server.once('listening',onListening);server.listen(port,HOST);
}
listenAtAvailablePort(PORT);
for(const sig of ['SIGINT','SIGTERM'])process.on(sig,()=>{db.close();server.close(()=>process.exit(0));});
