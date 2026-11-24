'use strict';

/**
 * Acesso à porta serial (USB/COM) via `serialport`. Separado do serviço para os testes usarem portas falsas.
 */
const { SerialPort } = require('serialport');

function openPort(path, options) {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, ...options, autoOpen: false });
    port.open((err) => (err ? reject(err) : resolve(port)));
  });
}

async function listPorts() {
  const ports = await SerialPort.list();
  return ports.map((p) => ({ path: p.path, manufacturer: p.manufacturer, friendlyName: p.friendlyName }));
}

module.exports = { openPort, listPorts };
