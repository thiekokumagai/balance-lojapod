'use strict';

const { ENQ, splitFrames, parseImplicitGrams, parseLooseNumber, stabilityMarker } = require('./frames');

/**
 * Formatos de driver reaproveitados pelas marcas. Todo driver segue:
 *   { id, label, defaultSerial, requestCmd, requestIntervalMs, parse(text) → { readings, rest } }
 * `readings`: [{ weightKg, stable }]. `stable` indefinido = o serviço decide pela repetição do peso.
 */

const SERIAL_9600 = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1 };
const SERIAL_2400 = { baudRate: 2400, dataBits: 8, parity: 'none', stopBits: 1 };

/** Pedido ENQ e resposta com 5 ou 6 dígitos em gramas; "IIIII" = instável. */
function implicitGramsDriver({ id, label, defaultSerial }) {
  return {
    id,
    label,
    // Mesmo protocolo em várias marcas: o auto-detectar testa a família uma vez só
    family: 'implicit-grams',
    defaultSerial,
    requestCmd: ENQ,
    requestIntervalMs: 200,
    parse(text) {
      const { frames, rest } = splitFrames(text);
      const readings = [];
      for (const frame of frames) {
        const r = parseImplicitGrams(frame);
        if (!r) continue;
        if (r.kind === 'unstable') readings.push({ weightKg: null, stable: false });
        else if (r.kind === 'weight') readings.push({ weightKg: r.weightKg, stable: true });
        // Sobrecarga e negativo não geram leitura
      }
      return { readings, rest };
    },
  };
}

/** Texto livre: número com kg ou g; estabilidade por "ST"/"US" ou pela repetição. */
function textDriver({ id, label, defaultSerial, requestCmd = null }) {
  return {
    id,
    label,
    family: requestCmd ? 'text-request' : 'text',
    defaultSerial,
    requestCmd,
    requestIntervalMs: requestCmd ? 200 : 0,
    parse(text) {
      const { frames, rest } = splitFrames(text);
      const readings = [];
      for (const frame of frames) {
        const r = parseLooseNumber(frame);
        if (!r) continue;
        readings.push({ weightKg: r.weightKg, stable: stabilityMarker(frame) });
      }
      return { readings, rest };
    },
  };
}

module.exports = { SERIAL_9600, SERIAL_2400, implicitGramsDriver, textDriver };
