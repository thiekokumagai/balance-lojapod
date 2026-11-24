'use strict';
// Filizola (linha PDV): ENQ → STX + 5 dígitos em gramas + ETX, costuma vir a 2400 baud. A confirmar com a balança física.
const { implicitGramsDriver, SERIAL_2400 } = require('./factories');

module.exports = implicitGramsDriver({ id: 'filizola', label: 'Filizola', defaultSerial: SERIAL_2400 });
