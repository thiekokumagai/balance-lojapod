'use strict';
const { SERIAL_9600 } = require('./factories');

/**
 * Simulador: não abre porta serial. O serviço chama `next(t)` e recebe um prato que é colocado,
 * oscila e estabiliza em 0,700 kg (bruto), depois é retirado. Serve para testar o PDV sem balança.
 */
const CYCLE_MS = 12000;

function simulatedReading(elapsedMs) {
  const t = elapsedMs % CYCLE_MS;
  if (t < 2000) return { weightKg: 0, stable: true }; // balança vazia
  if (t < 3500) {
    // prato chegando: peso oscilando
    const wobble = Math.sin(t / 60) * 0.04;
    return { weightKg: Math.round((0.7 + wobble) * 1000) / 1000, stable: false };
  }
  if (t < 10000) return { weightKg: 0.7, stable: true };
  return { weightKg: 0, stable: true }; // prato retirado
}

module.exports = {
  id: 'simulator',
  label: 'Simulador (teste sem balança)',
  defaultSerial: SERIAL_9600,
  requestCmd: null,
  requestIntervalMs: 0,
  isSimulator: true,
  simulatedReading,
  parse() {
    return { readings: [], rest: '' };
  },
};
