// scraper-inac.js v2.3
// Scraper de INAC - descarga y parsea Excel oficial con precios semanales
// URL del Excel: https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx
//
// CAMBIOS v2.3 (20/4/2026):
// - FIX CRITICO: el Excel tiene 3 HOJAS SEPARADAS (NOVILLO, VACA, VAQUILLONA)
//   El scraper anterior leia solo workbook.SheetNames[0] y no encontraba datos.
// - Usa la misma logica que /admin/importar-historico: estructura fija de columnas
// - Extrae solo la ULTIMA semana disponible (no todo el historico)
//
// ESTRUCTURA REAL DEL EXCEL INAC (verificada via /admin/debug-excel):
//   Filas 0-8: notas al pie y titulos
//   Filas 9-11: headers multi-linea
//   Filas 12+: datos con estructura fija:
//     col 0: fecha inicio semana (M/D/YY, ej "1/2/26")
//     col 1: fecha fin semana
//     col 2: año
//     col 3: mes
//     col 4: semana del año
//     col 5: EN PIE USD/kg
//     col 9: EN CUARTA BALANZA USD/kg (b) ← lo que usamos

const axios = require('axios');
const XLSX = require('xlsx');

const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';

// Mapeo hoja del Excel -> codigo IGU
const MAPEO_HOJAS_INAC = {
  'NOVILLO':    'NG',
  'VACA':       'VG',
  'VAQUILLONA': 'VQ'
};

// Columnas FIJAS del Excel INAC
const COL_FECHA_INICIO = 0;
const COL_FECHA_FIN = 1;
const COL_4TA_BALANZA = 9;
const FILA_DATOS_DESDE = 12;

async function scrapeINAC(db) {
  const startTime = Date.now();
  const resultados = [];

  try {
    console.log('→ INAC: descargando Excel oficial...');

    const response = await axios.get(INAC_XLSX_URL, {
      timeout: 30000,
      responseType: 'arraybuffer',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0)'
      }
    });

    const workbook = XLSX.read(response.data, { type: 'buffer', cellDates: true });
    console.log(`  Hojas disponibles: ${workbook.SheetNames.join(', ')}`);

    // Procesar cada hoja de categoria: NOVILLO, VACA, VAQUILLONA
    for (const [nombreHoja, codigoIGU] of Object.entries(MAPEO_HOJAS_INAC)) {
      const sheet = workbook.Sheets[nombreHoja];
      if (!sheet) {
        console.warn(`  ⚠ Hoja "${nombreHoja}" no existe, saltando`);
        continue;
      }

      const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

      // Buscar la ULTIMA fila con datos validos (fecha + precio 4ta balanza > 0)
      let ultimaFila = null;
      let ultimaFecha = null;

      for (let i = data.length - 1; i >= FILA_DATOS_DESDE; i--) {
        const row = data[i];
        if (!row || row.length < 10) continue;

        // Parsear fecha de FIN de semana (col 1); si no, inicio (col 0)
        const fecha = parsearFechaINAC(row[COL_FECHA_FIN]) || parsearFechaINAC(row[COL_FECHA_INICIO]);
        if (!fecha) continue;

        const precio = parseFloat(row[COL_4TA_BALANZA]);
        if (isNaN(precio) || precio <= 0 || precio > 20) continue;

        // Encontramos fila valida reciente
        ultimaFila = row;
        ultimaFecha = fecha;
        break;
      }

      if (!ultimaFila || !ultimaFecha) {
        console.warn(`  ⚠ Hoja "${nombreHoja}": no se encontro fila reciente valida`);
        continue;
      }

      const fechaISO = ultimaFecha.toISOString().split('T')[0];
      const precio = parseFloat(ultimaFila[COL_4TA_BALANZA]);

      resultados.push({
        fecha: fechaISO,
        categoria_codigo: codigoIGU,
        fuente: 'inac',
        precio: precio,
        unidad: 'USD/kg',
        volumen: null,  // INAC publica promedio ponderado, sin volumen individual
        observaciones: `INAC serie semanal - ${nombreHoja} 4ta balanza - semana cierre ${fechaISO}`
      });
    }

    console.log(`  ✓ ${resultados.length} categorias extraidas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio} USD/kg (${r.fecha})`);
    });

    const nota = resultados.length > 0
      ? `${resultados.length} categorias - fecha mas reciente: ${resultados[0].fecha}`
      : 'Sin datos extraidos';

    logScraping(db, 'inac', resultados.length > 0 ? 'success' : 'warning',
                resultados.length, null, Date.now() - startTime, nota);

  } catch (err) {
    console.error('  ✗ INAC error:', err.message);
    logScraping(db, 'inac', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
}

/**
 * Parsea fechas del Excel INAC en formato M/D/YY
 * Ejemplos: "1/2/26" → 2026-01-02, "12/29/25" → 2025-12-29
 */
function parsearFechaINAC(valor) {
  if (!valor) return null;

  // Si ya es Date
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }

  // Si es string en formato M/D/YY o M/D/YYYY
  if (typeof valor === 'string') {
    const m = valor.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [_, mes, dia, anio] = m;
      mes = parseInt(mes);
      dia = parseInt(dia);
      anio = parseInt(anio);

      if (anio < 100) {
        anio = anio < 50 ? 2000 + anio : 1900 + anio;
      }

      if (anio < 2000 || anio > 2100) return null;
      if (mes < 1 || mes > 12) return null;
      if (dia < 1 || dia > 31) return null;

      const fecha = new Date(anio, mes - 1, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }

    // Tambien probar ISO YYYY-MM-DD
    const m2 = valor.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const fecha = new Date(valor);
      if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000) return fecha;
    }
  }

  // Serial date Excel
  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    const excelEpoch = new Date(1900, 0, 1);
    const fecha = new Date(excelEpoch.getTime() + (valor - 2) * 86400000);
    if (fecha.getFullYear() > 2000 && fecha.getFullYear() < 2100) return fecha;
  }

  return null;
}

function logScraping(db, fuente, status, registros, errorMsg, duracionMs, nota) {
  try {
    db.prepare(`
      INSERT INTO scraping_log (fuente, status, registros_obtenidos, error_msg, duracion_ms)
      VALUES (?, ?, ?, ?, ?)
    `).run(fuente, status, registros, errorMsg || nota, duracionMs);
  } catch (e) {
    console.error('Error logging:', e.message);
  }
}

module.exports = { scrapeINAC, INAC_XLSX_URL };
