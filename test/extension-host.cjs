const vscode=require('vscode');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
exports.run=async()=>{
 const delay=ms=>new Promise(r=>setTimeout(r,ms));
 async function until(fn,label,timeout=15000){const end=Date.now()+timeout;while(Date.now()<end){const result=await fn();if(result)return result;await delay(120);}throw new Error('Timed out: '+label);}
 const ext=vscode.extensions.getExtension('rust-analyzer-lingo.rust-analyzer-lingo');assert.ok(ext);await ext.activate();
 const uri=vscode.Uri.joinPath(vscode.workspace.workspaceFolders[0].uri,'src/main.rs');
 const doc=await vscode.workspace.openTextDocument(uri);await vscode.window.showTextDocument(doc);
 const config=vscode.workspace.getConfiguration('rust-analyzer-lingo');
 const commands=await vscode.commands.getCommands();for(const name of ['showMenu','chooseMode','explainCurrentDiagnostic','enableNativeChineseHover','disableNativeChineseHover'])assert.ok(commands.includes('rustAnalyzerLingo.'+name));
 const collection=vscode.languages.createDiagnosticCollection('lingo-integration-fixture');
 const range=new vscode.Range(0,15,0,21);
 const diag=new vscode.Diagnostic(range,'mismatched types\nexpected `u32`, found `&str`',vscode.DiagnosticSeverity.Error);diag.source='rustc';diag.code={value:'Click for full compiler diagnostic',target:vscode.Uri.parse('https://doc.rust-lang.org/error-index.html#E0308')};
 const warning=new vscode.Diagnostic(range,'unused variable: `变量`',vscode.DiagnosticSeverity.Warning);warning.source='rustc';warning.code='unused_variables';
 try{
 collection.set(uri,[warning,diag]);
 const hints=await until(async()=>{const h=await vscode.commands.executeCommand('vscode.executeInlayHintProvider',uri,doc.validateRange(new vscode.Range(0,0,doc.lineCount,0)));return h?.some(x=>typeof x.label==='string'&&x.label.startsWith('错误：'))&&h;},'inline hint');
 const hint=hints.find(x=>typeof x.label==='string'&&x.label.startsWith('错误：'));assert.match(hint.label,/另 1 条/);assert.match(hint.tooltip.value,/u32/);assert.match(hint.tooltip.value,/str/);assert.match(hint.tooltip.value,/可以这样检查/);assert.match(hint.tooltip.value,/编译器原文/);
 await config.update('mode','hover',vscode.ConfigurationTarget.Workspace);
 const hovers=await until(async()=>{const h=await vscode.commands.executeCommand('vscode.executeHoverProvider',uri,new vscode.Position(0,17));return h?.some(x=>x.contents.some(m=>m.value?.includes('编译器原文')))&&h;},'hover');assert.ok(hovers.length);
 await config.update('mode','problems',vscode.ConfigurationTarget.Workspace);
 await until(()=>vscode.languages.getDiagnostics(uri).filter(d=>d.source==='rust-analyzer-lingo').length===2,'Problems entries');
 const changed=new vscode.DiagnosticRelatedInformation(new vscode.Location(uri,new vscode.Range(0,0,0,2)),'a newly changed compiler note');diag.relatedInformation=[changed];collection.set(uri,[warning,diag]);
 await until(()=>vscode.languages.getDiagnostics(uri).find(d=>d.source==='rust-analyzer-lingo'&&d.relatedInformation?.[0]?.message==='a newly changed compiler note'),'related note updates');
 await config.update('mode','inline',vscode.ConfigurationTarget.Workspace);
 await until(()=>vscode.languages.getDiagnostics(uri).every(d=>d.source!=='rust-analyzer-lingo'),'Problems cleanup');
 collection.clear();
 const ra=vscode.extensions.getExtension('rust-lang.rust-analyzer');await ra.activate();
 await until(async()=>(await vscode.commands.getCommands()).includes('rust-analyzer.restartServer'),'official activation');
 const raConfig=vscode.workspace.getConfiguration('rust-analyzer');
 const beforePath=raConfig.inspect('server.path').workspaceValue;
 const beforeEnv=raConfig.inspect('server.extraEnv').workspaceValue;
 await vscode.commands.executeCommand('rustAnalyzerLingo.enableNativeChineseHover');
 const proxyPath=vscode.workspace.getConfiguration('rust-analyzer').get('server.path');assert.match(proxyPath,/rust-analyzer-lingo-proxy(?:\.exe)?$/);
 assert.match(vscode.workspace.getConfiguration('rust-analyzer').get('server.extraEnv').RUST_ANALYZER_LINGO_REAL_SERVER,/rust-analyzer(?:\.exe)?$/);
 const edit=new vscode.WorkspaceEdit();edit.replace(uri,new vscode.Range(0,0,doc.lineCount,0),'fn main() {\n let value: u32 = "bad";\n println!("{value}");\n}\n');await vscode.workspace.applyEdit(edit);await doc.save();
 const nativeDiag=await until(()=>vscode.languages.getDiagnostics(uri).find(d=>d.message.startsWith('中文：')&&d.message.includes('u32')), 'native diagnostic with current official client',45000);
 assert.match(nativeDiag.message,/原文/);
 await vscode.commands.executeCommand('rustAnalyzerLingo.disableNativeChineseHover');
 assert.deepEqual(vscode.workspace.getConfiguration('rust-analyzer').inspect('server.path').workspaceValue,beforePath);assert.deepEqual(vscode.workspace.getConfiguration('rust-analyzer').inspect('server.extraEnv').workspaceValue,beforeEnv);
 const result={extension:ext.packageJSON.version,official:ra.packageJSON.version,inline:true,hover:true,problems:true,relatedUpdates:true,native:true,restore:true};
 fs.writeFileSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,'integration-result.json'),JSON.stringify(result,null,2));console.log('LINGO_EXTENSION_HOST_PASS '+JSON.stringify(result));
 }finally{collection.dispose();}
};


const run=exports.run;
exports.run=async()=>{try{return await run();}catch(error){fs.writeFileSync(path.join(vscode.workspace.workspaceFolders[0].uri.fsPath,"integration-failure.txt"),error.stack ?? String(error));throw error;}};
