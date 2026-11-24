'use strict';
// Toledo (protocolo de PDV tipo Prix): ENQ → STX + 5 dígitos em gramas + ETX. A confirmar com a balança física.
const { implicitGramsDriver, SERIAL_9600 } = require('./factories');

module.exports = implicitGramsDriver({ id: 'toledo', label: 'Toledo', defaultSerial: SERIAL_9600 });
