const path = require('path');
const fs = require('fs');
const pkg = require('./package.json');
const version = process.env.KOTOMIMI_BETA_VERSION || `${pkg.version}-beta.1`;

module.exports = function configureBeta(config) {
  Object.assign(config.packagerConfig, {
    name: 'Kotomimi Beta',
    executableName: 'kotomimi-beta',
    appBundleId: 'io.github.rizumu85.kotomimi.beta',
    appId: 'io.github.rizumu85.kotomimi.beta',
    appVersion: version,
    buildVersion: pkg.version,
    icon: 'assets/beta/icon.ico',
    win32metadata: { CompanyName: 'Kotomimi Beta', ProductName: 'Kotomimi Beta', FileDescription: 'Kotomimi Beta' },
  });
  config.makers = [{
    name: '@electron-forge/maker-squirrel',
    config: {
      name: 'KotomimiBeta',
      authors: 'Rizumu85',
      exe: 'kotomimi-beta.exe',
      description: 'Private beta of Kotomimi live speech translation',
      setupIcon: 'assets/beta/icon.ico',
      noMsi: true,
    },
  }];
  config.hooks.readPackageJson = async (_config, manifest) => ({
    ...manifest, name: 'kotomimi-beta', productName: 'Kotomimi Beta', version,
  });
  const afterCopy = config.hooks.packageAfterCopy;
  config.hooks.packageAfterCopy = async (...args) => {
    await afterCopy(...args);
    const manifestPath = path.join(args[1], 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    Object.assign(manifest, { name: 'kotomimi-beta', productName: 'Kotomimi Beta', version });
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  };
  return config;
};
