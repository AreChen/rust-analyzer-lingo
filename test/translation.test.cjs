const test = require('node:test');
const assert = require('node:assert/strict');
const {translateDiagnostic, getDiagnosticCode, originalMessage} = require('../out/dist/translation.js');
test('Chinese identifiers are translated while keeping the exact name', () => {
 const result = translateDiagnostic({code:'unused_variables',message:'unused variable: `变量`'});
 assert.equal(result.chinese,'变量 `变量` 没有使用');
});
test('types and traits remain specific, including current analyzer syntax', () => {
 for (const message of ['mismatched types\nexpected `u32`, found `&str`','expected u32, found &str']) {
  const result=translateDiagnostic({code:'E0308',message});
  assert.match(result.chinese,/u32/); assert.match(result.chinese,/&str/);
 }
 const a=translateDiagnostic({code:'E0277',message:'the trait bound `X: Foo` is not satisfied'});
 const b=translateDiagnostic({code:'E0277',message:'the trait bound `X: Bar` is not satisfied'});
 assert.notEqual(a.chinese,b.chinese);
 assert.match(translateDiagnostic({code:'E0061',message:'expected 2 arguments, found 1'}).chinese,/需要 2 个参数，实际传了 1 个/);
});
test('new syntax diagnostics, unknown errors and link-labelled codes', () => {
 assert.match(translateDiagnostic({code:'syntax-error',message:'free constant item without body'}).chinese,/没有赋值/);
 assert.match(translateDiagnostic({code:'syntax-error',message:'associated type in `impl` without body'}).chinese,/指定/);
 assert.equal(translateDiagnostic({code:'E9999',message:'future error'}).matchedBy,'fallback');
 assert.equal(translateDiagnostic({code:'future-check',message:'future error'}).matchedBy,'fallback');
 assert.equal(getDiagnosticCode({code:{value:'Click for full compiler diagnostic',target:'https://doc.rust-lang.org/error_codes/E0308.html'}}),'E0308');
});
test('native translations do not accumulate and all shared catalog entries agree', () => {
 const source='mismatched types\nexpected `u32`, found `&str`';
 const translated='中文：类型不匹配\n\n原文：\n'+source;
 assert.equal(originalMessage(translated),source);
 assert.deepEqual(translateDiagnostic({code:'E0308',message:translated}),translateDiagnostic({code:'E0308',message:source}));
 const catalog=require('../out/dist/catalog.json');
 assert.equal(Object.keys(catalog).length,518);
 for(const [code,entry] of Object.entries(catalog)) assert.equal(translateDiagnostic({code,message:'synthetic compiler message'}).chinese,entry.chinese,code);
});
