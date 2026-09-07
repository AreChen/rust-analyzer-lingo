const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { target, executable } = require('./platform.cjs');
const { name, version } = require('../package.json');
if (process.env.GITHUB_REF_TYPE === 'tag' && process.env.GITHUB_REF_NAME !== `v${version}`) throw new Error('Release tag must match package version');
fs.mkdirSync('out/packages', { recursive: true });
const destination = `out/packages/${name}-${version}-${target}.vsix`;
execFileSync(process.execPath, [path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce'), 'package', '--target', target, '--out', destination], { stdio: 'inherit' });
require('yauzl').open(destination, { lazyEntries: true }, (error, zip) => {
  if (error) throw error;
  const required = new Set(['extension/package.json', 'extension/assets/icon.png', 'extension/changelog.md', 'extension.vsixmanifest', `extension/out/bin/${executable}`, ...['extension.js', 'native.js', 'catalog.json', 'diagnostic-details.json', 'message-rules.json'].map(f => `extension/out/dist/${f}`)]);
  zip.on('error', error => { throw error; });
  zip.on('entry', entry => {
    required.delete(entry.fileName);
    if (/^extension\/(?:src|test|scripts|proxy|node_modules|bin|dist)\//.test(entry.fileName) || entry.fileName.endsWith('.vsix')) throw new Error(`Unexpected package entry: ${entry.fileName}`);
    if (entry.fileName === 'extension.vsixmanifest') {
      zip.openReadStream(entry, (error, stream) => {
        if (error) throw error;
        let xml = '';
        stream.on('data', data => { xml += data; });
        stream.on('error', error => { throw error; });
        stream.on('end', () => {
          if (!xml.includes(`TargetPlatform="${target}"`)) throw new Error('VSIX target metadata is missing');
          zip.readEntry();
        });
      });
    } else zip.readEntry();
  });
  zip.on('end', () => {
    if (required.size) throw new Error(`Missing package entries: ${[...required].join(', ')}`);
    console.log(`Verified ${destination}`);
  });
  zip.readEntry();
});
