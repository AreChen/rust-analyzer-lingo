const targets = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-gnu',
  'linux-arm64': 'aarch64-unknown-linux-gnu',
  'alpine-x64': 'x86_64-unknown-linux-musl',
  'alpine-arm64': 'aarch64-unknown-linux-musl',
};
const alpine = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;
const target = process.env.VSCE_TARGET ?? `${alpine ? 'alpine' : process.platform}-${process.arch}`;
if (!targets[target]) throw new Error(`Unsupported package target: ${target}`);
const executable = 'rust-analyzer-lingo-proxy' + (target.startsWith('win32-') ? '.exe' : '');
module.exports = { targets, target, triple: targets[target], executable };
