// Run against an official extension directory, using a disposable VS Code profile.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');const {spawn}=require('node:child_process');
async function main(){
 const official=process.argv[2];if(!official)throw new Error('Usage: node scripts/test-vscode.cjs OFFICIAL_EXTENSION_DIRECTORY');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'lingo-host-'));
 const workspace=path.join(root,'workspace'),extensions=path.join(root,'extensions');
 fs.mkdirSync(path.join(workspace,'src'),{recursive:true});fs.mkdirSync(extensions);
 fs.cpSync(official,path.join(extensions,'rust-lang.rust-analyzer-test'),{recursive:true});
 fs.writeFileSync(path.join(workspace,'Cargo.toml'),'[package]\nname="lingo_host_fixture"\nversion="0.1.0"\nedition="2021"\n');
 fs.writeFileSync(path.join(workspace,'src/main.rs'),'fn main() { let _value = 1; }\n');
 const repo=path.resolve(__dirname,'..');
 const args=['proxy','code','--new-window','--disable-workspace-trust','--skip-welcome','--skip-release-notes','--user-data-dir',path.join(root,'user-data'),'--extensions-dir',extensions,'--extensionDevelopmentPath='+repo,'--extensionTestsPath='+path.join(repo,'test/extension-host.cjs'),workspace];
 console.log('Isolated VS Code test: '+root);
 const child=spawn('rtk',args,{windowsHide:true,stdio:'inherit'});
 let launchError;child.on('error',e=>launchError=e);
 for(let n=0;n<200;n++){
  if(launchError)throw launchError;
  const result=path.join(workspace,'integration-result.json'),failure=path.join(workspace,'integration-failure.txt');
  if(fs.existsSync(result)){console.log(fs.readFileSync(result,'utf8'));return;}
  if(fs.existsSync(failure))throw new Error(fs.readFileSync(failure,'utf8'));
  await new Promise(r=>setTimeout(r,500));
 }
 throw new Error('Test timed out; inspect logs in '+root);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
