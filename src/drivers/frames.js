'use strict';

/**
 * Utilitários comuns dos drivers. Cada driver recebe o texto acumulado da porta serial
 * (latin1) e devolve as leituras completas + o resto ainda incompleto.
 */

const STX = '\x02';
const ETX = '\x03';
const ENQ = '\x05';

/**
 * Separa o buffer em quadros pelos delimitadores (ETX, CR ou LF).
 * Devolve os quadros completos e o que sobrou (quadro ainda chegando).
 */
function splitFrames(text, delimiters = [ETX, '\r', '\n']) {
  const frames = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (delimiters.includes(text[i])) {
      const frame = text.slice(start, i);
      if (frame.length > 0) frames.push(frame);
      start = i + 1;
    }
  }
  return { frames, rest: text.slice(start) };
}

/** Tira caracteres de controle (STX, ETX etc.) das pontas. */
function stripControl(frame) {
  // eslint-disable-next-line no-control-regex
  return frame.replace(/[\x00-\x1f\x7f]/g, '').trim();
}

/** Arredonda para 3 casas (gramas). */
function round3(value) {
  return Math.round(value * 1000) / 1000;
}

/**
 * Quadro numérico de 5 ou 6 dígitos com 3 casas decimais implícitas (gramas), comum em Toledo/Filizola/Elgin.
 * Ex.: "00650" → 0,650 kg. Letras repetidas indicam estado: I = instável, S = sobrecarga, N = negativo.
 */
function parseImplicitGrams(frame) {
  const clean = stripControl(frame);
  if (/^I{4,6}$/i.test(clean)) return { kind: 'unstable' };
  if (/^S{4,6}$/i.test(clean)) return { kind: 'overload' };
  if (/^N{4,6}$/i.test(clean)) return { kind: 'negative' };
  const m = clean.match(/^(\d{5,6})$/);
  if (!m) return null;
  return { kind: 'weight', weightKg: round3(Number(m[1]) / 1000) };
}

/**
 * Número com ou sem unidade em qualquer texto ("ST,GS,+0.650kg", "PESO: 650 g", "0,650").
 * Sem unidade: com separador decimal é kg; inteiro é grama.
 */
function parseLooseNumber(frame) {
  const clean = stripControl(frame);
  const m = clean.match(/([+-]?)\s*(\d+(?:[.,]\d+)?)\s*(kg|g)?\b/i);
  if (!m) return null;
  const sign = m[1] === '-' ? -1 : 1;
  const raw = m[2].replace(',', '.');
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const unit = (m[3] || '').toLowerCase();
  let kg;
  if (unit === 'kg') kg = value;
  else if (unit === 'g') kg = value / 1000;
  else kg = raw.includes('.') ? value : value / 1000;
  return { weightKg: round3(sign * kg) };
}

/** Marcas de estabilidade usadas por muitas balanças (ST = estável, US = instável). */
function stabilityMarker(frame) {
  const upper = frame.toUpperCase();
  if (/\bUS\b|UNSTABLE|INSTAVEL|INSTÁVEL/.test(upper)) return false;
  if (/\bST\b|STABLE|ESTAVEL|ESTÁVEL/.test(upper)) return true;
  return undefined;
}

module.exports = {
  STX,
  ETX,
  ENQ,
  splitFrames,
  stripControl,
  round3,
  parseImplicitGrams,
  parseLooseNumber,
  stabilityMarker,
};
