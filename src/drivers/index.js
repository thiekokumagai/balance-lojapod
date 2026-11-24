'use strict';

/**
 * Registro dos drivers. Para atender uma marca nova: crie `drivers/<marca>.js` no mesmo formato
 * (ver factories.js) e acrescente aqui.
 */
const DRIVERS = [
  require('./toledo'),
  require('./filizola'),
  require('./urano'),
  require('./elgin'),
  require('./generic'),
  require('./simulator'),
];

function getDriver(id) {
  return DRIVERS.find((d) => d.id === id) || null;
}

/**
 * Drivers testados no auto-detectar: um por família de protocolo (Toledo, Filizola e Elgin falam igual)
 * e nunca o simulador.
 */
function detectableDrivers() {
  const seen = new Set();
  return DRIVERS.filter((d) => {
    if (d.isSimulator || seen.has(d.family)) return false;
    seen.add(d.family);
    return true;
  });
}

module.exports = { DRIVERS, getDriver, detectableDrivers };
