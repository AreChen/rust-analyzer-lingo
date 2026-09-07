// Real-server compatibility smoke test. Usage: node scripts/smoke-lsp.cjs SERVER [PROXY]
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {pathToFileURL,fileURLToPath}=require('node:url');const {spawn}=require('node:child_process');const assert=require('node:assert/strict');
function sameFileUri(a,b) {
 try {
  const canonical=uri=>{const file=fs.realpathSync.native(fileURLToPath(uri));return process.platform==='win32'?file.toLowerCase():file;};
  return canonical(a)===canonical(b);
 } catch { return a===b; }
}
async function smoke(server,proxy){
 const root=fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP??os.tmpdir(),'lingo-lsp-')));
 fs.mkdirSync(path.join(root,'src'));
 fs.writeFileSync(path.join(root,'Cargo.toml'),'[package]\nname="lingo_fixture"\nversion="0.1.0"\nedition="2021"\n');
 const source='fn main() {\n    let value: u32 = "bad";\n    println!("{value}");\n}\n';
 const file=path.join(root,'src/main.rs');fs.writeFileSync(file,source);
 const uri=pathToFileURL(file).href;
 const child=spawn(proxy??server,[],{cwd:root,env:{...process.env,RUST_ANALYZER_LINGO_REAL_SERVER:server}});
 const pending=new Map();const notifications=[];let buffer=Buffer.alloc(0),id=0,stderr='';
 child.stderr.on('data',x=>stderr+=x);
 let fatal;
 child.on('error',e=>fatal=e);
 const send=m=>{const b=Buffer.from(JSON.stringify(m));child.stdin.write('Content-Length: '+b.length+'\r\n\r\n');child.stdin.write(b);};
 child.stdout.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);for(;;){let p=buffer.indexOf('\r\n\r\n');if(p<0)return;let n=Number(buffer.subarray(0,p).toString().match(/Content-Length: (\d+)/i)?.[1]);if(buffer.length<p+4+n)return;let m=JSON.parse(buffer.subarray(p+4,p+4+n));buffer=buffer.subarray(p+4+n);if(m.method&&m.id!==undefined){send({jsonrpc:'2.0',id:m.id,result:m.method==='workspace/configuration'?m.params.items.map(()=>null):null});}else if(m.id!==undefined){pending.get(m.id)?.(m);pending.delete(m.id);}else notifications.push(m);}});
 const request=(method,params)=>new Promise((resolve,reject)=>{const n=++id;const timer=setTimeout(()=>{pending.delete(n);reject(new Error('Timeout '+method+' '+stderr.slice(-1500)));},45000);pending.set(n,m=>{clearTimeout(timer);m.error?reject(new Error(JSON.stringify(m.error))):resolve(m.result);});send({jsonrpc:'2.0',id:n,method,params});});
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 try{
 const init=await request('initialize',{processId:process.pid,rootUri:pathToFileURL(root).href,workspaceFolders:[{uri:pathToFileURL(root).href,name:'fixture'}],capabilities:{textDocument:{publishDiagnostics:{relatedInformation:true,codeDescriptionSupport:true,dataSupport:true},hover:{contentFormat:['markdown']},codeAction:{dataSupport:true,codeActionLiteralSupport:{codeActionKind:{valueSet:['quickfix']}}}}},initializationOptions:{cargo:{allTargets:false},checkOnSave:true,procMacro:{enable:false}}});
 send({jsonrpc:'2.0',method:'initialized',params:{}});send({jsonrpc:'2.0',method:'textDocument/didOpen',params:{textDocument:{uri,languageId:'rust',version:1,text:source}}});
 let diagnostics=[];
 for(let n=0;n<200;n++){if(fatal)throw fatal;diagnostics=notifications.filter(m=>m.method==='textDocument/publishDiagnostics'&&sameFileUri(m.params.uri,uri)).flatMap(m=>m.params.diagnostics);if(diagnostics.some(d=>String(d.code)==='E0308'))break;await delay(150);}
 const mismatch=diagnostics.find(d=>String(d.code)==='E0308');assert.ok(mismatch,'expected real E0308 '+stderr.slice(-1500)+' notifications='+JSON.stringify(notifications.map(m=>({method:m.method,params:m.params}))).slice(-7000));assert.match(mismatch.message,/u32/);assert.match(mismatch.message,/str/);if(proxy)assert.match(mismatch.message,/中文：/);
 let hover;
 for(let n=0;n<100;n++) {
  hover=await request('textDocument/hover',{textDocument:{uri},position:{line:1,character:10}});
  if(hover)break;await delay(150);
 }
 const completion=await request('textDocument/completion',{textDocument:{uri},position:{line:2,character:7}});
 const actions=await request('textDocument/codeAction',{textDocument:{uri},range:mismatch.range,context:{diagnostics:[mismatch]}});
 assert.ok(hover,'hover works');assert.ok(completion,'completion works');assert.ok(Array.isArray(actions),'code actions respond');
 let missingBody;
 if (process.env.LINGO_TEST_MISSING_BODY === '1') {
  notifications.length=0;
  send({jsonrpc:'2.0',method:'textDocument/didChange',params:{textDocument:{uri,version:2},contentChanges:[{text:'const LIMIT: u32;\nfn main() {}\n'}]}});
  for(let n=0;n<200;n++){
   if(init.capabilities.diagnosticProvider) { const report=await request('textDocument/diagnostic',{textDocument:{uri}}); notifications.push({method:'textDocument/publishDiagnostics',params:{diagnostics:report.items??[]}}); }
   missingBody=notifications.filter(m=>m.method==='textDocument/publishDiagnostics').flatMap(m=>m.params.diagnostics).find(d=>d.message.includes('free constant item without body'));
   if(missingBody)break;await delay(100);
  }
  assert.ok(missingBody,'latest missing-body diagnostic '+JSON.stringify({provider:init.capabilities.diagnosticProvider,notifications}).slice(-4000));
  if(proxy)assert.match(missingBody.message,/没有赋值/);
 }
 await request('shutdown',null);const closed=new Promise(r=>child.once('close',r));send({jsonrpc:'2.0',method:'exit',params:null});
 const exitCode=await Promise.race([closed,delay(4000).then(()=>{throw new Error('shutdown timeout');})]);assert.equal(exitCode,0);
 return {server:init.serverInfo,proxy:!!proxy,diagnostic:mismatch.message,hover:!!hover,completion:!!completion,codeActions:actions.length,missingBody:missingBody?.message,exitCode};
 }finally{child.stdin.destroy();if(child.exitCode===null)child.kill();}
}
if(require.main===module){smoke(process.argv[2],process.argv[3]).then(r=>console.log(JSON.stringify(r,null,2))).catch(e=>{console.error(e);process.exitCode=1;});}
module.exports={smoke};
