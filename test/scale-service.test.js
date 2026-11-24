'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');
const { ScaleService, StabilityTracker } = require('../src/scale-service');

/** Porta serial falsa: responde ao ENQ com o texto configurado para aquela porta/velocidade. */
class FakePort extends EventEmitter {
  constructor(responder) {
    super();
    this.responder = responder;
    this.closed = false;
    this.writes = [];
  }
  write(data) {
    this.writes.push(data);
    const answer = this.responder && this.responder(data);
    if (answer) setImmediate(() => this.emit('data', Buffer.from(answer, 'latin1')));
  }
  close(cb) {
    this.closed = true;
    cb && cb();
  }
}

function fakeIo({ ports = ['COM1', 'COM3'], respond = () => null } = {}) {
  const opened = [];
  return {
    opened,
    async listPorts() {
      return ports.map((path) => ({ path, manufacturer: 'FTDI' }));
    },
    async openPort(path, options) {
      if (!ports.includes(path)) throw new Error('porta não existe');
      const port = new FakePort((data) => respond(path, options, data));
      opened.push({ path, options, port });
      return port;
    },
  };
}

test('estável pela repetição quando o driver não informa', () => {
  const t = new StabilityTracker();
  assert.deepEqual(t.push({ weightKg: 0.65 }), { weightKg: 0.65, stable: false });
  assert.deepEqual(t.push({ weightKg: 0.651 }), { weightKg: 0.651, stable: false });
  assert.deepEqual(t.push({ weightKg: 0.65 }), { weightKg: 0.65, stable: true });
  assert.deepEqual(t.push({ weightKg: 0.7 }), { weightKg: 0.7, stable: false });
});

test('"instável" sem número mantém o último peso como instável', () => {
  const t = new StabilityTracker();
  t.push({ weightKg: 0.65, stable: true });
  assert.deepEqual(t.push({ weightKg: null, stable: false }), { weightKg: 0.65, stable: false });
});

test('lê a balança configurada (Toledo em COM3) e emite o peso com o texto cru', async () => {
  const io = fakeIo({ respond: (path) => (path === 'COM3' ? '\x0200650\x03' : null) });
  const scale = new ScaleService({ io });
  const reading = new Promise((resolve) => scale.once('reading', resolve));
  await scale.configure({ port: 'COM3', protocol: 'toledo', baudRate: 9600 });
  const r = await reading;
  assert.equal(r.weightKg, 0.65);
  assert.equal(r.stable, true);
  assert.match(r.raw, /00650/);
  assert.equal(io.opened[0].options.baudRate, 9600);
  await scale.stop();
});

test('auto-detectar acha a porta, a marca e a velocidade que respondem', async () => {
  // Só COM3 a 2400 baud responde no formato de 5 dígitos
  const io = fakeIo({
    respond: (path, options) => (path === 'COM3' && options.baudRate === 2400 ? '\x0200500\x03' : null),
  });
  const scale = new ScaleService({ io });
  const found = await scale.detect({ timeoutPerTryMs: 30 });
  assert.deepEqual(found, {
    port: 'COM3',
    protocol: 'toledo',
    baudRate: 2400,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
  });
  assert.ok(io.opened.every((o) => o.port.closed), 'fecha todas as portas testadas');
});

test('auto-detectar sem balança devolve null', async () => {
  const scale = new ScaleService({ io: fakeIo() });
  assert.equal(await scale.detect({ timeoutPerTryMs: 10 }), null);
});

test('porta que cai avisa e tenta reabrir', async () => {
  const io = fakeIo({ respond: () => '\x0200650\x03' });
  const timers = { ...globalThis, setTimeout: (fn) => ({ fn }), clearTimeout() {}, setInterval, clearInterval };
  const scale = new ScaleService({ io, timers });
  const statuses = [];
  scale.on('status', (s) => statuses.push(s.state));
  await scale.configure({ port: 'COM3', protocol: 'toledo', baudRate: 9600 });
  io.opened[0].port.emit('error', new Error('cabo solto'));
  await new Promise((r) => setImmediate(r));
  assert.ok(statuses.includes('error'));
  assert.ok(scale.reconnectTimer, 'agendou nova tentativa');
  scale.running = false;
  scale.clearTimers();
});

test('simulador não abre porta e manda leituras', async () => {
  const io = fakeIo();
  const scale = new ScaleService({ io });
  const reading = new Promise((resolve) => scale.once('reading', resolve));
  await scale.configure({ port: 'auto', protocol: 'simulator', baudRate: 9600 });
  const r = await reading;
  assert.equal(typeof r.weightKg, 'number');
  assert.equal(io.opened.length, 0);
  await scale.stop();
});

test('lista as portas com o fabricante', async () => {
  const scale = new ScaleService({ io: fakeIo({ ports: ['COM3'] }) });
  assert.deepEqual(await scale.listPorts(), [{ path: 'COM3', label: 'COM3 · FTDI' }]);
});
