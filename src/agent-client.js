'use strict';

const { EventEmitter } = require('events');
const { DRIVERS } = require('./drivers');

/** Intervalo mínimo entre dois pesos enviados (~5 por segundo). */
const MIN_SEND_INTERVAL_MS = 200;
/**
 * Sinal de vida: enquanto um PDV acompanha, manda o peso pelo menos 1 vez por segundo mesmo sem mudança.
 * O PDV considera a balança parada depois de 3 s sem leitura e cai para o modo de digitar.
 */
const HEARTBEAT_MS = 1000;

/**
 * Conexão do agente com a API (namespace `/scale`), usando o mesmo token da impressora.
 * Eventos: 'status' { state: 'connected'|'disconnected'|'auth_error', message }, 'config-saved' (config).
 */
class AgentClient extends EventEmitter {
  constructor({ ioFactory, apiUrl, scale, getIdentity, version, timers = globalThis, now = () => Date.now() }) {
    super();
    this.ioFactory = ioFactory;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.scale = scale;
    this.getIdentity = getIdentity;
    this.version = version;
    this.timers = timers;
    this.now = now;
    this.socket = null;
    this.streaming = false;
    this.latest = null;
    this.lastSent = null;
    this.lastSentAt = -Infinity; // nunca enviado
    this.heartbeat = null;
    this.trailing = null;
    this.onReading = (r) => this.handleReading(r);
    this.scale.on('reading', this.onReading);
  }

  connect() {
    this.disconnect();
    const identity = this.getIdentity();
    if (!identity.token) {
      this.emit('status', { state: 'auth_error', message: 'Token não informado.' });
      return;
    }
    const socket = this.ioFactory(`${this.apiUrl}/scale`, {
      auth: {
        role: 'agent',
        token: identity.token,
        deviceId: identity.deviceId,
        name: identity.name,
        version: this.version,
      },
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 2000,
      reconnectionDelayMax: 15000,
    });
    this.socket = socket;

    socket.on('connect', () => {
      this.emit('status', { state: 'connected', message: '' });
      this.sendHello();
    });
    socket.on('disconnect', () => {
      this.setStreaming(false);
      this.emit('status', { state: 'disconnected', message: '' });
    });
    socket.on('auth_error', (data) => {
      this.setStreaming(false);
      this.emit('status', { state: 'auth_error', message: (data && data.message) || 'Token recusado.' });
    });
    socket.on('scale.ready', (data) => this.emit('ready', data));
    socket.on('scale.stream', (data) => this.setStreaming(!!(data && data.active)));

    socket.on('scale.config', async (config, ack) => {
      try {
        const saved = await this.scale.configure(config);
        this.emit('config-saved', saved);
        this.sendHello();
        reply(ack, { ok: true, config: saved });
      } catch (err) {
        reply(ack, { ok: false, error: `Não foi possível aplicar: ${err.message}` });
      }
    });
    socket.on('scale.ports', async (_payload, ack) => {
      try {
        reply(ack, { ok: true, ports: await this.scale.listPorts() });
      } catch (err) {
        reply(ack, { ok: false, error: `Não foi possível listar as portas: ${err.message}` });
      }
    });
    socket.on('scale.detect', async (_payload, ack) => {
      try {
        const found = await this.scale.detect();
        if (!found) {
          reply(ack, { ok: false, error: 'Nenhuma balança respondeu nas portas deste computador.' });
          await this.scale.start();
          return;
        }
        const saved = await this.scale.configure(found);
        this.emit('config-saved', saved);
        this.sendHello();
        reply(ack, { ok: true, config: saved });
      } catch (err) {
        reply(ack, { ok: false, error: `Falha ao procurar a balança: ${err.message}` });
      }
    });
  }

  disconnect() {
    this.setStreaming(false);
    if (this.socket) {
      this.socket.removeAllListeners();
      this.socket.disconnect();
      this.socket = null;
    }
  }

  destroy() {
    this.disconnect();
    this.scale.off('reading', this.onReading);
  }

  sendHello() {
    if (!this.socket) return;
    this.socket.emit('scale.hello', {
      version: this.version,
      config: this.scale.getConfig(),
      drivers: DRIVERS.map((d) => d.id),
    });
  }

  setStreaming(active) {
    if (this.streaming === active) return;
    this.streaming = active;
    if (this.heartbeat) {
      this.timers.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    if (this.trailing) {
      this.timers.clearTimeout(this.trailing);
      this.trailing = null;
    }
    if (active) {
      this.lastSent = null;
      this.lastSentAt = -Infinity;
      if (this.latest) this.send(this.latest);
      this.heartbeat = this.timers.setInterval(() => {
        if (this.latest && this.now() - this.lastSentAt >= HEARTBEAT_MS) this.send(this.latest);
      }, HEARTBEAT_MS / 2);
    }
  }

  handleReading(reading) {
    this.latest = reading;
    if (!this.streaming) return;
    const prev = this.lastSent;
    const changed =
      !prev || Math.abs(prev.weightKg - reading.weightKg) >= 0.001 || prev.stable !== reading.stable;
    if (!changed) return; // o sinal de vida cuida de repetir
    // Mudou para estável/instável: manda na hora; só o número mudando respeita o intervalo mínimo
    const stabilityChanged = prev && prev.stable !== reading.stable;
    const wait = MIN_SEND_INTERVAL_MS - (this.now() - this.lastSentAt);
    if (!stabilityChanged && wait > 0) {
      // Manda o valor mais novo no fim do intervalo (sem esperar o sinal de vida)
      if (!this.trailing) {
        this.trailing = this.timers.setTimeout(() => {
          this.trailing = null;
          if (this.streaming && this.latest) this.send(this.latest);
        }, wait);
      }
      return;
    }
    this.send(reading);
  }

  send(reading) {
    if (!this.socket || !this.socket.connected) return;
    this.socket.emit('scale.weight', {
      weightKg: reading.weightKg,
      stable: reading.stable,
      ...(reading.raw !== undefined ? { raw: reading.raw } : {}),
    });
    this.lastSent = reading;
    this.lastSentAt = this.now();
  }
}

function reply(ack, payload) {
  if (typeof ack === 'function') ack(payload);
}

module.exports = { AgentClient, MIN_SEND_INTERVAL_MS, HEARTBEAT_MS };
