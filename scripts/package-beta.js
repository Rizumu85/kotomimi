// Build a private beta without changing the stable release's version or identity.
const { spawnSync } = require('child_process');
const pkg = require('../package.json');
const version = process.env.KOTOMIMI_BETA_VERSION || `${pkg.version}-beta.1`;
if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(version)) throw new Error('Expected X.Y.Z-beta.N');
process.env.KOTOMIMI_BETA_VERSION = version;
const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: 'inherit', shell: process.platform === 'win32', env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
};
run('npm', ['run', 'build:audio-host']);
if (process.platform === 'darwin') run('bash', ['native/apple-speech/build.sh']);
run('npm', ['run', 'build']);
if (process.platform === 'win32') run('npx', ['electron-forge', 'make']);
else if (process.platform === 'darwin') run('npx', ['electron-builder', '--mac', '--arm64', '--publish', 'never', '--config', 'electron-builder.beta.config.js']);
else throw new Error('Private beta packaging currently supports Windows and macOS.');
