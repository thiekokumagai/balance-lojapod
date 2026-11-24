'use strict';

// Amostras de texto abaixo são EXEMPLOS no formato esperado de cada protocolo,
// não capturas de balanças reais. A leitura de cada marca precisa ser confirmada com a balança física.
const test = require('node:test');
const assert = require('node:assert/strict');
const { DRIVERS, getDriver, detectableDrivers } = require('../src/drivers');
const { splitFrames, parseLooseNumber } = require('../src/drivers/frames');
const simulator = require('../src/drivers/simulator');

test('todos os drivers seguem o mesmo formato', () => {
  for (const d of DRIVERS) {
    assert.equal(typeof d.id, 'string');
    assert.equal(typeof d.label, 'string');
    assert.equal(typeof d.parse, 'function');
    assert.ok(d.defaultSerial.baudRate > 0);
  }
  assert.deepEqual(
    DRIVERS.map((d) => d.id),
    ['toledo', 'filizola', 'urano', 'elgin', 'generic', 'simulator'],
  );
});

test('separa quadros por ETX/CR/LF e guarda o resto incompleto', () => {
  assert.deepEqual(splitFrames('\x0200650\x03\x0200'), { frames: ['\x0200650'], rest: '\x0200' });
});

test('Toledo (exemplo): STX 00650 ETX = 0,650 kg estável; IIIII = instável', () => {
  const toledo = getDriver('toledo');
  assert.equal(toledo.requestCmd, '\x05');
  assert.deepEqual(toledo.parse('\x0200650\x03').readings, [{ weightKg: 0.65, stable: true }]);
  assert.deepEqual(toledo.parse('\x02IIIII\x03').readings, [{ weightKg: null, stable: false }]);
  assert.deepEqual(toledo.parse('\x02SSSSS\x03').readings, []); // sobrecarga não vira peso
});

test('Filizola e Elgin usam o mesmo formato de 5 dígitos', () => {
  assert.equal(getDriver('filizola').defaultSerial.baudRate, 2400);
  assert.deepEqual(getDriver('elgin').parse('\x0201234\x03').readings, [{ weightKg: 1.234, stable: true }]);
});

test('Urano (exemplo): texto "  0,650 kg" respondendo ao ENQ', () => {
  const urano = getDriver('urano');
  assert.equal(urano.requestCmd, '\x05');
  assert.deepEqual(urano.parse('PESO:   0,650 kg\r\n').readings, [{ weightKg: 0.65, stable: undefined }]);
});

test('Genérica: aceita kg, g e a marca ST/US', () => {
  const generic = getDriver('generic');
  assert.equal(generic.requestCmd, null);
  assert.deepEqual(generic.parse('ST,GS,+0.650kg\r\n').readings, [{ weightKg: 0.65, stable: true }]);
  assert.deepEqual(generic.parse('US,GS,+0.648kg\r\n').readings, [{ weightKg: 0.648, stable: false }]);
  assert.deepEqual(generic.parse('650 g\n').readings, [{ weightKg: 0.65, stable: undefined }]);
});

test('número sem unidade: com decimal é kg, inteiro é grama', () => {
  assert.equal(parseLooseNumber('0,650').weightKg, 0.65);
  assert.equal(parseLooseNumber('650').weightKg, 0.65);
  assert.equal(parseLooseNumber('-0.020kg').weightKg, -0.02);
});

test('auto-detectar testa uma marca por família de protocolo e nunca o simulador', () => {
  assert.deepEqual(
    detectableDrivers().map((d) => d.id),
    ['toledo', 'urano', 'generic'],
  );
});

test('simulador: vazio, oscilando e depois 0,700 kg estável', () => {
  assert.deepEqual(simulator.simulatedReading(500), { weightKg: 0, stable: true });
  assert.equal(simulator.simulatedReading(2500).stable, false);
  assert.deepEqual(simulator.simulatedReading(5000), { weightKg: 0.7, stable: true });
});
