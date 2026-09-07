const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const util = require('node:util');
function setup(initial={}, overrides={}, options={}) {
 const data=structuredClone(initial), records=new Map(Object.entries(options.records??{})), commands=new Map(), notices=[];
 const uri={fsPath:'C:/fixture',toString:()=> 'file:///C:/fixture'};
 let failKey;
 const config={get(k,f){const inherited=options.globals?.[k];if(k in data){const v=data[k];return v&&typeof v==="object"?{...inherited,...v}:v;}return inherited??f;},inspect(k){return {workspaceValue:data[k],globalValue:options.globals?.[k]};},async update(k,v){if(failKey===k){failKey=undefined;throw new Error('injected write failure');}if(v===undefined)delete data[k];else data[k]=structuredClone(v);}};
 const state={get(k,f){return structuredClone(records.has(k)?records.get(k):f);},async update(k,v){records.set(k,structuredClone(v));}};
 const execFile=()=>{};execFile[util.promisify.custom]=async(file)=>{notices.push(file);return {stdout:file==='rustup'?'C:/toolchain/bin/rust-analyzer.exe':'rust-analyzer 0.3.3041 (test 2026-09-07)'};};
 const dispos={dispose(){}};
 const vscode={ConfigurationTarget:{Global:1,Workspace:2,WorkspaceFolder:3},env:{language:'zh-cn'},Uri:{parse:()=>uri},workspace:{isTrusted:true,workspaceFolders:[{uri}],getWorkspaceFolder:()=>({uri}),getConfiguration:()=>config},extensions:{getExtension:()=>({extensionPath:options.officialPath??'C:/official-3041'}),onDidChange:()=>dispos},window:{activeTextEditor:{document:{uri}},showInformationMessage:()=>{},showErrorMessage:s=>notices.push(s),showWarningMessage:async()=>undefined},commands:{registerCommand(k,f){commands.set(k,f);return dispos;},getCommands:async()=>[]},...overrides};
 const exports={};
 vm.runInNewContext(fs.readFileSync(require.resolve('../out/dist/native.js'),'utf8'),{exports,process:{...process,platform:options.platform??"win32",arch:options.arch??"x64"},require(k){if(k==="node:path")return options.platform && options.platform!=="win32" ? require("node:path").posix : require("node:path").win32;if(k==='vscode')return vscode;if(k==='node:child_process')return {execFile};if(k==='node:fs/promises')return {stat:async()=>({isFile:()=>true}),mkdir:async()=>{},copyFile:async()=>{},chmod:async(file,mode)=>{notices.push(`chmod:${file}:${mode}`);},readFile:async()=>{if(options.toolchainSource)return options.toolchainSource;throw new Error('absent');}};return require(k);}});
 const context={workspaceState:state,globalState:{get:()=>undefined},extensionPath:'C:/lingo',globalStorageUri:{fsPath:'C:/storage'},extension:{packageJSON:{version:options.version??'0.2.0'}}};
 exports.registerNativeCommands(context,{appendLine:s=>notices.push(s)});
 return {data,records,notices,exports,enable:()=>commands.get('rustAnalyzerLingo.enableNativeChineseHover')(),disable:()=>commands.get('rustAnalyzerLingo.disableNativeChineseHover')(),fail(k){failKey=k;}};
}
test('different workspaces restore their own server and environment',async()=>{
 const a=setup({'server.path':'C:/a.exe','server.extraEnv':{PROJECT:'A',NUMBER:42,UNSET:null}});
 const b=setup({'server.path':'C:/b.exe','server.extraEnv':{PROJECT:'B'}});
 await a.enable();await b.enable();
 assert.equal(a.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER,'C:/a.exe');
 assert.equal(b.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER,'C:/b.exe');
 await b.disable();await a.disable();
 assert.equal(a.data['server.path'],'C:/a.exe');assert.equal(b.data['server.path'],'C:/b.exe');
 assert.deepEqual(a.data['server.extraEnv'],{PROJECT:'A',NUMBER:42,UNSET:null});
});
test('unset values stay unset and repeat enable does not replace the backup',async()=>{
 const a=setup();await a.enable();await a.enable();await a.disable();assert.deepEqual(a.data,{});
});
test('user edits while enabled survive restore',async()=>{
 const a=setup({'server.path':'C:/a.exe','server.extraEnv':{KEEP:'before'}});await a.enable();
 a.data['server.path']='C:/user-changed.exe';a.data['server.extraEnv'].KEEP='after';a.data['server.extraEnv'].NEW=123;
 await a.disable();assert.equal(a.data['server.path'],'C:/user-changed.exe');assert.deepEqual(a.data['server.extraEnv'],{KEEP:'after',NEW:123});
});
test('a failed setting write rolls back the prior state',async()=>{
 const a=setup({'server.path':'C:/a.exe'});a.fail('server.path');await a.enable();
 assert.deepEqual(a.data,{'server.path':'C:/a.exe'});assert.deepEqual(a.records.get('nativeProxySettings.v2'),{});assert.ok(a.notices.some(s=>s.includes('injected write failure')));
});
test('unsupported variables and recursive proxy paths are rejected',()=>{
 const a=setup();assert.throws(()=>a.exports.expandServer('${command:arbitrary}'));
 assert.equal(a.exports.isProxy('C:/x/rust-analyzer-lingo-proxy.exe'),true);
});

test('upgrades refresh managed paths and preserve the original restore point',async()=>{
 const a=setup();await a.enable();
 const b=setup(a.data,{}, {records:Object.fromEntries(a.records),version:'0.2.1',officialPath:'C:/official-3042'});
 await b.enable();assert.match(b.data['server.path'],/0.2.1/);assert.match(b.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER,/official-3042/);
 await b.disable();assert.deepEqual(b.data,{});
});
test('inherited global environment values are not copied to workspace settings',async()=>{
 const a=setup({}, {}, {globals:{'server.extraEnv':{PRIVATE_TOKEN:'synthetic-secret',RA_LOG:'info'}}});
 await a.enable();assert.equal(a.data['server.extraEnv'].PRIVATE_TOKEN,undefined);assert.equal(a.data['server.extraEnv'].RA_LOG,undefined);
 await a.disable();assert.deepEqual(a.data,{});
});
test('an explicit null environment continues to mask inherited variables',async()=>{
 const a=setup({'server.extraEnv':null},{},{globals:{'server.extraEnv':{PRIVATE_TOKEN:'synthetic-secret'}}});
 await a.enable();assert.equal(a.data['server.extraEnv'].PRIVATE_TOKEN,null);await a.disable();assert.deepEqual(a.data,{'server.extraEnv':null});
});
test('environment edits survive a subsequent upgrade or re-enable',async()=>{
 const a=setup();await a.enable();a.data['server.extraEnv'].RA_LOG='debug';await a.enable();await a.disable();assert.deepEqual(a.data,{'server.extraEnv':{RA_LOG:'debug'}});
});

test('declared project toolchain precedes bundled server while custom paths still win',async()=>{
 const options={toolchainSource:'[toolchain]\ncomponents = [\n "rust-analyzer", "clippy"\n]'};
 const a=setup({}, {}, options);await a.enable();assert.equal(a.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER,'C:/toolchain/bin/rust-analyzer.exe');
 const b=setup({'server.path':'C:/custom.exe'}, {}, options);await b.enable();assert.equal(b.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER,'C:/custom.exe');
});

for (const platform of ['win32', 'darwin', 'linux']) {
 for (const arch of ['x64', 'arm64']) {
  test(`${platform}/${arch} selects a native executable and preserves restore`, async () => {
   const a=setup({}, {}, {platform, arch});
   await a.enable();
   const suffix=platform==='win32'?'.exe':'';
   assert.ok(a.data['server.path'].endsWith('rust-analyzer-lingo-proxy'+suffix));
   assert.ok(a.data['server.extraEnv'].RUST_ANALYZER_LINGO_REAL_SERVER.endsWith('rust-analyzer'+suffix));
   assert.equal(a.notices.some(s=>s.startsWith('chmod:')), platform!=='win32');
   assert.equal(a.exports.isProxy('/tmp/rust-analyzer-lingo-proxy'),true);
   await a.disable();assert.deepEqual(a.data,{});
  });
 }
}
test('unsupported architecture leaves settings untouched',async()=>{
 const a=setup({}, {}, {platform:'linux',arch:'arm'});await a.enable();
 assert.deepEqual(a.data,{});assert.equal(a.records.size,0);
});
