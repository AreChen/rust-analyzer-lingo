const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { releaseVersion, expectedPackages, validateChecksums, validateMetadata } = require('../scripts/marketplace.cjs');

test('Marketplace accepts only stable version tags', () => {
  assert.equal(releaseVersion('v0.3.1'), '0.3.1');
  for (const tag of ['main', 'v01.2.3', 'v1.2.3-beta.1', 'v1.2.3\n', '../v1.2.3', undefined]) assert.throws(() => releaseVersion(tag));
});

test('Marketplace rejects missing, modified and duplicate release assets before uploading', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lingo-marketplace-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const packages = expectedPackages('v0.3.1');
  const lines = packages.map(({ file }) => {
    fs.writeFileSync(path.join(directory, file), file);
    return `${crypto.createHash('sha256').update(file).digest('hex')}  ${file}`;
  });
  const sums = path.join(directory, 'SHA256SUMS');
  fs.writeFileSync(sums, lines.join('\n'));
  validateChecksums(directory, 'v0.3.1');
  fs.appendFileSync(path.join(directory, packages[0].file), 'modified');
  assert.throws(() => validateChecksums(directory, 'v0.3.1'), /Checksum mismatch/);
  fs.writeFileSync(path.join(directory, packages[0].file), packages[0].file);
  fs.appendFileSync(sums, `\n${lines[0]}`);
  assert.throws(() => validateChecksums(directory, 'v0.3.1'), /duplicate/);
  fs.writeFileSync(sums, lines.slice(1).join('\n'));
  assert.throws(() => validateChecksums(directory, 'v0.3.1'), /missing checksum/);
  fs.rmSync(path.join(directory, packages[0].file));
  assert.throws(() => validateChecksums(directory, 'v0.3.1'), /exactly eight/);
});

test('Marketplace rejects wrong publisher, version and VSIX platform identities', () => {
  const manifest = { name: 'rust-analyzer-lingo', publisher: 'rust-analyzer-lingo', version: '0.3.1' };
  const metadata = {
    'extension/package.json': JSON.stringify(manifest),
    'extension.vsixmanifest': '<Identity Id="rust-analyzer-lingo" Publisher="rust-analyzer-lingo" Version="0.3.1" TargetPlatform="linux-x64" />',
  };
  validateMetadata(metadata, 'v0.3.1', 'linux-x64');
  assert.throws(() => validateMetadata(metadata, 'v0.3.1', 'win32-x64'), /TargetPlatform/);
  for (const key of ['name', 'publisher', 'version']) {
    assert.throws(() => validateMetadata({ ...metadata, 'extension/package.json': JSON.stringify({ ...manifest, [key]: 'unexpected' }) }, 'v0.3.1', 'linux-x64'), /identity or version/);
  }
  assert.throws(() => validateMetadata({ ...metadata, 'extension.vsixmanifest': metadata['extension.vsixmanifest'] + '<Property Id="Microsoft.VisualStudio.Code.PreRelease" Value="true" />' }, 'v0.3.1', 'linux-x64'), /Pre-release/);
});
