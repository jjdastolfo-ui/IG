// scraper.js v2.2
// Orquestador principal del scraping
// Coordina los 3 scrapers de fuentes uruguayas:
//   - INAC (NG/VG/VQ) - serie semanal oficial
//   - Plaza Rural (TE/VI/VP) - remates pantalla
//   - Pantalla Uruguay (TE/VI/VP) - remates pantalla
//
// CAMBIOS v2.2 (17/4/2026):
// - Soporta categoria VP (Vacas/Vaquillonas Preñadas)
// - Fechas alineadas en todos los scrapers via viernesReferenciaParaScrape()
//
// NOTA sobre pipeline de validacion:
//   Si existen los modulos en /modulos, se puede activar el pipeline cambiando
//   USAR_PIPELINE = true. Por defecto esta en false para compatibilidad con
//   deploys que aun no tienen la estructura nueva.

const { scrapePlazaRural } = require('./scraper-plazarural');
const { scrapePantallaUruguay } = require('./scraper-pantalla');
const { scrapeINAC } = require('./scraper-inac');

const USAR_PIPELINE = false; // cambiar a true una vez que modulos/ este subido

async function scrapeAll(db, calcularIGUFn) {
  console.log('━'.repeat(60));
  console.log(`IGU - Scraping (pipeline: ${USAR_PIPELINE ? 'ACTIVO' : 'OFF'})`);
  console.log('━'.repeat(60));
  const startTime = Date.now();

  let resultados;

  if (USAR_PIPELINE) {
    // Modo con pipeline de validacion (outlier detection + interpolacion + alertas)
    try {
      const { scrapearYValidar } = require('./modulos/pipeline-validacion');
      const resINAC = await scrapearYValidar(scrapeINAC, db, 'inac');
      const resPlaza = await scrapearYValidar(scrapePlazaRural, db, 'plaza_rural');
      const resPantalla = await scrapearYValidar(scrapePantallaUruguay, db, 'pantalla_uruguay');

      resultados = {
        total_scrapeados: resINAC.scrapeados + resPlaza.scrapeados + resPantalla.scrapeados,
        total_guardados: resINAC.guardados + resPlaza.guardados + resPantalla.guardados,
        por_fuente: { inac: resINAC, plaza_rural: resPlaza, pantalla_uruguay: resPantalla },
        duracion_ms: Date.now() - startTime,
        timestamp: new Date().toISOString(),
        detalles: [],
        pipeline: true
      };
    } catch (err) {
      console.warn('  Pipeline no disponible, usando modo legacy:', err.message);
      resultados = await scrapeLegacy(db, startTime);
    }
  } else {
    // Modo legacy: scraping paralelo + insert directo
    resultados = await scrapeLegacy(db, startTime);
  }

  console.log('━'.repeat(60));
  console.log('Resumen:');
  if (resultados.por_fuente) {
    console.log(`  INAC:              ${resultados.por_fuente.inac.scrapeados || resultados.por_fuente.inac.length || 0} registros`);
    console.log(`  Plaza Rural:       ${resultados.por_fuente.plaza_rural.scrapeados || resultados.por_fuente.plaza_rural.length || 0} registros`);
    console.log(`  Pantalla Uruguay:  ${resultados.por_fuente.pantalla_uruguay.scrapeados || resultados.por_fuente.pantalla_uruguay.length || 0} registros`);
  }
  console.log(`  TOTAL:             ${resultados.total_registros || resultados.total_guardados || 0}`);
  console.log(`  Duracion:          ${resultados.duracion_ms}ms`);
  console.log('━'.repeat(60));

  // Opcional: recalcular IGU
  if (calcularIGUFn && (resultados.total_registros > 0 || resultados.total_guardados > 0)) {
    try {
      const { ultimoViernesHabil } = require('./utils-fecha');
      const viernesRef = ultimoViernesHabil();
      const igu = calcularIGUFn(viernesRef);
      if (igu && igu.igu_general != null) {
        console.log(`  IGU recalculado ${viernesRef}: ${igu.igu_general.toFixed(4)}`);
        resultados.igu_calculado = igu.igu_general;
      }
    } catch (err) {
      console.error('  Error recalculando IGU:', err.message);
    }
  }

  return resultados;
}

/**
 * Modo legacy: scraping paralelo + insert directo en precios_raw.
 * No pasa por detector de outliers ni interpolacion.
 */
async function scrapeLegacy(db, startTime) {
  const [plazaResult, pantallaResult, inacResult] = await Promise.allSettled([
    scrapePlazaRural(db),
    scrapePantallaUruguay(db),
    scrapeINAC(db)
  ]);

  const porFuente = {
    plaza_rural: plazaResult.status === 'fulfilled' ? plazaResult.value : [],
    pantalla_uruguay: pantallaResult.status === 'fulfilled' ? pantallaResult.value : [],
    inac: inacResult.status === 'fulfilled' ? inacResult.value : []
  };

  const todos = [...porFuente.plaza_rural, ...porFuente.pantalla_uruguay, ...porFuente.inac];

  if (todos.length > 0) {
    guardarResultados(db, todos);
  }

  return {
    total_registros: todos.length,
    total_guardados: todos.length,
    por_fuente: porFuente,
    duracion_ms: Date.now() - startTime,
    timestamp: new Date().toISOString(),
    detalles: todos.map(r => ({
      fecha: r.fecha,
      categoria: r.categoria_codigo,
      fuente: r.fuente,
      precio: r.precio,
      volumen: r.volumen
    })),
    pipeline: false
  };
}

function guardarResultados(db, resultados) {
  // FIX duplicados: Borrar registros previos del mismo dia/categoria/fuente ANTES de insertar
  // Esto evita que cada scrape deje un registro nuevo aunque ya haya datos ese dia.
  const deleteDuplicados = db.prepare(`
    DELETE FROM precios_raw
    WHERE fecha = ? AND categoria_codigo = ? AND fuente = ?
  `);

  const insert = db.prepare(`
    INSERT INTO precios_raw
    (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((items) => {
    // Primero: limpiar todas las combinaciones (fecha, categoria, fuente) del batch
    const combinacionesUnicas = new Set();
    items.forEach(r => {
      const key = `${r.fecha}|${r.categoria_codigo}|${r.fuente}`;
      if (!combinacionesUnicas.has(key)) {
        deleteDuplicados.run(r.fecha, r.categoria_codigo, r.fuente);
        combinacionesUnicas.add(key);
      }
    });

    // Segundo: insertar los nuevos
    items.forEach(r => {
      insert.run(
        r.fecha, r.categoria_codigo, r.fuente, r.precio,
        r.unidad || 'USD/kg', r.volumen, r.observaciones
      );
    });
  });

  transaction(resultados);
  console.log(`✓ ${resultados.length} registros guardados (reemplazando duplicados)`);
}

module.exports = {
  scrapeAll,
  scrapePlazaRural,
  scrapePantallaUruguay,
  scrapeINAC
};
