const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const proxy=process.env.LINGO_TEST_PROXY ?? path.resolve('proxy/target/debug/rust-analyzer-lingo-proxy'+(process.platform==='win32'?'.exe':''));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'lingo-proxy-test-'));
function launch(source){const file=path.join(temp,Math.random().toString(36).slice(2)+'.cjs');fs.writeFileSync(file,source);return spawn(proxy,[file],{env:{...process.env,RUST_ANALYZER_LINGO_REAL_SERVER:process.execPath},stdio:['pipe','pipe','pipe']});}
function exit(child){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{child.kill();reject(new Error('proxy did not terminate'));},4500);child.on('error',reject);child.on('close',(code)=>{clearTimeout(timer);resolve(code);});});}
test('proxy exits after server failure even while client stdin is open',async()=>{
 const child=launch('process.exit(7)');const done=exit(child);let stderr='';child.stderr.on('data',x=>stderr+=x);assert.equal(await done,1);assert.match(stderr,/退出/);child.stdin.destroy();
});
test('client EOF cleans up a server that ignores EOF',async()=>{
 const child=launch('process.stdin.resume();process.stdin.on("end",()=>{});setInterval(()=>{},1000)');const done=exit(child);child.stdin.end();assert.equal(await done,1);
});
test('malformed server frame terminates both directions instead of hanging',async()=>{
 const child=launch('process.stdout.write("Content-Length: invalid\\r\\n\\r\\n");setInterval(()=>{},1000)');const done=exit(child);assert.equal(await done,1);child.stdin.destroy();
});
test('final messages are drained and unrelated JSON bodies are preserved',async()=>{
 const body='{ "jsonrpc": "2.0", "id": 7, "result": {"contents":"value of literal: 42"} }';
 const child=launch(`process.stdout.write('Content-Length: ${Buffer.byteLength(body)}\\r\\n\\r\\n'+${JSON.stringify(body)})`);let output='';child.stdout.on('data',x=>output+=x);const done=exit(child);assert.equal(await done,0);assert.equal(output,'Content-Length: '+Buffer.byteLength(body)+'\r\n\r\n'+body);child.stdin.destroy();
});
