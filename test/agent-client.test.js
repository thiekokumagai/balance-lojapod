'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { AgentClient, HEARTBEAT_MS, MIN_SEND_INTERVAL_MS } = require('../src/agent-client');

class FakeSocket extends EventEmitter {
  constructor(url, opts) {
    super();
    this.url = url;
    this.opts = opts;
    this.connected = true;
    this.sent = [];
  }
  emit(event, ...args) {
    // emit do lado "cliente → servidor" fica registrado; o "servidor → cliente" usa serverSays
    this.sent.push({ event, payload: args[0] });
    return true;
  }
  serverSays(event, ...args) {
    return EventEmitter.prototype.emit.call(this, event, ...args);
  }
  disconnect() {
    this.connected = false;
  }
}

class FakeScale extends EventEmitter {
  constructor() {
    super();
    this.config = { port: 'COM3', protocol: 'toledo', baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
  }
  getConfig() {
    return { ...this.config };
  }
  async configure(c) {
    this.config = { ...this.config, ...c };
    return this.getConfig();
  }
  async listPorts() {
    return [{ path: 'COM3', label: 'COM3' }];
  }
  async detect() {
    return { port: 'COM4', protocol: 'urano', baudRate: 4800, dataBits: 8, parity: 'none', stopBits: 1 };
  }
  async start() {}
}

/** Relógio controlado: `tick(ms)` avança o tempo e roda os timers vencidos. */
function fakeClock() {
  let now = 0;
  let timers = [];
  let seq = 0;
  const add = (fn, ms, repeat) => {
    const t = { id: ++seq, fn, at: now + ms, ms, repeat };
    timers.push(t);
    return t;
  };
  const clear = (t) => {
    timers = timers.filter((x) => x !== t);
  };
  return {
    now: () => now,
    timers: { setTimeout: (fn, ms) => add(fn, ms, false), setInterval: (fn, ms) => add(fn, ms, true), clearTimeout: clear, clearInterval: clear },
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = timers.filter((t) => t.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!due) break;
        now = due.at;
        if (due.repeat) due.at += due.ms;
        else clear(due);
        due.fn();
      }
      now = end;
    },
  };
}

function setup() {
  const clock = fakeClock();
  const scale = new FakeScale();
  let socket;
  const client = new AgentClient({
    ioFactory: (url, opts) => (socket = new FakeSocket(url, opts)),
    apiUrl: 'https://api.exemplo.com/',
    scale,
    version: '1.0.0',
    getIdentity: () => ({ token: 'TOKEN-A', deviceId: 'caixa-1', name: 'Balança Caixa 1' }),
    timers: clock.timers,
    now: clock.now,
  });
  client.connect();
  return { client, scale, clock, socket: () => socket };
}
const weights = (socket) => socket.sent.filter((s) => s.event === 'scale.weight').map((s) => s.payload);

test('conecta no /scale com o token da impressora e se apresenta', () => {
  const { socket } = setup();
  assert.equal(socket().url, 'https://api.exemplo.com/scale');
  assert.deepEqual(socket().opts.auth, {
    role: 'agent',
    token: 'TOKEN-A',
    deviceId: 'caixa-1',
    name: 'Balança Caixa 1',
    version: '1.0.0',
  });
  socket().serverSays('connect');
  const hello = socket().sent.find((s) => s.event === 'scale.hello');
  assert.equal(hello.payload.config.port, 'COM3');
  assert.ok(hello.payload.drivers.includes('toledo'));
});

test('sem PDV acompanhando não manda peso', () => {
  const { scale, socket } = setup();
  scale.emit('reading', { weightKg: 0.7, stable: true });
  assert.deepEqual(weights(socket()), []);
});

test('acompanhando: manda na hora, repete a cada 1 s (sinal de vida) e para quando o PDV sai', () => {
  const { scale, socket, clock } = setup();
  scale.emit('reading', { weightKg: 0.7, stable: true, raw: '00700' });
  socket().serverSays('scale.stream', { active: true });
  assert.deepEqual(weights(socket()), [{ weightKg: 0.7, stable: true, raw: '00700' }]);

  clock.tick(HEARTBEAT_MS * 3);
  assert.ok(weights(socket()).length >= 3, 'repetiu o peso parado');

  socket().serverSays('scale.stream', { active: false });
  const count = weights(socket()).length;
  clock.tick(HEARTBEAT_MS * 3);
  scale.emit('reading', { weightKg: 0.8, stable: true });
  assert.equal(weights(socket()).length, count);
});

test('peso mudando rápido respeita o intervalo, mas o último valor sai no fim dele', () => {
  const { scale, socket, clock } = setup();
  socket().serverSays('scale.stream', { active: true });
  scale.emit('reading', { weightKg: 0.1, stable: false });
  scale.emit('reading', { weightKg: 0.2, stable: false });
  scale.emit('reading', { weightKg: 0.3, stable: false });
  assert.deepEqual(weights(socket()).map((w) => w.weightKg), [0.1]);
  clock.tick(MIN_SEND_INTERVAL_MS);
  assert.deepEqual(weights(socket()).map((w) => w.weightKg), [0.1, 0.3]);
});

test('ficou estável: manda na hora, sem esperar o intervalo', () => {
  const { scale, socket } = setup();
  socket().serverSays('scale.stream', { active: true });
  scale.emit('reading', { weightKg: 0.65, stable: false });
  scale.emit('reading', { weightKg: 0.65, stable: true });
  assert.deepEqual(weights(socket()).map((w) => w.stable), [false, true]);
});

test('configuração do Admin é aplicada, salva e confirmada', async () => {
  const { client, socket } = setup();
  const saved = [];
  client.on('config-saved', (c) => saved.push(c));
  const ack = await new Promise((resolve) =>
    socket().serverSays('scale.config', { port: 'COM5', protocol: 'filizola', baudRate: 2400 }, resolve),
  );
  assert.equal(ack.ok, true);
  assert.equal(ack.config.port, 'COM5');
  assert.equal(saved[0].protocol, 'filizola');
});

test('portas e auto-detectar respondem pelo ack', async () => {
  const { socket } = setup();
  const ports = await new Promise((resolve) => socket().serverSays('scale.ports', {}, resolve));
  assert.deepEqual(ports, { ok: true, ports: [{ path: 'COM3', label: 'COM3' }] });
  const detect = await new Promise((resolve) => socket().serverSays('scale.detect', {}, resolve));
  assert.equal(detect.ok, true);
  assert.equal(detect.config.protocol, 'urano');
});

test('token recusado avisa e para de mandar peso', () => {
  const { client, socket } = setup();
  const statuses = [];
  client.on('status', (s) => statuses.push(s));
  socket().serverSays('scale.stream', { active: true });
  socket().serverSays('auth_error', { message: 'Token inválido.' });
  assert.deepEqual(statuses.at(-1), { state: 'auth_error', message: 'Token inválido.' });
  assert.equal(client.streaming, false);
});

test('streaming (sinal de "pesagem em curso" usado pelo auto-update) liga com o PDV e desliga ao parar ou cair', () => {
  const { client, socket: getSocket } = setup();
  const socket = getSocket();
  assert.equal(client.streaming, false);
  socket.serverSays('scale.stream', { active: true });
  assert.equal(client.streaming, true);
  socket.serverSays('scale.stream', { active: false });
  assert.equal(client.streaming, false);
  socket.serverSays('scale.stream', { active: true });
  socket.serverSays('disconnect');
  assert.equal(client.streaming, false);
});
