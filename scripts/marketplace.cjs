const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { targets } = require('./platform.cjs');
const { name, publisher } = require('../package.json');

function releaseVersion(tag) {
  if (!/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag || '')) {
    throw new Error('Only stable vMAJOR.MINOR.PATCH release tags are accepted');
  }
  return tag.slice(1);
}

function expectedPackages(tag) {
  const version = releaseVersion(tag);
  return Object.keys(targets).sort().map(target => ({ target, file: `${name}-${version}-${target}.vsix` }));
}

function validateChecksums(directory, tag) {
  const expected = expectedPackages(tag).map(item => item.file);
  const actual = fs.readdirSync(directory).filter(file => file.endsWith('.vsix')).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Expected exactly eight platform VSIX files');
  const checksums = new Map();
  for (const line of fs.readFileSync(path.join(directory, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9.-]+\.vsix)$/.exec(line);
    if (!match || !expected.includes(match[2]) || checksums.has(match[2])) throw new Error('Invalid or duplicate checksum entry');
    checksums.set(match[2], match[1]);
  }
  for (const file of expected) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(path.join(directory, file))).digest('hex');
    if (checksums.get(file) !== hash) throw new Error(`Checksum mismatch or missing checksum: ${file}`);
  }
}

function readMetadata(file) {
  return new Promise((resolve, reject) => {
    require('yauzl').open(file, { lazyEntries: true }, (error, zip) => {
      if (error) return reject(error);
      const metadata = {};
      const fail = error => { zip.close(); reject(error); };
      zip.on('error', fail);
      zip.on('entry', entry => {
        if (!['extension/package.json', 'extension.vsixmanifest'].includes(entry.fileName)) return zip.readEntry();
        if (entry.uncompressedSize > 1024 * 1024 || Object.hasOwn(metadata, entry.fileName)) return fail(new Error('Invalid VSIX metadata entry'));
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail(error);
          const chunks = [];
          stream.on('error', fail);
          stream.on('data', chunk => chunks.push(chunk));
          stream.on('end', () => {
            metadata[entry.fileName] = Buffer.concat(chunks).toString('utf8');
            zip.readEntry();
          });
        });
      });
      zip.on('end', () => resolve(metadata));
      zip.readEntry();
    });
  });
}

function validateMetadata(metadata, tag, target) {
  const version = releaseVersion(tag);
  const manifest = JSON.parse(metadata['extension/package.json']);
  if (manifest.name !== name || manifest.publisher !== publisher || manifest.version !== version) throw new Error('Unexpected extension identity or version');
  const xml = metadata['extension.vsixmanifest'] || '';
  const identity = xml.match(/<Identity\b([^>]+)\/?\s*>/);
  if (!identity) throw new Error('Missing VSIX Identity');
  for (const [key, value] of Object.entries({ Id: name, Publisher: publisher, Version: version, TargetPlatform: target })) {
    if (!identity[1].includes(` ${key}="${value}"`)) throw new Error(`Unexpected VSIX ${key}`);
  }
  if (/<Property\b[^>]*Id="Microsoft\.VisualStudio\.Code\.PreRelease"[^>]*Value="true"/.test(xml)) throw new Error('Pre-release VSIX is not a stable release');
}

async function validatePackages(directory, tag) {
  validateChecksums(directory, tag);
  for (const { target, file } of expectedPackages(tag)) validateMetadata(await readMetadata(path.join(directory, file)), tag, target);
  console.log(`Validated ${tag}: all eight platform packages, SHA-256 checksums and extension identities`);
}

async function main() {
  const command = process.argv[2];
  const tag = process.env.RELEASE_TAG;
  releaseVersion(tag);
  const directory = path.resolve(process.argv[3] || 'out/marketplace');
  if (command === 'download') {
    const repo = process.env.GITHUB_REPOSITORY;
    if (repo !== 'AreChen/rust-analyzer-lingo') throw new Error('Unexpected source repository');
    const release = JSON.parse(execFileSync('gh', ['release', 'view', tag, '--repo', repo, '--json', 'tagName,isDraft,isPrerelease,assets'], { encoding: 'utf8' }));
    if (release.tagName !== tag || release.isDraft || release.isPrerelease) throw new Error('Expected a published stable GitHub Release');
    const expected = [...expectedPackages(tag).map(item => item.file), 'SHA256SUMS'].sort();
    const actual = release.assets.filter(asset => asset.name.endsWith('.vsix') || asset.name === 'SHA256SUMS').map(asset => asset.name).sort();
    if (JSON.stringify(expected) !== JSON.stringify(actual)) throw new Error('GitHub Release assets are incomplete or duplicated');
    fs.mkdirSync(directory, { recursive: true });
    execFileSync('gh', ['release', 'download', tag, '--repo', repo, '--dir', directory, '--pattern', '*.vsix', '--pattern', 'SHA256SUMS'], { stdio: 'inherit' });
  } else if (!['validate', 'publish'].includes(command)) throw new Error('Use download, validate or publish');
  await validatePackages(directory, tag);
  if (command === 'publish') {
    const vsce = path.join(path.dirname(require.resolve('@vscode/vsce/package.json')), 'vsce');
    // Duplicate packages can be read publicly; verify membership even on a no-op retry.
    execFileSync(process.execPath, [vsce, 'verify-pat', publisher, '--azure-credential'], { stdio: 'inherit' });
    for (const { file } of expectedPackages(tag)) {
      for (let attempt = 1; ; attempt++) {
        try {
          execFileSync(process.execPath, [vsce, 'publish', '--azure-credential', '--packagePath', path.join(directory, file), '--skip-duplicate'], { stdio: 'inherit' });
          break;
        } catch (error) {
          if (attempt === 3) throw error;
          console.log(`Retrying ${file} after Marketplace failure (${attempt}/3)`);
          await new Promise(resolve => setTimeout(resolve, attempt * 15000));
        }
      }
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Marketplace ${tag}\n\n${command === 'publish' ? 'Publish commands succeeded (existing platform versions were skipped). Marketplace validation may still be pending.' : 'All eight release packages passed validation. No packages were published by this step.'}\n`);
}

module.exports = { releaseVersion, expectedPackages, validateChecksums, validateMetadata, validatePackages };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
