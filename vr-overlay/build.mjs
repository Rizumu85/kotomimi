// vr-overlay/build.mjs — `npm run build:vr-overlay`
//
// Fork: builds the SteamVR overlay helper (Windows): the pinned OpenVR SDK
// fetched, the helper built in Release, its geometry tested, and the helper
// with its library left in vr-overlay/kotomimi-vr/ for the package to take.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
  console.log('The SteamVR overlay helper is built on Windows only.');
  process.exit(0);
}
await import('./fetch-openvr.mjs');
const here = dirname(fileURLToPath(import.meta.url));
const build = join(here, 'build');
const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
run('cmake', ['-S', here, '-B', build, '-A', 'x64']);
run('cmake', ['--build', build, '--config', 'Release']);
run(join(build, 'Release', 'geometry-test.exe'), []);
