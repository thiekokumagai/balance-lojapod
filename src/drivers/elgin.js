'use strict';
// Elgin (linha DP): costuma emular o protocolo Toledo (ENQ → 5 dígitos em gramas). A confirmar com a balança física.
const { implicitGramsDriver, SERIAL_9600 } = require('./factories');

module.exports = implicitGramsDriver({ id: 'elgin', label: 'Elgin', defaultSerial: SERIAL_9600 });
