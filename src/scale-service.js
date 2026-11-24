'use strict';

const { EventEmitter } = require('events');
const { getDriver, detectableDrivers } = require('./drivers');

const DEFAULT_CONFIG = Object.freeze({
  port: 'auto',
  protocol: 'auto',
  baudRate: 9600,
  dataBits: 8,
  parity: 'none',
  stopBits: 1,
});

const DETECT_BAUDS = [9600, 4800, 2400];
const DETECT_TIMEOUT_PER_TRY_MS = 800;
const RECONNECT_MS = 3000;
/** Procurar de novo uma balança que não foi achada (procurar ocupa as portas COM por vários segundos). */
const REDETECT_MS = 30000;
const SIMULATOR_TICK_MS = 200;
/** Sem estabilidade informada pela balança: estável quando o peso se repete N vezes. */
const STABLE_REPEATS = 3;
const STABLE_TOLERANCE_KG = 0.002;

/** Decide "estável" quando o driver não informa (repetição do mesmo peso). */
class StabilityTracker {
  constructor() {
    this.history = [];
    this.lastWeight = null;
  }

  push(reading) {
    if (reading.weightKg === null || reading.weightKg === undefined) {
      // A balança só disse "instável", sem número: mantém o último peso
      this.history = [];
      return this.lastWeight === null ? null : { weightKg: this.lastWeight, stable: false };
    }
    this.lastWeight = reading.weightKg;
    if (reading.stable === true || reading.stable === false) {
      this.history = [];
      return { weightKg: reading.weightKg, stable: reading.stable };
    }
    this.history.push(reading.weightKg);
    if (this.history.length > STABLE_REPEATS) this.history.shift();
    const stable =
      this.history.length === STABLE_REPEATS &&
      Math.max(...this.history) - Math.min(...this.history) <= STABLE_TOLERANCE_KG;
    return { weightKg: reading.weightKg, stable };
  }
}

function sanitizeRaw(text) {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '·').slice(-120);
}

/**
 * Lê a balança. Eventos:
 *  - 'reading' { weightKg, stable, raw }
 *  - 'status'  { state: 'connected' | 'connecting' | 'error' | 'stopped', message }
 * `io` injeta a porta serial (facilita os testes): { openPort(path, serialOptions), listPorts() }.
 */
class ScaleService extends EventEmitter {
  constructor({ io, timers = globalThis } = {}) {
    super();
    this.io = io;
    this.timers = timers;
    this.config = { ...DEFAULT_CONFIG };
    this.port = null;
    this.driver = null;
    this.buffer = '';
    this.requestTimer = null;
    this.reconnectTimer = null;
    this.simTimer = null;
    this.simStartedAt = 0;
    this.tracker = new StabilityTracker();
    this.running = false;
    this.detecting = false;
    this.state = 'stopped';
  }

  getConfig() {
    return { ...this.config };
  }

  /** Troca a configuração e reabre a leitura. */
  async configure(config) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    await this.restart();
    return this.getConfig();
  }

  async start() {
    this.running = true;
    await this.open();
  }

  async stop() {
    this.running = false;
    this.clearTimers();
    await this.closePort();
    this.setStatus('stopped', '');
  }

  async restart() {
    await this.stop();
    await this.start();
  }

  clearTimers() {
    for (const key of ['requestTimer', 'reconnectTimer', 'simTimer']) {
      if (this[key]) {
        this.timers.clearInterval(this[key]);
        this.timers.clearTimeout(this[key]);
        this[key] = null;
      }
    }
  }

  setStatus(state, message) {
    this.state = state;
    this.emit('status', { state, message });
  }

  async open() {
    if (!this.running || this.detecting) return;
    this.tracker = new StabilityTracker();
    this.buffer = '';

    if (this.config.protocol === 'simulator') {
      this.driver = getDriver('simulator');
      this.simStartedAt = Date.now();
      this.simTimer = this.timers.setInterval(() => {
        const r = this.driver.simulatedReading(Date.now() - this.simStartedAt);
        this.emit('reading', { ...r, raw: `SIMULADOR ${r.weightKg.toFixed(3)} kg ${r.stable ? 'ST' : 'US'}` });
      }, SIMULATOR_TICK_MS);
      this.setStatus('connected', 'Simulador');
      return;
    }

    let config = this.config;
    if (config.port === 'auto' || config.protocol === 'auto') {
      this.setStatus('connecting', 'Procurando a balança…');
      const found = await this.detect();
      if (!found) {
        this.setStatus('error', 'Balança não encontrada. Confira o cabo e a configuração.');
        this.scheduleReconnect(REDETECT_MS);
        return;
      }
      config = found;
      // O app salva o que foi encontrado para não precisar procurar de novo
      this.emit('detected', found);
    }

    const driver = getDriver(config.protocol);
    if (!driver) {
      this.setStatus('error', `Marca desconhecida: ${config.protocol}`);
      return;
    }
    this.driver = driver;

    try {
      this.setStatus('connecting', `Abrindo ${config.port}…`);
      this.port = await this.io.openPort(config.port, serialOptions(config));
    } catch (err) {
      this.setStatus('error', `Não foi possível abrir ${config.port}: ${err.message}`);
      this.scheduleReconnect();
      return;
    }

    this.port.on('data', (chunk) => this.onData(chunk));
    this.port.on('error', (err) => this.onPortLost(err));
    this.port.on('close', () => this.onPortLost(new Error('porta fechada')));
    if (driver.requestCmd) {
      this.requestTimer = this.timers.setInterval(() => {
        try {
          this.port && this.port.write(driver.requestCmd);
        } catch (err) {
          this.onPortLost(err);
        }
      }, driver.requestIntervalMs || 200);
    }
    this.setStatus('connected', `${driver.label} em ${config.port}`);
  }

  onData(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
    this.buffer += text;
    if (this.buffer.length > 4096) this.buffer = this.buffer.slice(-1024);
    const { readings, rest } = this.driver.parse(this.buffer);
    const consumed = this.buffer.slice(0, this.buffer.length - rest.length);
    this.buffer = rest;
    for (const reading of readings) {
      const decided = this.tracker.push(reading);
      if (decided) this.emit('reading', { ...decided, raw: sanitizeRaw(consumed) });
    }
  }

  async onPortLost(err) {
    if (!this.port) return;
    await this.closePort();
    this.clearTimers();
    this.setStatus('error', `Balança desconectada (${err.message}). Tentando de novo…`);
    this.scheduleReconnect();
  }

  scheduleReconnect(delayMs = RECONNECT_MS) {
    if (!this.running || this.reconnectTimer) return;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delayMs);
  }

  async closePort() {
    const port = this.port;
    this.port = null;
    if (!port) return;
    port.removeAllListeners && port.removeAllListeners();
    await new Promise((resolve) => {
      try {
        port.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }

  async listPorts() {
    const ports = await this.io.listPorts();
    return ports.map((p) => ({
      path: p.path,
      label: [p.path, p.friendlyName || p.manufacturer].filter(Boolean).join(' · '),
    }));
  }

  /**
   * Auto-detectar: testa cada porta × marca × velocidade até chegar um peso válido.
   * Usa a porta/marca da configuração quando elas não são "auto".
   */
  async detect({ timeoutPerTryMs = DETECT_TIMEOUT_PER_TRY_MS } = {}) {
    if (this.detecting) return null;
    this.detecting = true;
    const wasOpen = !!this.port;
    if (wasOpen) await this.closePort();
    this.clearTimers();
    try {
      const paths =
        this.config.port && this.config.port !== 'auto'
          ? [this.config.port]
          : (await this.io.listPorts()).map((p) => p.path);
      const drivers =
        this.config.protocol && this.config.protocol !== 'auto'
          ? [getDriver(this.config.protocol)].filter(Boolean)
          : detectableDrivers();

      for (const path of paths) {
        for (const driver of drivers) {
          const bauds = [driver.defaultSerial.baudRate, ...DETECT_BAUDS.filter((b) => b !== driver.defaultSerial.baudRate)];
          for (const baudRate of bauds) {
            const config = { ...DEFAULT_CONFIG, port: path, protocol: driver.id, baudRate };
            // eslint-disable-next-line no-await-in-loop
            if (await this.tryConfig(config, driver, timeoutPerTryMs)) return config;
          }
        }
      }
      return null;
    } finally {
      this.detecting = false;
    }
  }

  /** Abre a porta com a configuração e espera uma leitura válida do driver. */
  async tryConfig(config, driver, timeoutMs) {
    let port;
    try {
      port = await this.io.openPort(config.port, serialOptions(config));
    } catch {
      return false;
    }
    return new Promise((resolve) => {
      let buffer = '';
      let done = false;
      let requestTimer = null;
      const finish = (ok) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timeout);
        if (requestTimer) this.timers.clearInterval(requestTimer);
        port.removeAllListeners && port.removeAllListeners();
        try {
          port.close(() => resolve(ok));
        } catch {
          resolve(ok);
        }
      };
      const timeout = this.timers.setTimeout(() => finish(false), timeoutMs);
      port.on('data', (chunk) => {
        buffer += Buffer.isBuffer(chunk) ? chunk.toString('latin1') : String(chunk);
        const { readings } = driver.parse(buffer);
        if (readings.some((r) => typeof r.weightKg === 'number' && Number.isFinite(r.weightKg))) finish(true);
      });
      port.on('error', () => finish(false));
      if (driver.requestCmd) {
        const send = () => {
          try {
            port.write(driver.requestCmd);
          } catch {
            finish(false);
          }
        };
        send();
        requestTimer = this.timers.setInterval(send, driver.requestIntervalMs || 200);
      }
    });
  }
}

function serialOptions(config) {
  return {
    baudRate: config.baudRate,
    dataBits: config.dataBits,
    parity: config.parity,
    stopBits: config.stopBits,
  };
}

module.exports = { ScaleService, StabilityTracker, DEFAULT_CONFIG, DETECT_BAUDS };
