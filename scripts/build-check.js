const {spawnSync}=require('node:child_process');
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
for(const filename of ['server.js','database/store.js','app.js','services/ledger.js','tests/integration.test.js']){
  const result=spawnSync(process.execPath,['--check',path.join(root,filename)],{encoding:'utf8'});
  if(result.status!==0){process.stderr.write(result.stderr||result.stdout);process.exit(result.status||1);}
}
for(const filename of ['index.html','styles.css','database/store.js','database/postgres.sql','database/migrations/001_initial.sql','database/migrations/002_account_names_and_transaction_references.sql','tests/fixtures/upi-statement.xlsx','.env.example']){
  if(!fs.existsSync(path.join(root,filename)))throw new Error('Required application file is missing: '+filename);
}
if(fs.existsSync(path.join(root,'.env')))throw new Error('.env must never be included in an application build.');
console.log('LedgerLoom build check passed.');
