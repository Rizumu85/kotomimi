const pkg = require('./package.json');
const fs = require('fs');
const { execFileSync } = require('child_process');

// codesign's entitlement parser rejects some otherwise valid source formatting.
// Normalize a build-local copy instead of changing the shared stable file.
const entitlements = 'out/beta-entitlements.plist';
fs.mkdirSync('out', { recursive: true });
fs.writeFileSync(entitlements, execFileSync('plutil', ['-convert', 'xml1', '-o', '-', 'electron/entitlements.mac.plist']));

module.exports = {
  ...pkg.build,
  appId: 'io.github.rizumu85.kotomimi.beta',
  productName: 'Kotomimi Beta',
  directories: { output: 'out/beta-mac' },
  extraMetadata: {
    name: 'kotomimi-beta',
    productName: 'Kotomimi Beta',
    version: process.env.KOTOMIMI_BETA_VERSION || `${pkg.version}-beta.1`,
  },
  publish: null,
  mac: {
    ...pkg.build.mac,
    target: [{ target: 'zip', arch: ['arm64'] }],
    icon: 'assets/beta/icon.icns',
    // Local beta testing works with an ad-hoc signature; use a certificate only
    // when the build machine explicitly provides an accessible signing identity.
    identity: process.env.CSC_NAME || null,
    entitlements,
    entitlementsInherit: entitlements,
    extendInfo: {
      ...pkg.build.mac.extendInfo,
      NSMicrophoneUsageDescription: 'Kotomimi Beta uses your microphone to transcribe and translate your speech.',
      NSAudioCaptureUsageDescription: 'Kotomimi Beta captures conversation audio for transcription and translation.',
    },
  },
};
