'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DEFAULT_CONFIG } = require('./scale-service');

/**
 * `balance_agent_config.json` na pasta do app (AppData). Guarda a ativação (token da impressora),
 * a identificação desta balança e a configuração da porta/marca/velocidade.
 */
function slug(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
    .slice(0, 40);
}

/** Identificador estável deste computador/balança (aceito pela API: letras, números, - e _). */
function newDeviceId(hostname = os.hostname()) {
  return `${slug(hostname) || 'balanca'}-${crypto.randomBytes(3).toString('hex')}`.slice(0, 64);
}

function defaults(hostname = os.hostname()) {
  return {
    token: '',
    store_id: '',
    store_name: '',
    deviceId: newDeviceId(hostname),
    deviceName: `Balança ${hostname}`.slice(0, 60),
    scale: { ...DEFAULT_CONFIG },
  };
}

class ConfigStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = this.load();
  }

  load() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      const base = defaults();
      const merged = { ...base, ...saved, scale: { ...base.scale, ...(saved.scale || {}) } };
      // deviceId gerado agora precisa ser gravado para não mudar a cada abertura
      if (!saved.deviceId) this.write(merged);
      return merged;
    } catch {
      const fresh = defaults();
      this.write(fresh);
      return fresh;
    }
  }

  get() {
    return { ...this.data, scale: { ...this.data.scale } };
  }

  save(patch) {
    this.data = {
      ...this.data,
      ...patch,
      scale: { ...this.data.scale, ...(patch.scale || {}) },
    };
    this.write(this.data);
    return this.get();
  }

  write(data) {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2));
    } catch (err) {
      console.error('Erro ao salvar a configuração:', err);
    }
  }
}

module.exports = { ConfigStore, newDeviceId, slug };
