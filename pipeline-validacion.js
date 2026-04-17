// pipeline-validacion.js
// IGU - Orquestador del pipeline de validación de datos
//
// Este módulo toma los datos crudos de los scrapers y aplica:
// 1. Detección de outliers
// 2. Interpolación si corresponde
// 3. Alertas por email
// 4. Guardado final en DB con flags de transparencia
//
// Uso desde server.js:
//   const { procesarDatos } = require('./modulos/pipeline-validacion');
//   const datosRaw = await scrapePlazaRural(db);
//   const datosValidados = await procesarDatos(datosRaw, db);

const { analizarOutlier } = require('./outlier-detector');
const { aplicarInterpolacion } = require('./interpolator');
const { alertar } = require('./alertas');

/**
 * Procesa un array de datos crudos del scraper.
 * Aplica validación outlier → interpolación → alerta → guardado.
 *
 * @param {Array} datosRaw - Datos del scraper
 * @param {Database} db
 * @returns {Promise<Array>} Datos procesados listos para insertar en DB
 */
async function procesarDatos(datosRaw, db) {
  if (!datosRaw || datosRaw.length === 0) return [];

  console.log(`\n🔍 Procesando ${datosRaw.length} datos crudos...`);

  const procesados = [];
  const alertasPendientes = [];

  for (const dato of datosRaw) {
    const analisis = analizarOutlier(dato, db);

    console.log(`  [${dato.categoria_codigo}/${dato.fuente}] ${analisis.decision}: ${analisis.motivo}`);

    // CASO 1: Aceptar directo (INAC o dentro de rango)
    if (analisis.decision === 'ACEPTAR') {
      procesados.push({
        ...dato,
        es_outlier: 0,
        es_interpolado: 0,
        razon_descarte: null
      });
      continue;
    }

    // CASO 2: Aceptar con flag (alta volatilidad con volumen normal)
    if (analisis.decision === 'ACEPTAR_CON_FLAG') {
      procesados.push({
        ...dato,
        es_outlier: 0,
        es_interpolado: 0,
        razon_descarte: `Alta volatilidad aceptada: ${analisis.detalle}`
      });

      // Alerta de alta volatilidad
      alertasPendientes.push({
        tipo: 'alta_volatilidad',
        data: {
          categoria: dato.categoria_codigo,
          variacion: analisis.variacion_pct,
          sigma: analisis.desvios_sigma,
          volumen: dato.volumen,
          volumen_relativo: analisis.volumen_relativo
        }
      });
      continue;
    }

    // CASO 3: OUTLIER → intentar interpolar
    if (analisis.decision === 'OUTLIER') {
      const datoInterpolado = aplicarInterpolacion(dato, db);

      if (datoInterpolado) {
        // Interpolación exitosa
        procesados.push(datoInterpolado);

        alertasPendientes.push({
          tipo: 'interpolacion_aplicada',
          data: {
            categoria: dato.categoria_codigo,
            precio_original: dato.precio,
            precio_interpolado: datoInterpolado.precio,
            categoria_ref: datoInterpolado.interpolado_desde,
            detalle: datoInterpolado.razon_descarte
          }
        });
      } else {
        // Interpolación falló: marcar como outlier sin reemplazo
        procesados.push({
          ...dato,
          es_outlier: 1,
          es_interpolado: 0,
          razon_descarte: `OUTLIER sin interpolación posible. ${analisis.detalle}`
        });

        alertasPendientes.push({
          tipo: 'outlier_detectado',
          data: {
            categoria: dato.categoria_codigo,
            fecha: dato.fecha,
            precio: dato.precio,
            unidad: dato.unidad,
            variacion: analisis.variacion_pct,
            sigma: analisis.desvios_sigma,
            volumen: dato.volumen,
            volumen_relativo: analisis.volumen_relativo,
            accion: 'Descartado, sin reemplazo (revisar manualmente)',
            interpolado: false
          }
        });
      }
    }
  }

  // Enviar alertas acumuladas
  for (const a of alertasPendientes) {
    try {
      await alertar(a.tipo, a.data, db);
    } catch (err) {
      console.error(`  ⚠ Error enviando alerta ${a.tipo}:`, err.message);
    }
  }

  console.log(`✓ Procesados: ${procesados.length} (${alertasPendientes.length} alertas enviadas)\n`);
  return procesados;
}

/**
 * Guarda los datos procesados en la tabla precios_raw.
 * Incluye los flags de outlier / interpolado para transparencia.
 */
function guardarEnDB(datos, db) {
  if (!datos || datos.length === 0) return 0;

  const stmt = db.prepare(`
    INSERT INTO precios_raw (
      fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones,
      es_outlier, es_interpolado, interpolado_desde, razon_descarte, precio_original
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertar = db.transaction((items) => {
    let n = 0;
    for (const d of items) {
      try {
        stmt.run(
          d.fecha,
          d.categoria_codigo,
          d.fuente,
          d.precio,
          d.unidad,
          d.volumen,
          d.observaciones || '',
          d.es_outlier || 0,
          d.es_interpolado || 0,
          d.interpolado_desde || null,
          d.razon_descarte || null,
          d.precio_original || null
        );
        n++;
      } catch (err) {
        console.error(`  ✗ Error guardando ${d.categoria_codigo}/${d.fuente}:`, err.message);
      }
    }
    return n;
  });

  const guardados = insertar(datos);
  console.log(`  💾 ${guardados} registros guardados en precios_raw`);
  return guardados;
}

/**
 * Wrapper: scraper → pipeline → guardar
 */
async function scrapearYValidar(scraperFn, db, nombreFuente) {
  console.log(`\n════════════════════════════════════════`);
  console.log(`  ${nombreFuente.toUpperCase()}`);
  console.log(`════════════════════════════════════════`);

  let datosRaw;
  try {
    datosRaw = await scraperFn(db);
  } catch (err) {
    console.error(`  ✗ Error en scraper ${nombreFuente}:`, err.message);
    await alertar('scraper_fallido', {
      fuente: nombreFuente,
      error: err.message,
      fecha: new Date().toISOString()
    }, db);
    return { scrapeados: 0, procesados: 0, guardados: 0 };
  }

  if (!datosRaw || datosRaw.length === 0) {
    console.warn(`  ⚠ ${nombreFuente}: 0 datos obtenidos`);
    await alertar('scraper_fallido', {
      fuente: nombreFuente,
      error: 'Scraper ejecutó pero no devolvió datos (posible cambio de estructura)',
      fecha: new Date().toISOString()
    }, db);
    return { scrapeados: 0, procesados: 0, guardados: 0 };
  }

  const procesados = await procesarDatos(datosRaw, db);
  const guardados = guardarEnDB(procesados, db);

  return {
    scrapeados: datosRaw.length,
    procesados: procesados.length,
    guardados
  };
}

module.exports = {
  procesarDatos,
  guardarEnDB,
  scrapearYValidar
};
