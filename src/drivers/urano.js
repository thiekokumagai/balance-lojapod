'use strict';
// Urano (linha PDV): responde ao ENQ com o peso em texto (ex.: "  0,650 kg"). A confirmar com a balança física.
const { ENQ } = require('./frames');
const { textDriver, SERIAL_9600 } = require('./factories');

module.exports = textDriver({ id: 'urano', label: 'Urano', defaultSerial: SERIAL_9600, requestCmd: ENQ });
