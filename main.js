'use strict';

const { app, Tray, Menu, nativeImage, dialog, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { io } = require('socket.io-client');

const { ConfigStore } = require('./src/config-store');
const { ScaleService } = require('./src/scale-service');
const { AgentClient } = require('./src/agent-client');
const { getDriver } = require('./src/drivers');
const serial = require('./src/serial');

/**
 * Agente de Balança - Podi Pedir.
 * Lê a balança (USB/COM) e manda o peso para a API (`/scale`), que repassa ao PDV da loja.
 * Ativa com o mesmo token da impressora. Porta, marca e velocidade são escolhidas no Admin (Apps).
 */

const API_URL = (process.env.API_URL || 'https://api.podipedir.com.br').replace(/\/+$/, '');
const UPDATE_CHECK_INTERVAL_MS = 3 * 60 * 60 * 1000; // 3 horas

// Uma instância só: duas abrindo a mesma porta COM brigariam pela balança
if (!app.requestSingleInstanceLock()) {
  app.quit();
}

if (app.dock) app.dock.hide();

app.setLoginItemSettings({ openAtLogin: true, path: app.getPath('exe') });

let tray = null;
let store = null;
let scale = null;
let client = null;
let activationWindow = null;
let serverStatus = 'Desconectado';
let scaleStatus = 'Parada';
let lastReading = null;
let isManualUpdateCheck = false;
let isCheckingForUpdates = false;

function formatKg(kg) {
  return `${Number(kg).toFixed(3).replace('.', ',')} kg`;
}

function scaleLabel(config) {
  const driver = getDriver(config.protocol);
  const brand = config.protocol === 'auto' ? 'Automática' : driver ? driver.label : config.protocol;
  return `${brand} · ${config.port === 'auto' ? 'porta automática' : config.port} · ${config.baudRate}`;
}

function updateTray() {
  if (!tray) return;
  const cfg = store.get();
  const storeName = cfg.store_name ? ` (${cfg.store_name})` : '';
  const weight = lastReading ? `${formatKg(lastReading.weightKg)}${lastReading.stable ? '' : ' (instável)'}` : '—';

  const menu = Menu.buildFromTemplate([
    { label: `Balança - Podi Pedir (v${app.getVersion()})`, enabled: false },
    { type: 'separator' },
    { label: `Servidor: ${serverStatus}${storeName}`, enabled: false },
    { label: `Balança: ${scaleStatus}`, enabled: false },
    { label: `Configuração: ${scaleLabel(cfg.scale)}`, enabled: false },
    { label: `Último peso: ${weight}`, enabled: false },
    { type: 'separator' },
    { label: 'Alterar token / nome da balança', click: () => openActivationWindow() },
    {
      label: 'Testar leitura',
      click: () => {
        dialog.showMessageBox({
          type: 'info',
          title: 'Leitura da balança',
          message: lastReading ? formatKg(lastReading.weightKg) : 'Nenhuma leitura ainda',
          detail: lastReading
            ? `${lastReading.stable ? 'Peso estável' : 'Peso instável'}\nRecebido: ${lastReading.raw || '—'}\n\n${scaleStatus}`
            : `${scaleStatus}\n\nConfigure a porta, a marca e a velocidade no painel (Apps → Agente de Balança).`,
          buttons: ['OK'],
        });
      },
    },
    { type: 'separator' },
    { label: 'Verificar atualizações', click: () => checkForUpdates(true) },
    { type: 'separator' },
    {
      label: 'Sair',
      click: () => {
        app.isQuiting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Podi Pedir Balança - ${serverStatus}`);
}

// Atualiza o menu no máximo 1x por segundo (o peso chega várias vezes por segundo)
let trayTimer = null;
function updateTraySoon() {
  if (trayTimer) return;
  trayTimer = setTimeout(() => {
    trayTimer = null;
    updateTray();
  }, 1000);
}

function startAgent() {
  const cfg = store.get();
  if (!cfg.token) {
    serverStatus = '⚠️ Aguardando token';
    updateTray();
    openActivationWindow();
    return;
  }
  client.connect();
}

function openActivationWindow(initialError = '') {
  if (activationWindow) {
    activationWindow.focus();
    return;
  }
  const cfg = store.get();
  activationWindow = new BrowserWindow({
    width: 440,
    height: 560,
    resizable: false,
    title: 'Ativação da Balança - Podi Pedir',
    icon: path.join(__dirname, 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });

  const esc = (v) => String(v || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const html = `<!DOCTYPE html>
  <html lang="pt-BR"><head><meta charset="UTF-8" /><title>Ativar Balança</title>
  <style>
    body { font-family: "Segoe UI", Roboto, sans-serif; background: #f8fafc; color: #0f172a; margin: 0; padding: 24px; box-sizing: border-box; }
    h2 { font-size: 18px; margin-top: 0; }
    p { font-size: 13px; color: #64748b; line-height: 1.4; }
    label { font-size: 12px; font-weight: 600; color: #475569; display: block; margin: 14px 0 6px; }
    input { width: 100%; padding: 10px 12px; border: 1px solid #cbd5e1; border-radius: 8px; font-size: 14px; box-sizing: border-box; }
    #token { font-family: monospace; font-weight: bold; }
    button { margin-top: 20px; width: 100%; background: #d97706; color: white; border: none; padding: 12px; border-radius: 8px; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:disabled { opacity: .6; }
    .error { margin-top: 12px; padding: 10px; background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; font-size: 12px; border-radius: 6px; display: ${initialError ? 'block' : 'none'}; }
  </style></head>
  <body>
    <h2>⚖️ Ativação da Balança</h2>
    <p>Use o <strong>mesmo token da impressora</strong>, que fica no painel em Apps. Dê um nome para reconhecer esta balança no PDV (ex.: Balança Caixa 1).</p>
    <label for="token">Token da loja</label>
    <input id="token" placeholder="Cole o token aqui..." value="${esc(cfg.token)}" />
    <label for="name">Nome da balança</label>
    <input id="name" maxlength="60" value="${esc(cfg.deviceName)}" />
    <div id="error" class="error">${esc(initialError)}</div>
    <button id="btn" onclick="submitForm()">Ativar balança</button>
    <script>
      const { ipcRenderer } = require('electron');
      function submitForm() {
        const token = document.getElementById('token').value.trim();
        const name = document.getElementById('name').value.trim();
        const err = document.getElementById('error');
        if (!token) { err.innerText = 'Digite ou cole o token da loja.'; err.style.display = 'block'; return; }
        err.style.display = 'none';
        const btn = document.getElementById('btn'); btn.disabled = true; btn.innerText = 'Validando...';
        ipcRenderer.send('validate-token', { token, name });
      }
      ipcRenderer.on('token-result', (_e, res) => {
        const btn = document.getElementById('btn'); btn.disabled = false; btn.innerText = 'Ativar balança';
        if (!res.success) { const err = document.getElementById('error'); err.innerText = res.message; err.style.display = 'block'; }
      });
    </script>
  </body></html>`;

  activationWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
  activationWindow.on('closed', () => {
    activationWindow = null;
  });
}

ipcMain.on('validate-token', async (event, { token, name }) => {
  try {
    const cleanToken = String(token || '').trim();
    // Mesmo endpoint de ativação do agente de impressão (o token é o da loja)
    const response = await fetch(`${API_URL}/api/stores/print-agent/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: cleanToken }),
    });
    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      event.sender.send('token-result', { success: false, message: errData.message || 'Token inválido.' });
      return;
    }
    const data = await response.json();
    store.save({
      token: data.printToken || cleanToken,
      store_id: data.storeId,
      store_name: data.storeName,
      deviceName: String(name || '').trim().slice(0, 60) || store.get().deviceName,
    });
    event.sender.send('token-result', { success: true });
    if (activationWindow) activationWindow.close();
    startAgent();
  } catch {
    event.sender.send('token-result', {
      success: false,
      message: 'Erro ao conectar ao servidor. Verifique a internet.',
    });
  }
});

// ------------------------------------------------------------------ atualização automática

function setupAutoUpdater() {
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    isCheckingForUpdates = true;
  });
  autoUpdater.on('update-available', (info) => {
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Atualização disponível',
        message: `Nova versão (v${info.version}) encontrada.`,
        detail: 'O download começou em segundo plano. Avisaremos quando estiver pronta.',
        buttons: ['OK'],
      });
    }
  });
  autoUpdater.on('update-not-available', () => {
    isCheckingForUpdates = false;
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'info',
        title: 'Sem atualizações',
        message: `Você já está na versão mais recente (v${app.getVersion()}).`,
        buttons: ['OK'],
      });
    }
  });
  autoUpdater.on('update-downloaded', (info) => {
    isCheckingForUpdates = false;
    isManualUpdateCheck = false;
    dialog
      .showMessageBox({
        type: 'info',
        title: 'Atualização pronta',
        message: `A versão v${info.version} foi baixada.`,
        detail: 'Reiniciar a balança agora para instalar? Se preferir, ela será instalada ao fechar o programa.',
        buttons: ['Reiniciar e atualizar', 'Depois'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) {
          app.isQuiting = true;
          autoUpdater.quitAndInstall();
        }
      })
      .catch(() => {});
  });
  autoUpdater.on('error', (err) => {
    isCheckingForUpdates = false;
    console.error('Erro ao verificar atualizações:', err && err.message ? err.message : err);
    if (isManualUpdateCheck) {
      isManualUpdateCheck = false;
      dialog.showMessageBox({
        type: 'warning',
        title: 'Erro ao verificar atualizações',
        message: 'Não foi possível verificar atualizações agora.',
        buttons: ['OK'],
      });
    }
  });
}

function checkForUpdates(manual = false) {
  if (!app.isPackaged) {
    if (manual) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Modo desenvolvimento',
        message: 'A verificação de atualizações só funciona na versão instalada (.exe).',
        buttons: ['OK'],
      });
    }
    return;
  }
  if (isCheckingForUpdates) return;
  isManualUpdateCheck = manual;
  autoUpdater.checkForUpdates().catch(() => {
    isCheckingForUpdates = false;
  });
}

// ------------------------------------------------------------------ início

app.whenReady().then(async () => {
  store = new ConfigStore(path.join(app.getPath('userData'), 'balance_agent_config.json'));
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'icon.png')));

  scale = new ScaleService({ io: serial });
  scale.on('status', ({ state, message }) => {
    const prefix = { connected: '✅', connecting: '⏳', error: '❌', stopped: '⏸️' }[state] || '';
    scaleStatus = `${prefix} ${message || state}`.trim();
    updateTraySoon();
  });
  scale.on('reading', (r) => {
    lastReading = r;
    updateTraySoon();
  });
  // Auto-detectar ao abrir: grava o que achou para não procurar de novo
  scale.on('detected', (found) => store.save({ scale: found }));

  client = new AgentClient({
    ioFactory: io,
    apiUrl: API_URL,
    scale,
    version: app.getVersion(),
    getIdentity: () => {
      const cfg = store.get();
      return { token: cfg.token, deviceId: cfg.deviceId, name: cfg.deviceName };
    },
  });
  client.on('status', ({ state, message }) => {
    serverStatus = { connected: '✅ Conectado', disconnected: '⚠️ Desconectado', auth_error: '❌ Token inválido' }[state];
    updateTray();
    if (state === 'auth_error') {
      client.disconnect();
      openActivationWindow(message);
    }
  });
  // Configuração vinda do Admin (Apps → Configurar balança)
  client.on('config-saved', (config) => {
    store.save({ scale: config });
    updateTray();
  });

  updateTray();
  await scale.configure(store.get().scale);
  startAgent();

  setupAutoUpdater();
  setTimeout(() => checkForUpdates(false), 10000);
  setInterval(() => checkForUpdates(false), UPDATE_CHECK_INTERVAL_MS);
});

app.on('before-quit', () => {
  if (client) client.destroy();
  if (scale) scale.stop();
});

app.on('window-all-closed', (e) => e.preventDefault());
