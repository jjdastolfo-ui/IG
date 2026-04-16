// scraper.js
// Orquestador principal del scraping
// Coordina los 3 scrapers de fuentes uruguayas confiables:
//   - Plaza Rural (remates por pantalla)
//   - Pantalla Uruguay (remates por pantalla)
//   - INAC (Instituto Nacional de Carnes - precios semanales oficiales)

const { scrapePlazaRural } = require('./scraper-plazarural');
const { scrapePantallaUruguay } = require('./scraper-pantalla');
const { scrapeINAC } = require('./scraper-inac');

/**
 * Ejecuta todos los scrapers en paralelo y guarda los resultados en la BD
 * @param {Database} db - Instancia de SQLite
 * @returns {Object} Resumen de la ejecución
 */
async function scrapeAll(db) {
  console.log('━'.repeat(60));
  console.log('IGU - Scraping de fuentes ganaderas uruguayas');
  console.log('━'.repeat(60));
  const startTime = Date.now();

  // Ejecutar en paralelo con Promise.allSettled
  // Si una fuente falla, las otras siguen funcionando
  const [plazaResult, pantallaResult, inacResult] = await Promise.allSettled([
    scrapePlazaRural(db),
    scrapePantallaUruguay(db),
    scrapeINAC(db)
  ]);

  const resultados = {
    plaza_rural: plazaResult.status === 'fulfilled' ? plazaResult.value : [],
    pantalla_uruguay: pantallaResult.status === 'fulfilled' ? pantallaResult.value : [],
    inac: inacResult.status === 'fulfilled' ? inacResult.value : []
  };

  // Combinar todos los resultados
  const todos = [
    ...resultados.plaza_rural,
    ...resultados.pantalla_uruguay,
    ...resultados.inac
  ];

  // Guardar en BD (todos los registros en una transacción)
  if (todos.length > 0) {
    guardarResultados(db, todos);
  }

  const resumen = {
    total_registros: todos.length,
    por_fuente: {
      plaza_rural: resultados.plaza_rural.length,
      pantalla_uruguay: resultados.pantalla_uruguay.length,
      inac: resultados.inac.length
    },
    duracion_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    detalles: todos.map(r => ({
      fecha: r.fecha,
      categoria: r.categoria_codigo,
      fuente: r.fuente,
      precio: r.precio,
      volumen: r.volumen
    }))
  };

  console.log('━'.repeat(60));
  console.log(`Resumen del scraping:`);
  console.log(`  Plaza Rural:       ${resumen.por_fuente.plaza_rural} registros`);
  console.log(`  Pantalla Uruguay:  ${resumen.por_fuente.pantalla_uruguay} registros`);
  console.log(`  INAC:              ${resumen.por_fuente.inac} registros`);
  console.log(`  TOTAL:             ${todos.length} registros`);
  console.log(`  Duración:          ${resumen.duracion_ms}ms`);
  console.log('━'.repeat(60));

  return resumen;
}

function guardarResultados(db, resultados) {
  const insert = db.prepare(`
    INSERT INTO precios_raw
    (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((items) => {
    items.forEach(r => {
      insert.run(
        r.fecha,
        r.categoria_codigo,
        r.fuente,
        r.precio,
        r.unidad || 'USD/kg',
        r.volumen,
        r.observaciones
      );
    });
  });

  transaction(resultados);
  console.log(`✓ ${resultados.length} registros guardados en la BD`);
}

module.exports = {
  scrapeAll,
  scrapePlazaRural,
  scrapePantallaUruguay,
  scrapeINAC
};
