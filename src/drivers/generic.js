'use strict';
// Genérica: balanças que mandam o peso sozinhas em texto (ex.: "ST,GS,+0.650kg"). Aceita kg ou g.
const { textDriver, SERIAL_9600 } = require('./factories');

module.exports = textDriver({ id: 'generic', label: 'Genérica (envia o peso sozinha)', defaultSerial: SERIAL_9600 });
