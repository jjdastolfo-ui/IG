// auditoria-valores.js
// Sistema de auditoria de veracidad de datos del IGU
//
// 3 CAPAS:
//   A) Comparacion fuente -> base:
//      Re-descarga la fuente original y compara con lo que tenemos guardado.
//   B) Coherencia cruzada:
//      Verifica que Plaza Rural y Pantalla Uruguay publiquen precios similares
//      para TE, VI y VP (mismo periodo, mismo mercado).
//   C) Rangos historicos:
//      Detecta valores que se alejan mas de X% del promedio historico
//      de las ultimas N semanas.

const axios = require('axios');
const cheerio = require('cheerio');
const XLSX = require('xlsx');

// Umbrales de diferencia aceptada
const UMBRAL_MATCH_PCT = 0.5;          // <=0.5% = match exacto
const UMBRAL_WARNING_PCT = 2.0;         // 0.5%-2% = warning menor
const UMBRAL_CRITICAL_PCT = 5.0;        // >5% = critico
const UMBRAL_COHERENCIA_CRUZADA = 10.0; // >10% entre fuentes = discrepancia
const VENTANA_HISTORICA_SEMANAS = 8;    // para calcular promedio historico

// Peso estandar para VP (convertir USD/cab a USD/kg)
const PESO_VP_KG = 420;

const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';
const PLAZA_RURAL_URL = 'https://www.plazarural.com.uy/promedios';
const PANTALLA_URL = 'https://www.pantallauruguay.com.uy/promedios';

// Mapeos espejo de los scrapers (deben coincidir)
const MAPEO_HOJAS_INAC = { NOVILLO: 'NG', VACA: 'VG', VAQUILLONA: 'VQ' };
const COL_FECHA_FIN = 1;
const COL_4TA_BALANZA = 9;
const FILA_DATOS_DESDE = 12;

// ============================================================================
// HELPER: Retry con backoff exponencial
// ============================================================================
//
// Reintenta un fetch hasta N veces con espera incremental entre intentos.
// Util para servidores externos inestables (como Plaza Rural).
//
// Intentos:
//   1ro: inmediato
//   2do: espera 2 segundos
//   3ro: espera 5 segundos
//
// Si los 3 fallan, propaga el ultimo error.

async function fetchConRetry(fetchFn, descripcion = 'recurso', intentos = 3) {
  const esperas = [0, 2000, 5000];
  let ultimoError;

  for (let i = 0; i < intentos; i++) {
    if (esperas[i] > 0) {
      console.log(`  ⏳ Reintentando ${descripcion} (intento ${i + 1}/${intentos}) tras ${esperas[i]}ms...`);
      await new Promise(r => setTimeout(r, esperas[i]));
    }

    try {
      return await fetchFn();
    } catch (err) {
      ultimoError = err;
      const ultimoIntento = i === intentos - 1;
      if (!ultimoIntento) {
        console.log(`  ⚠️  ${descripcion} fallo intento ${i + 1}: ${err.message}. Reintentando...`);
      }
    }
  }

  throw new Error(`${descripcion} fallo tras ${intentos} intentos. Ultimo error: ${ultimoError.message}`);
}

// ============================================================================
// CAPA A: Comparacion fuente -> base
// ============================================================================

/**
 * Descarga INAC y devuelve el precio mas reciente por categoria.
 */
async function obtenerPreciosINACReales() {
  const response = await fetchConRetry(
    () => axios.get(INAC_XLSX_URL, {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Auditor/1.0)' }
    }),
    'INAC Excel'
  );

  const workbook = XLSX.read(response.data, { type: 'buffer', cellDates: true });
  const precios = {};

  for (const [nombreHoja, codigoIGU] of Object.entries(MAPEO_HOJAS_INAC)) {
    const sheet = workbook.Sheets[nombreHoja];
    if (!sheet) continue;

    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

    for (let i = data.length - 1; i >= FILA_DATOS_DESDE; i--) {
      const row = data[i];
      if (!row || row.length < 10) continue;
      const fecha = parsearFechaINAC(row[COL_FECHA_FIN]);
      if (!fecha) continue;
      const precio = parseFloat(row[COL_4TA_BALANZA]);
      if (isNaN(precio) || precio <= 0 || precio > 20) continue;

      precios[codigoIGU] = {
        precio,
        fecha: fecha.toISOString().split('T')[0],
        hoja: nombreHoja
      };
      break;
    }
  }

  return precios;
}

/**
 * Descarga Plaza Rural y devuelve precios por categoria.
 */
async function obtenerPreciosPlazaRuralReales() {
  const response = await fetchConRetry(
    () => axios.get(PLAZA_RURAL_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Auditor/1.0)' }
    }),
    'Plaza Rural HTML'
  );
  const $ = cheerio.load(response.data);

  const titulo = $('h2').text().trim();
  const matchRemate = titulo.match(/REMATE\s*(\d+)/i);
  const nroRemate = matchRemate ? matchRemate[1] : 'desconocido';

  const precios = {};
  const mapeo = {
    'Terneros entre 140 y 180 kg': 'TE',
    'Vacas de Invernada': 'VI',
    'Vientres Preñados': 'VP'
  };

  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 7) return;
    const categoriaTexto = $(cells[0]).text().trim();
    const promTexto = $(cells[5]).text().trim();
    if (!mapeo[categoriaTexto] || !promTexto) return;

    const codigoIGU = mapeo[categoriaTexto];
    let precio = parseFloat(promTexto.replace(',', '.'));
    if (isNaN(precio)) return;

    if (codigoIGU === 'VP') {
      if (precio < 100 || precio > 5000) return;
      precios[codigoIGU] = {
        precio_usdkg: parseFloat((precio / PESO_VP_KG).toFixed(4)),
        precio_usdcab: precio,
        remate: nroRemate,
        categoria_texto: categoriaTexto
      };
    } else {
      if (precio <= 0 || precio > 20) return;
      precios[codigoIGU] = {
        precio_usdkg: precio,
        remate: nroRemate,
        categoria_texto: categoriaTexto
      };
    }
  });

  return precios;
}

/**
 * Descarga Pantalla Uruguay y devuelve precios por categoria.
 */
async function obtenerPreciosPantallaReales() {
  const response = await fetchConRetry(
    () => axios.get(PANTALLA_URL, {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Auditor/1.0)' }
    }),
    'Pantalla Uruguay HTML'
  );
  const $ = cheerio.load(response.data);

  let nroRemate = 'desconocido';
  $('h2').each((i, el) => {
    const texto = $(el).text().trim();
    const match = texto.match(/^(\d+)\s+Remate/i);
    if (match) nroRemate = match[1];
  });

  const precios = {};
  const mapeo = {
    'Terneros entre 140 y 180 kg': 'TE',
    'Vacas de Invernada': 'VI',
    'Vacas Preñadas': 'VP',
    'Vaquillonas Preñadas': 'VP'
  };

  $('table tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 4) return;
    const categoriaTexto = $(cells[0]).text().trim();
    const promTexto = $(cells[3]).text().trim();
    if (!mapeo[categoriaTexto] || !promTexto) return;

    const codigoIGU = mapeo[categoriaTexto];
    let precio;

    if (codigoIGU === 'VP') {
      const limpio = promTexto.replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
      const num = parseFloat(limpio);
      if (isNaN(num)) return;
      const preciosCab = num >= 100000 ? num / 1000 : num;
      if (preciosCab < 100 || preciosCab > 5000) return;

      if (!precios[codigoIGU]) precios[codigoIGU] = { observaciones: [], precio_usdkg: 0 };
      precios[codigoIGU].observaciones.push({
        categoria_texto: categoriaTexto,
        precio_usdcab: preciosCab,
        precio_usdkg: parseFloat((preciosCab / PESO_VP_KG).toFixed(4))
      });
    } else {
      const num = parseFloat(promTexto.replace(',', '.'));
      if (isNaN(num)) return;
      precio = num >= 100 && num < 10000 ? num / 1000 : num;
      if (precio <= 0 || precio > 20) return;

      if (!precios[codigoIGU]) {
        precios[codigoIGU] = { precio_usdkg: precio, remate: nroRemate, categoria_texto: categoriaTexto };
      }
    }
  });

  // Promediar VP si hay varias subcategorias
  if (precios.VP && precios.VP.observaciones && precios.VP.observaciones.length > 0) {
    const sumaKg = precios.VP.observaciones.reduce((s, o) => s + o.precio_usdkg, 0);
    precios.VP.precio_usdkg = parseFloat((sumaKg / precios.VP.observaciones.length).toFixed(4));
    precios.VP.remate = nroRemate;
  }

  return precios;
}

// ============================================================================
// CAPA A: Ejecutar auditoria fuente-base
// ============================================================================

async function auditarFuenteVsBase(db) {
  const resultados = {
    ok: [],
    warnings: [],
    criticas: [],
    errores: []
  };

  // 1. INAC
  try {
    const reales = await obtenerPreciosINACReales();
    for (const [cat, info] of Object.entries(reales)) {
      const enDB = db.prepare(`
        SELECT precio FROM precios_raw
        WHERE fecha = ? AND categoria_codigo = ? AND fuente = 'inac'
        ORDER BY created_at DESC LIMIT 1
      `).get(info.fecha, cat);

      const registro = {
        fecha_dato: info.fecha,
        categoria: cat,
        fuente: 'inac',
        valor_fuente: info.precio,
        valor_db: enDB?.precio,
        url: INAC_XLSX_URL
      };

      if (!enDB) {
        resultados.errores.push({ ...registro, motivo: 'No hay registro en DB para esta fecha' });
        continue;
      }

      const diff = Math.abs(enDB.precio - info.precio);
      const diffPct = (diff / info.precio) * 100;
      registro.diferencia_pct = parseFloat(diffPct.toFixed(3));

      if (diffPct <= UMBRAL_MATCH_PCT) resultados.ok.push(registro);
      else if (diffPct <= UMBRAL_WARNING_PCT) resultados.warnings.push(registro);
      else resultados.criticas.push(registro);
    }
  } catch (err) {
    resultados.errores.push({ fuente: 'inac', motivo: err.message });
  }

  // 2. Plaza Rural
  try {
    const reales = await obtenerPreciosPlazaRuralReales();
    const ultimoViernes = obtenerUltimoViernes();

    for (const [cat, info] of Object.entries(reales)) {
      const enDB = db.prepare(`
        SELECT precio FROM precios_raw
        WHERE fecha = ? AND categoria_codigo = ? AND fuente = 'plaza_rural'
        ORDER BY created_at DESC LIMIT 1
      `).get(ultimoViernes, cat);

      const registro = {
        fecha_dato: ultimoViernes,
        categoria: cat,
        fuente: 'plaza_rural',
        valor_fuente: info.precio_usdkg,
        valor_db: enDB?.precio,
        url: PLAZA_RURAL_URL,
        contexto: `Remate ${info.remate} · ${info.categoria_texto}` + (info.precio_usdcab ? ` (${info.precio_usdcab} USD/cab)` : '')
      };

      if (!enDB) {
        resultados.errores.push({ ...registro, motivo: 'No hay registro en DB para esta fecha' });
        continue;
      }

      const diff = Math.abs(enDB.precio - info.precio_usdkg);
      const diffPct = (diff / info.precio_usdkg) * 100;
      registro.diferencia_pct = parseFloat(diffPct.toFixed(3));

      if (diffPct <= UMBRAL_MATCH_PCT) resultados.ok.push(registro);
      else if (diffPct <= UMBRAL_WARNING_PCT) resultados.warnings.push(registro);
      else resultados.criticas.push(registro);
    }
  } catch (err) {
    resultados.errores.push({ fuente: 'plaza_rural', motivo: err.message });
  }

  // 3. Pantalla Uruguay
  try {
    const reales = await obtenerPreciosPantallaReales();
    const ultimoViernes = obtenerUltimoViernes();

    for (const [cat, info] of Object.entries(reales)) {
      // Para VP promediamos los registros DB de esta fecha/fuente
      const registrosDB = db.prepare(`
        SELECT AVG(precio) AS precio_promedio FROM precios_raw
        WHERE fecha = ? AND categoria_codigo = ? AND fuente = 'pantalla_uruguay'
      `).get(ultimoViernes, cat);

      const registro = {
        fecha_dato: ultimoViernes,
        categoria: cat,
        fuente: 'pantalla_uruguay',
        valor_fuente: info.precio_usdkg,
        valor_db: registrosDB?.precio_promedio,
        url: PANTALLA_URL,
        contexto: `Remate ${info.remate}` + (info.observaciones ? ` · ${info.observaciones.length} subcategorias VP` : '')
      };

      if (!registrosDB?.precio_promedio) {
        resultados.errores.push({ ...registro, motivo: 'No hay registro en DB para esta fecha' });
        continue;
      }

      const diff = Math.abs(registrosDB.precio_promedio - info.precio_usdkg);
      const diffPct = (diff / info.precio_usdkg) * 100;
      registro.diferencia_pct = parseFloat(diffPct.toFixed(3));

      if (diffPct <= UMBRAL_MATCH_PCT) resultados.ok.push(registro);
      else if (diffPct <= UMBRAL_WARNING_PCT) resultados.warnings.push(registro);
      else resultados.criticas.push(registro);
    }
  } catch (err) {
    resultados.errores.push({ fuente: 'pantalla_uruguay', motivo: err.message });
  }

  return resultados;
}

// ============================================================================
// CAPA B: Coherencia cruzada entre Plaza Rural y Pantalla Uruguay
// ============================================================================

function auditarCoherenciaCruzada(db) {
  const ultimoViernes = obtenerUltimoViernes();
  const resultados = { ok: [], discrepancias: [] };
  const categorias = ['TE', 'VI', 'VP'];

  categorias.forEach(cat => {
    const plaza = db.prepare(`
      SELECT AVG(precio) AS p FROM precios_raw
      WHERE fecha = ? AND categoria_codigo = ? AND fuente = 'plaza_rural'
    `).get(ultimoViernes, cat);

    const pantalla = db.prepare(`
      SELECT AVG(precio) AS p FROM precios_raw
      WHERE fecha = ? AND categoria_codigo = ? AND fuente = 'pantalla_uruguay'
    `).get(ultimoViernes, cat);

    if (!plaza?.p || !pantalla?.p) {
      return;
    }

    const diff = Math.abs(plaza.p - pantalla.p);
    const diffPct = (diff / ((plaza.p + pantalla.p) / 2)) * 100;

    const registro = {
      categoria: cat,
      fecha: ultimoViernes,
      plaza_rural: parseFloat(plaza.p.toFixed(4)),
      pantalla_uruguay: parseFloat(pantalla.p.toFixed(4)),
      diferencia_pct: parseFloat(diffPct.toFixed(2))
    };

    if (diffPct <= UMBRAL_COHERENCIA_CRUZADA) resultados.ok.push(registro);
    else resultados.discrepancias.push(registro);
  });

  return resultados;
}

// ============================================================================
// CAPA C: Rangos historicos
// ============================================================================

function auditarRangosHistoricos(db) {
  const categorias = db.prepare(`
    SELECT codigo FROM categorias WHERE activo = 1
  `).all();

  const resultados = { ok: [], alertas: [] };

  categorias.forEach(({ codigo }) => {
    // Obtener precios historicos de las ultimas N semanas
    const historicos = db.prepare(`
      SELECT AVG(precio) AS precio_prom, fecha
      FROM precios_raw
      WHERE categoria_codigo = ?
        AND fecha >= date('now', '-${VENTANA_HISTORICA_SEMANAS * 7} days')
      GROUP BY fecha
      ORDER BY fecha DESC
    `).all(codigo);

    if (historicos.length < 3) return;

    const ultimo = historicos[0];
    const previos = historicos.slice(1);
    const promedio = previos.reduce((s, r) => s + r.precio_prom, 0) / previos.length;
    const variacion = ((ultimo.precio_prom - promedio) / promedio) * 100;
    const diffAbs = Math.abs(variacion);

    const registro = {
      categoria: codigo,
      fecha_ultimo: ultimo.fecha,
      precio_ultimo: parseFloat(ultimo.precio_prom.toFixed(4)),
      promedio_historico: parseFloat(promedio.toFixed(4)),
      variacion_pct: parseFloat(variacion.toFixed(2)),
      ventana_semanas: VENTANA_HISTORICA_SEMANAS
    };

    if (diffAbs <= 5) resultados.ok.push(registro);
    else resultados.alertas.push(registro);
  });

  return resultados;
}

// ============================================================================
// ORQUESTADOR: ejecuta las 3 capas y guarda en DB
// ============================================================================

async function ejecutarAuditoriaCompleta(db) {
  const inicio = Date.now();
  const timestamp = new Date().toISOString();

  console.log('='.repeat(60));
  console.log('AUDITORIA DE VALORES - las 3 capas');
  console.log('='.repeat(60));

  // Capa A
  console.log('  [A] Verificando fuentes vs base...');
  const capaA = await auditarFuenteVsBase(db);

  // Capa B
  console.log('  [B] Verificando coherencia cruzada...');
  const capaB = auditarCoherenciaCruzada(db);

  // Capa C
  console.log('  [C] Verificando rangos historicos...');
  const capaC = auditarRangosHistoricos(db);

  // Guardar en DB
  guardarResultadosEnDB(db, { capaA, capaB, capaC });

  const resumen = {
    timestamp,
    duracion_ms: Date.now() - inicio,
    capa_A: {
      titulo: 'Comparacion fuente vs base de datos',
      matches_exactos: capaA.ok.length,
      warnings: capaA.warnings.length,
      discrepancias_criticas: capaA.criticas.length,
      errores: capaA.errores.length,
      detalles: capaA
    },
    capa_B: {
      titulo: 'Coherencia cruzada Plaza Rural vs Pantalla Uruguay',
      coherentes: capaB.ok.length,
      discrepancias: capaB.discrepancias.length,
      detalles: capaB
    },
    capa_C: {
      titulo: 'Rangos historicos (ultimas ' + VENTANA_HISTORICA_SEMANAS + ' semanas)',
      dentro_rango: capaC.ok.length,
      fuera_rango: capaC.alertas.length,
      detalles: capaC
    }
  };

  const totalDiscrepancias =
    capaA.warnings.length + capaA.criticas.length + capaA.errores.length +
    capaB.discrepancias.length + capaC.alertas.length;

  resumen.estado_general = totalDiscrepancias === 0 ? 'ok' :
    (capaA.criticas.length > 0 ? 'critical' : 'warning');

  resumen.resumen_ejecutivo = `${resumen.estado_general === 'ok' ? '✅' : (resumen.estado_general === 'critical' ? '🔴' : '⚠️')} ` +
    `Auditoria ${resumen.estado_general.toUpperCase()} | ` +
    `A:${capaA.ok.length}/${capaA.ok.length + capaA.warnings.length + capaA.criticas.length + capaA.errores.length} matches | ` +
    `B:${capaB.ok.length} coherentes, ${capaB.discrepancias.length} discrepancias | ` +
    `C:${capaC.ok.length} en rango, ${capaC.alertas.length} fuera`;

  console.log(`  ${resumen.resumen_ejecutivo}`);
  console.log(`  Duracion: ${resumen.duracion_ms}ms`);

  return resumen;
}

function guardarResultadosEnDB(db, { capaA }) {
  const insert = db.prepare(`
    INSERT INTO auditoria_valores
    (fecha_dato, categoria_codigo, fuente, valor_en_db, valor_en_fuente,
     diferencia_pct, match, severidad, detalle, url_fuente)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const todos = [
    ...capaA.ok.map(r => ({ ...r, severidad: 'ok', match: 1 })),
    ...capaA.warnings.map(r => ({ ...r, severidad: 'warning', match: 0 })),
    ...capaA.criticas.map(r => ({ ...r, severidad: 'critical', match: 0 }))
  ];

  const transaction = db.transaction((items) => {
    items.forEach(r => {
      insert.run(
        r.fecha_dato, r.categoria, r.fuente,
        r.valor_db, r.valor_fuente,
        r.diferencia_pct || 0,
        r.match, r.severidad,
        r.contexto || '',
        r.url || ''
      );
    });
  });

  transaction(todos);

  // Tambien guardar discrepancias en tabla aparte
  const insertDisc = db.prepare(`
    INSERT INTO auditoria_discrepancias
    (auditoria_id, fecha_dato, categoria_codigo, fuente, valor_db, valor_fuente, diferencia_pct, resolucion)
    VALUES ((SELECT MAX(id) FROM auditoria_valores), ?, ?, ?, ?, ?, ?, 'pendiente')
  `);

  const discrepancias = [
    ...capaA.warnings,
    ...capaA.criticas
  ];

  const txDisc = db.transaction((items) => {
    items.forEach(r => {
      insertDisc.run(
        r.fecha_dato, r.categoria, r.fuente,
        r.valor_db, r.valor_fuente, r.diferencia_pct || 0
      );
    });
  });

  txDisc(discrepancias);
}

// ============================================================================
// HELPERS
// ============================================================================

function parsearFechaINAC(valor) {
  if (!valor) return null;
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }
  if (typeof valor === 'string') {
    const m = valor.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [_, mes, dia, anio] = m;
      mes = parseInt(mes);
      dia = parseInt(dia);
      anio = parseInt(anio);
      if (anio < 100) anio = anio < 50 ? 2000 + anio : 1900 + anio;
      if (anio < 2000 || anio > 2100) return null;
      const fecha = new Date(anio, mes - 1, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }
  }
  return null;
}

function obtenerUltimoViernes() {
  const hoy = new Date();
  const diasAtras = (hoy.getDay() + 2) % 7;
  const viernes = new Date(hoy);
  viernes.setDate(viernes.getDate() - diasAtras);
  return viernes.toISOString().split('T')[0];
}

module.exports = {
  ejecutarAuditoriaCompleta,
  auditarFuenteVsBase,
  auditarCoherenciaCruzada,
  auditarRangosHistoricos,
  obtenerPreciosINACReales,
  obtenerPreciosPlazaRuralReales,
  obtenerPreciosPantallaReales
};
