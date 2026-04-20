// healthcheck.js
// Sistema de auditoria tecnica automatica del IGU
//
// Uso:
//   const { ejecutarHealthcheck } = require('./healthcheck');
//   const resultado = ejecutarHealthcheck(db);
//
// Devuelve:
//   {
//     timestamp: ISO,
//     estado_general: 'ok' | 'warning' | 'critical',
//     alertas_criticas: [...],
//     alertas_warning: [...],
//     checks_ok: [...],
//     resumen_ejecutivo: string
//   }

const UMBRAL_HORAS_SIN_SCRAPE = 48;
const UMBRAL_VARIACION_SEMANAL_ALERTA = 5.0; // porcentaje
const VP_USD_CAB_MIN = 400;
const VP_USD_CAB_MAX = 2500;
const PESO_VP_KG = 420;

function ejecutarHealthcheck(db) {
  const resultado = {
    timestamp: new Date().toISOString(),
    estado_general: 'ok',
    alertas_criticas: [],
    alertas_warning: [],
    checks_ok: [],
    resumen_ejecutivo: '',
    detalles: {}
  };

  // ══════════════════════════════════════════════════════════
  // CHECK 1: Ultimo scrape
  // ══════════════════════════════════════════════════════════
  try {
    const ultimoScrape = db.prepare(`
      SELECT MAX(created_at) AS ultimo FROM precios_raw
    `).get();

    if (!ultimoScrape || !ultimoScrape.ultimo) {
      resultado.alertas_criticas.push({
        check: 'ultimo_scrape',
        mensaje: 'No hay ningun registro en precios_raw. Sistema sin datos.'
      });
    } else {
      const fechaUltimo = new Date(ultimoScrape.ultimo);
      const horasDesde = (Date.now() - fechaUltimo.getTime()) / (1000 * 60 * 60);
      resultado.detalles.horas_desde_ultimo_scrape = parseFloat(horasDesde.toFixed(1));

      if (horasDesde > UMBRAL_HORAS_SIN_SCRAPE) {
        resultado.alertas_criticas.push({
          check: 'ultimo_scrape',
          mensaje: `Ultimo scrape hace ${horasDesde.toFixed(1)} horas (>${UMBRAL_HORAS_SIN_SCRAPE}h umbral). Scrapers rotos?`
        });
      } else {
        resultado.checks_ok.push(`Ultimo scrape hace ${horasDesde.toFixed(1)}h`);
      }
    }
  } catch (err) {
    resultado.alertas_criticas.push({ check: 'ultimo_scrape', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 2: Cron semanal (indice del ultimo viernes)
  // ══════════════════════════════════════════════════════════
  try {
    const hoy = new Date();
    const diasAlUltimoViernes = (hoy.getDay() + 2) % 7;
    const ultimoViernes = new Date(hoy);
    ultimoViernes.setDate(ultimoViernes.getDate() - diasAlUltimoViernes);
    const ultimoViernesStr = ultimoViernes.toISOString().split('T')[0];

    const indiceUltimoViernes = db.prepare(`
      SELECT fecha, igu_general, metodologia_version
      FROM indice
      WHERE fecha = ?
    `).get(ultimoViernesStr);

    resultado.detalles.ultimo_viernes_esperado = ultimoViernesStr;

    if (!indiceUltimoViernes) {
      // Solo es critico si ya paso el lunes 9am
      const esLunesODespues = hoy.getDay() === 1 ? (hoy.getHours() >= 10) : (hoy.getDay() > 1 || hoy.getDay() === 0);
      if (esLunesODespues) {
        resultado.alertas_criticas.push({
          check: 'cron_semanal',
          mensaje: `No hay indice calculado del viernes ${ultimoViernesStr}. Cron lunes 9am pudo haber fallado.`
        });
      } else {
        resultado.checks_ok.push('Cron semanal: aun no corresponde ejecutarse');
      }
    } else {
      resultado.detalles.igu_ultimo_viernes = indiceUltimoViernes.igu_general;
      resultado.detalles.metodologia_version = indiceUltimoViernes.metodologia_version;

      if (indiceUltimoViernes.metodologia_version !== '2.2') {
        resultado.alertas_warning.push({
          check: 'metodologia_version',
          mensaje: `Indice ${ultimoViernesStr} calculado con v${indiceUltimoViernes.metodologia_version} en lugar de 2.2. Recalcular.`
        });
      } else {
        resultado.checks_ok.push(`Indice ${ultimoViernesStr}: ${indiceUltimoViernes.igu_general.toFixed(4)} (v2.2)`);
      }
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'cron_semanal', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 3: Ponderaciones = 1.0
  // ══════════════════════════════════════════════════════════
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

  // ══════════════════════════════════════════════════════════
  // CHECK 4: 6 categorias activas esperadas
  // ══════════════════════════════════════════════════════════
  try {
    const categorias = db.prepare(`
      SELECT codigo FROM categorias WHERE activo = 1 ORDER BY codigo
    `).all().map(r => r.codigo);

    const esperadas = ['NG', 'TE', 'VG', 'VI', 'VP', 'VQ'];
    const faltantes = esperadas.filter(c => !categorias.includes(c));
    const extras = categorias.filter(c => !esperadas.includes(c));

    resultado.detalles.categorias_activas = categorias;

    if (faltantes.length > 0) {
      resultado.alertas_criticas.push({
        check: 'categorias',
        mensaje: `Faltan categorias: ${faltantes.join(', ')}`
      });
    }
    if (extras.length > 0) {
      resultado.alertas_warning.push({
        check: 'categorias_extras',
        mensaje: `Categorias inesperadas: ${extras.join(', ')}`
      });
    }
    if (faltantes.length === 0 && extras.length === 0) {
      resultado.checks_ok.push(`6 categorias correctas: ${categorias.join(', ')}`);
    }
  } catch (err) {
    resultado.alertas_criticas.push({ check: 'categorias', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 5: Datos por categoria en los ultimos 14 dias
  // ══════════════════════════════════════════════════════════
  try {
    const hace14 = new Date();
    hace14.setDate(hace14.getDate() - 14);
    const hace14Str = hace14.toISOString().split('T')[0];

    const categoriasConDatos = db.prepare(`
      SELECT c.codigo, c.nombre, COUNT(p.id) AS n_registros
      FROM categorias c
      LEFT JOIN precios_raw p ON c.codigo = p.categoria_codigo AND p.fecha >= ?
      WHERE c.activo = 1
      GROUP BY c.codigo
    `).all(hace14Str);

    const sinDatos = categoriasConDatos.filter(c => c.n_registros === 0);
    resultado.detalles.categorias_sin_datos_14d = sinDatos.map(c => c.codigo);

    if (sinDatos.length > 0) {
      resultado.alertas_warning.push({
        check: 'categorias_sin_datos',
        mensaje: `Categorias sin datos en 14 dias: ${sinDatos.map(c => c.codigo).join(', ')}`
      });
    } else {
      resultado.checks_ok.push('Todas las categorias tienen datos recientes');
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'categorias_sin_datos', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 6: Variacion semanal anomala (>5%)
  // ══════════════════════════════════════════════════════════
  try {
    const ultimoIndice = db.prepare(`
      SELECT fecha, igu_general, variacion_diaria
      FROM indice ORDER BY fecha DESC LIMIT 1
    `).get();

    if (ultimoIndice && ultimoIndice.variacion_diaria != null) {
      resultado.detalles.variacion_semanal = ultimoIndice.variacion_diaria;

      if (Math.abs(ultimoIndice.variacion_diaria) > UMBRAL_VARIACION_SEMANAL_ALERTA) {
        resultado.alertas_warning.push({
          check: 'variacion_anomala',
          mensaje: `IGU vario ${ultimoIndice.variacion_diaria.toFixed(2)}% respecto a semana anterior (umbral ±${UMBRAL_VARIACION_SEMANAL_ALERTA}%). Revisar.`
        });
      } else {
        resultado.checks_ok.push(`Variacion semanal normal: ${ultimoIndice.variacion_diaria.toFixed(2)}%`);
      }
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'variacion_anomala', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 7: VP en rango razonable (USD/cab 400-2500)
  // ══════════════════════════════════════════════════════════
  try {
    const vpRegistros = db.prepare(`
      SELECT precio, fecha, fuente, observaciones
      FROM precios_raw
      WHERE categoria_codigo = 'VP'
      ORDER BY created_at DESC LIMIT 5
    `).all();

    if (vpRegistros.length === 0) {
      resultado.alertas_warning.push({
        check: 'vp_datos',
        mensaje: 'No hay registros VP en la base. Scrapers no estan extrayendo preñadas.'
      });
    } else {
      const fueraDeRango = vpRegistros.filter(r => {
        const usdCab = r.precio * PESO_VP_KG;
        return usdCab < VP_USD_CAB_MIN || usdCab > VP_USD_CAB_MAX;
      });

      if (fueraDeRango.length > 0) {
        resultado.alertas_criticas.push({
          check: 'vp_rango',
          mensaje: `${fueraDeRango.length} registros VP fuera de rango (${VP_USD_CAB_MIN}-${VP_USD_CAB_MAX} USD/cab). Bug de parseo?`
        });
      } else {
        const precioPromedio = vpRegistros.reduce((s, r) => s + r.precio, 0) / vpRegistros.length;
        resultado.detalles.vp_precio_promedio_usdkg = parseFloat(precioPromedio.toFixed(4));
        resultado.detalles.vp_precio_promedio_usdcab = parseFloat((precioPromedio * PESO_VP_KG).toFixed(0));
        resultado.checks_ok.push(`VP en rango: ~${(precioPromedio * PESO_VP_KG).toFixed(0)} USD/cab`);
      }
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'vp_rango', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 8: Duplicados en precios_raw
  // ══════════════════════════════════════════════════════════
  try {
    const duplicados = db.prepare(`
      SELECT fecha, categoria_codigo, fuente, COUNT(*) AS n
      FROM precios_raw
      GROUP BY fecha, categoria_codigo, fuente
      HAVING COUNT(*) > 1
    `).all();

    resultado.detalles.combinaciones_duplicadas = duplicados.length;

    if (duplicados.length > 0) {
      resultado.alertas_warning.push({
        check: 'duplicados',
        mensaje: `${duplicados.length} combinaciones (fecha, categoria, fuente) duplicadas. Correr /admin/limpiar-duplicados.`
      });
    } else {
      resultado.checks_ok.push('Sin duplicados en precios_raw');
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'duplicados', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 9: Las 3 fuentes tuvieron datos en los ultimos 14 dias
  // ══════════════════════════════════════════════════════════
  try {
    const hace14 = new Date();
    hace14.setDate(hace14.getDate() - 14);
    const hace14Str = hace14.toISOString().split('T')[0];

    const fuentesActivas = db.prepare(`
      SELECT fuente, COUNT(*) AS n, MAX(fecha) AS ultima_fecha
      FROM precios_raw
      WHERE fecha >= ?
      GROUP BY fuente
    `).all(hace14Str);

    resultado.detalles.fuentes_14d = fuentesActivas;

    const fuentesEsperadas = ['inac', 'plaza_rural', 'pantalla_uruguay'];
    const fuentesFaltantes = fuentesEsperadas.filter(
      f => !fuentesActivas.some(a => a.fuente === f)
    );

    if (fuentesFaltantes.length > 0) {
      resultado.alertas_warning.push({
        check: 'fuentes_faltantes',
        mensaje: `Fuentes sin datos en 14 dias: ${fuentesFaltantes.join(', ')}. Scrapers rotos?`
      });
    } else {
      resultado.checks_ok.push(`Las 3 fuentes activas: ${fuentesActivas.map(f => `${f.fuente}(${f.n})`).join(', ')}`);
    }
  } catch (err) {
    resultado.alertas_warning.push({ check: 'fuentes', mensaje: `Error: ${err.message}` });
  }

  // ══════════════════════════════════════════════════════════
  // CHECK 10: Ultimo scraping_log exitoso por fuente
  // ══════════════════════════════════════════════════════════
  try {
    const logs = db.prepare(`
      SELECT fuente, status, fecha_ejecucion, registros_obtenidos, error_msg
      FROM scraping_log
      WHERE id IN (
        SELECT MAX(id) FROM scraping_log GROUP BY fuente
      )
      ORDER BY fecha_ejecucion DESC
    `).all();

    const fallaron = logs.filter(l => l.status === 'error');
    if (fallaron.length > 0) {
      resultado.alertas_warning.push({
        check: 'scrapers_con_error',
        mensaje: `Ultimos scrapes con error: ${fallaron.map(l => `${l.fuente}(${l.error_msg})`).join(' | ')}`
      });
    } else if (logs.length > 0) {
      resultado.checks_ok.push(`Ultimos scrapes OK: ${logs.map(l => l.fuente).join(', ')}`);
    }
  } catch (err) {
    // No critico
  }

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
  // RESUMEN EJECUTIVO
  // ══════════════════════════════════════════════════════════
  const emoji = {
    ok: '✅',
    warning: '⚠️',
    critical: '🔴'
  };

  resultado.resumen_ejecutivo = `${emoji[resultado.estado_general]} Estado: ${resultado.estado_general.toUpperCase()} | ` +
    `${resultado.checks_ok.length} checks OK | ` +
    `${resultado.alertas_warning.length} warnings | ` +
    `${resultado.alertas_criticas.length} criticas`;

  return resultado;
}

module.exports = { ejecutarHealthcheck };
