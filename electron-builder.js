const fs = require('fs');
const path = require('path');

// Arquivos do app no instalador (testes e scripts de build ficam de fora)
const files = ['main.js', 'src/**/*', 'icon.png', 'package.json'];
if (fs.existsSync(path.join(__dirname, '.env'))) {
  files.push('.env');
}

module.exports = {
  appId: 'com.podipedir.balanceagent',
  productName: 'Podi Pedir Balança',
  artifactName: 'balance-agent-setup.exe',
  files,
  // serialport é módulo nativo: o electron-builder recompila/escolhe o binário para o Electron
  npmRebuild: true,
  publish: [
    {
      provider: 'github',
      owner: 'thiekokumagai',
      repo: 'balance-lojapod',
      releaseType: 'release',
    },
  ],
  win: {
    target: 'nsis',
    icon: 'icon.ico',
    requestedExecutionLevel: 'asInvoker',
  },
  nsis: {
    oneClick: true,
    perMachine: false,
    allowToChangeInstallationDirectory: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Podi Pedir Balança',
    installerIcon: 'icon.ico',
    uninstallerIcon: 'icon.ico',
    deleteAppDataOnUninstall: true,
    include: 'installer.nsh',
  },
};
