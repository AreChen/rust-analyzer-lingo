const fs = require('node:fs');
const titles = require('../out/dist/error-codes.js').RUST_ERROR_CODE_TITLES;
const details = require('../src/diagnostic-details.json');
const catalog = Object.fromEntries(Object.entries(titles).map(([code, chinese]) => [code, {chinese, ...details[code]}]));
fs.writeFileSync('out/dist/catalog.json', JSON.stringify(catalog));
console.log('Built shared diagnostic catalog: ' + Object.keys(catalog).length + ' codes');
