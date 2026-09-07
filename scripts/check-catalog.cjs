const fs=require('node:fs'),path=require('node:path');const {execFileSync}=require('node:child_process');
const root=execFileSync('rustc',['+stable','--print','sysroot'],{encoding:'utf8'}).trim();
const official=fs.readdirSync(path.join(root,'share/doc/rust/html/error_codes')).filter(n=>/^E\d{4}\.html$/.test(n)).map(n=>n.slice(0,5));
const source=fs.readFileSync(path.join(__dirname,'../src/error-codes.ts'),'utf8');
const keys=[...source.matchAll(/^\s*(E\d{4})\s*:/gm)].map(m=>m[1]);
const missing=official.filter(k=>!keys.includes(k));const extra=keys.filter(k=>!official.includes(k));const duplicates=[...new Set(keys.filter((k,i)=>keys.indexOf(k)!==i))];
console.log(JSON.stringify({catalog:keys.length,official:official.length,missing,extra,duplicates},null,2));if(missing.length||extra.length||duplicates.length)process.exitCode=1;
