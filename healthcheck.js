// healthcheck.js v2 (rework contextual)
// Sistema de auditoria tecnica adaptado al ciclo SEMANAL del producto.
//
// FILOSOFIA:
//   El IGU se publica los lunes 9am UY. El resto de la semana no se actualizan
//   las fuentes ni se recalcula el indice. Por eso, alertar sobre "ultimo scrape
//   hace 80h" un domingo es un FALSO POSITIVO.
//
// MODOS:
//
//   1. ESTRUCTURAL (cada hora :15):
//      - Verifica integridad de la BD: ponderaciones, categorias, tablas.
//      - NO chequea frecuencia de scrapes ni recencia del indice.
//      - Solo manda email si hay error estructural CRITICO.
//
//   2. PUBLICACION (lunes 10:00 - 14:00 UY):
//      - Verifica que el cron del lunes 9am haya corrido.
//      - Verifica que se hayan scrapeado datos esa mañana.
//      - Verifica que el indice del viernes anterior este calculado.
//      - Verifica que la auditoria 09:15 se haya ejecutado.
//      - Manda email si algo del proceso del lunes fallo.
//
//   3. ANOMALIA (siempre que se detecte):
//      - Discrepancias de la auditoria de valores.
//      - Datos inconsistentes en la DB.
//      - Categoria sin precio base, etc.
//
// Uso:
//   const { ejecutarHealthcheck } = require('./healthcheck');
//   const resultado = ejecutarHealthcheck(db);  // detecta modo automaticamente
//   const resultado = ejecutarHealthcheck(db, { modo: 'publicacion' }); // forzar
//
// Devuelve:
//   { timestamp, modo, estado_general, alertas_criticas, alertas_warning,
//     checks_ok, resumen_ejecutivo, detalles, debe_enviar_email }

const VP_USD_CAB_MIN = 400;
const VP_USD_CAB_MAX = 2500;
const PESO_VP_KG = 420;

/**
 * Detecta automaticamente que modo de chequeo corresponde segun fecha/hora UY.
 *
 * Logica:
 *   - Si es lunes entre las 10:00 y las 14:00 UY -> modo 'publicacion'
 *   - Cualquier otro momento -> modo 'estructural'
 */
function detectarModo() {
  // Convertir a hora UY (UTC-3)
  const ahora = new Date();
  const offsetUY = -3;
  const fechaUY = new Date(ahora.getTime() + (offsetUY * 60 * 60 * 1000) - (ahora.getTimezoneOffset() * 60 * 1000));

  const dia = fechaUY.getUTCDay();   // 0=domingo, 1=lunes, ..., 5=viernes
  const hora = fechaUY.getUTCHours();

  // Lunes (1) entre 10:00 y 14:00 UY -> publicacion
  if (dia === 1 && hora >= 10 && hora < 14) {
    return 'publicacion';
  }
  return 'estructural';
}

function ejecutarHealthcheck(db, opciones = {}) {
  const modo = opciones.modo || detectarModo();

  const resultado = {
    timestamp: new Date().toISOString(),
    modo,
    estado_general: 'ok',
    alertas_criticas: [],
    alertas_warning: [],
    checks_ok: [],
    resumen_ejecutivo: '',
    detalles: {},
    debe_enviar_email: false
  };

  // ══════════════════════════════════════════════════════════
  // CHECKS ESTRUCTURALES (siempre se corren)
  // ══════════════════════════════════════════════════════════
  ejecutarChecksEstructurales(db, resultado);

  // ══════════════════════════════════════════════════════════
  // CHECKS DE PUBLICACION (solo modo publicacion)
  // ══════════════════════════════════════════════════════════
  if (modo === 'publicacion') {
    ejecutarChecksPublicacion(db, resultado);
  }

  // ══════════════════════════════════════════════════════════
  // CHECKS DE ANOMALIAS DE DATOS (siempre)
  // ══════════════════════════════════════════════════════════
  ejecutarChecksAnomaliasDatos(db, resultado);

  // ══════════════════════════════════════════════════════════
  // DETERMINAR ESTADO GENERAL
  // ══════════════════════════════════════════════════════════
  if (resultado.alertas_criticas.length > 0) {
    resultado.estado_general = 'critical';
  } else if (resultado.alertas_warning.length > 0) {
    resultado.estado_general = 'warning';
  } else {
    resultado.estado_general = 'ok';
  }

  // ══════════════════════════════════════════════════════════
  // DECIDIR SI MANDAR EMAIL
  // ══════════════════════════════════════════════════════════
  if (modo === 'publicacion') {
    // En modo publicacion: avisar siempre que haya algo
    resultado.debe_enviar_email = resultado.estado_general !== 'ok';
  } else {
    // Modo estructural: solo si hay alertas CRITICAS
    resultado.debe_enviar_email = resultado.alertas_criticas.length > 0;
  }

  // ══════════════════════════════════════════════════════════
  // RESUMEN
  // ══════════════════════════════════════════════════════════
  const emoji = { ok: '✅', warning: '⚠️', critical: '🔴' };
  resultado.resumen_ejecutivo = `${emoji[resultado.estado_general]} Estado: ${resultado.estado_general.toUpperCase()} ` +
    `(modo: ${modo}) | ` +
    `${resultado.checks_ok.length} OK | ` +
    `${resultado.alertas_warning.length} warnings | ` +
    `${resultado.alertas_criticas.length} criticas`;

  return resultado;
}

// ============================================================================
// CHECKS ESTRUCTURALES
// Verifican integridad de la BD que es independiente del ciclo semanal.
// ============================================================================

function ejecutarChecksEstructurales(db, resultado) {
  // 1. Ponderaciones suman 1.0
  try {
    const suma = db.prepare(`
      SELECT ROUND(SUM(ponderacion), 4) AS s FROM categorias WHERE activo = 1
    `).get();

    resultado.detalles.suma_ponderaciones = suma.s;

    if (Math.abs(suma.s - 1.0) > 0.001) {
      resultado.alertas_criticas.push({
        check: 'ponderaciones',
        mensaje: `Ponderaciones suman ${suma.s}, deberian sumar 1.0. Sistema con error estructural.`
      });
    } else {
      resultado.checks_ok.push('Ponderaciones suman 1.0 ✓');
    }
  } catch (err) {
    resultado.alertas_criticas.push({ check: 'ponderaciones', mensaje: `Error: ${err.message}` });
  }

  // 2. 6 categorias activas esperadas
  try {
    const categorias = db.prepare(`
      SELECT codigo FROM categorias WHERE activo = 1 ORDER BY codigo
    `).all().map(r => r.codigo);

    const esperadas = ['NG', 'TE', 'VG', 'VI', 'VP', 'VQ'];
    const faltantes = esperadas.filter(c => !categorias.includes(c));

    resultado.detalles.categorias_activas = categorias;

    if (faltantes.length > 0) {
      resultado.alertas_criticas.push({
        check: 'categorias',
        mensaje: `Faltan categorias: ${faltantes.join(', ')}`
      });
    } else {
      resultado.checks_ok.push(`6 categorias correctas: ${categorias.join(', ')}`);
    }
  } catch (err) {
    resultado.alertas_criticas.push({ check: 'categorias', mensaje: `Error: ${err.message}` });
  }

  // 3. Cada categoria tiene precio base
  try {
    const sinBase = db.prepare(`
      SELECT c.codigo FROM categorias c
      LEFT JOIN base_index b ON c.codigo = b.categoria_codigo
      WHERE c.activo = 1 AND b.precio_base IS NULL
    `).all();

    if (sinBase.length > 0) {
      resultado.alertas_criticas.push({
        check: 'precios_base',
        mensaje: `Categorias sin precio base: ${sinBase.map(c => c.codigo).join(', ')}`
      });
    } else {
      resultado.checks_ok.push('Todas las categorias tienen precio base');
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'precios_base', mensaje: `Error: ${err.message}` });
  }

  // 4. Tablas core existen
  try {
    const tablasEsperadas = ['categorias', 'precios_raw', 'indice', 'base_index', 'precios_promedio_diario'];
    const tablasReales = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
    const faltantes = tablasEsperadas.filter(t => !tablasReales.includes(t));

    if (faltantes.length > 0) {
      resultado.alertas_criticas.push({
        check: 'tablas_db',
        mensaje: `Tablas faltantes: ${faltantes.join(', ')}`
      });
    } else {
      resultado.checks_ok.push('Todas las tablas core existen');
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'tablas_db', mensaje: `Error: ${err.message}` });
  }
}

// ============================================================================
// CHECKS DE PUBLICACION (solo lunes 10am-2pm UY)
// Verifican que el ciclo semanal del lunes se haya completado.
// ============================================================================

function ejecutarChecksPublicacion(db, resultado) {
  // 1. Indice del viernes anterior calculado
  try {
    const viernesAnt = obtenerViernesAnterior();
    const indiceViernes = db.prepare(`
      SELECT fecha, igu_general, metodologia_version, calculado_at
      FROM indice WHERE fecha = ?
    `).get(viernesAnt);

    resultado.detalles.viernes_esperado = viernesAnt;

    if (!indiceViernes) {
      resultado.alertas_criticas.push({
        check: 'indice_viernes',
        mensaje: `No hay indice calculado del viernes ${viernesAnt}. El cron del lunes 9am pudo haber fallado.`
      });
    } else {
      resultado.detalles.igu_viernes = indiceViernes.igu_general;
      resultado.detalles.calculado_at = indiceViernes.calculado_at;

      // Verificar que el calculo sea reciente (de esta mañana)
      const calculadoFecha = new Date(indiceViernes.calculado_at);
      const horasDesdeCalc = (Date.now() - calculadoFecha.getTime()) / (1000 * 60 * 60);

      if (horasDesdeCalc > 24) {
        resultado.alertas_warning.push({
          check: 'indice_reciente',
          mensaje: `Indice ${viernesAnt} fue calculado hace ${horasDesdeCalc.toFixed(0)}h, no esta mañana. Cron del lunes pudo no haber recalculado.`
        });
      } else {
        resultado.checks_ok.push(`Indice ${viernesAnt}: ${indiceViernes.igu_general.toFixed(4)} (calculado esta mañana)`);
      }
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'indice_viernes', mensaje: `Error: ${err.message}` });
  }

  // 2. Scrape de hoy ejecutado (deberia haber registros nuevos en las ultimas horas)
  try {
    const ultimoScrape = db.prepare(`
      SELECT MAX(created_at) AS ultimo FROM precios_raw
    `).get();

    if (!ultimoScrape?.ultimo) {
      resultado.alertas_criticas.push({
        check: 'scrape_lunes',
        mensaje: 'No hay ningun registro en precios_raw'
      });
    } else {
      const fechaUltimo = new Date(ultimoScrape.ultimo);
      const horas = (Date.now() - fechaUltimo.getTime()) / (1000 * 60 * 60);
      resultado.detalles.horas_desde_scrape = parseFloat(horas.toFixed(1));

      if (horas > 24) {
        resultado.alertas_criticas.push({
          check: 'scrape_lunes',
          mensaje: `Ultimo scrape hace ${horas.toFixed(1)}h. El cron del lunes 9am pudo haber fallado.`
        });
      } else {
        resultado.checks_ok.push(`Scrape reciente: hace ${horas.toFixed(1)}h`);
      }
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'scrape_lunes', mensaje: `Error: ${err.message}` });
  }

  // 3. Auditoria 09:15 ejecutada (si la tabla existe)
  try {
    const ultimaAuditoria = db.prepare(`
      SELECT MAX(fecha_auditoria) AS ultima
      FROM auditoria_valores
    `).get();

    if (ultimaAuditoria?.ultima) {
      const fecha = new Date(ultimaAuditoria.ultima);
      const horas = (Date.now() - fecha.getTime()) / (1000 * 60 * 60);

      if (horas > 4) {
        resultado.alertas_warning.push({
          check: 'auditoria_lunes',
          mensaje: `Ultima auditoria de valores hace ${horas.toFixed(1)}h, no esta mañana.`
        });
      } else {
        resultado.checks_ok.push(`Auditoria 09:15 ejecutada hace ${horas.toFixed(1)}h`);
      }
    }
    // Si no hay tabla auditoria, no es un problema critico
  } catch (err) {
    // Tabla puede no existir, ignorar silenciosamente
  }
}

// ============================================================================
// CHECKS DE ANOMALIAS (siempre)
// Detectan datos inconsistentes que NO dependen de la frecuencia del scraping.
// ============================================================================

function ejecutarChecksAnomaliasDatos(db, resultado) {
  // 1. VP en rango razonable (USD/cab 400-2500)
  try {
    const vpRegistros = db.prepare(`
      SELECT precio FROM precios_raw
      WHERE categoria_codigo = 'VP'
      ORDER BY created_at DESC LIMIT 5
    `).all();

    if (vpRegistros.length > 0) {
      const fueraDeRango = vpRegistros.filter(r => {
        const usdCab = r.precio * PESO_VP_KG;
        return usdCab < VP_USD_CAB_MIN || usdCab > VP_USD_CAB_MAX;
      });

      if (fueraDeRango.length > 0) {
        resultado.alertas_criticas.push({
          check: 'vp_rango',
          mensaje: `${fueraDeRango.length} registros VP fuera de rango. Posible bug de parseo.`
        });
      } else {
        const promedio = vpRegistros.reduce((s, r) => s + r.precio, 0) / vpRegistros.length;
        resultado.detalles.vp_precio_promedio = parseFloat(promedio.toFixed(4));
        resultado.detalles.vp_usd_cab = parseFloat((promedio * PESO_VP_KG).toFixed(0));
      }
    }
  } catch (err) {
    // No critico
  }

  // 2. Duplicados en precios_raw
  try {
    const duplicados = db.prepare(`
      SELECT COUNT(*) AS n FROM (
        SELECT fecha, categoria_codigo, fuente
        FROM precios_raw
        GROUP BY fecha, categoria_codigo, fuente
        HAVING COUNT(*) > 1
      )
    `).get();

    if (duplicados.n > 0) {
      resultado.alertas_warning.push({
        check: 'duplicados',
        mensaje: `${duplicados.n} combinaciones duplicadas. Correr /admin/limpiar-duplicados.`
      });
    }
  } catch (err) {
    // No critico
  }
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Devuelve el viernes anterior (o el mismo si hoy es viernes).
 */
function obtenerViernesAnterior() {
  const hoy = new Date();
  const diasAtras = (hoy.getDay() + 2) % 7;
  const viernes = new Date(hoy);
  viernes.setDate(viernes.getDate() - diasAtras);
  return viernes.toISOString().split('T')[0];
}

module.exports = { ejecutarHealthcheck, detectarModo };
