// scraper-inac.js
// Scraper de INAC - descarga y parsea Excel oficial con precios semanales
// URL del Excel: https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx
//
// El Excel contiene:
// - Serie semanal desde 2005
// - Categorías: Novillo gordo, Vaca gorda, Vaquillona en pie y 4ta balanza
// - Valor contado en USD/kg

const axios = require('axios');
const XLSX = require('xlsx');

const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';

// Mapeo de nombres de columnas del Excel INAC a códigos IGU
// NOTA: Los nombres exactos de columna pueden variar, hay fallbacks
const MAPEO_INAC_COLUMNAS = {
  // Precio en 4ta balanza (peso canal), que es el estándar
  'Novillo en 4ta bza': 'NG',
  'Novillo 4ta bza': 'NG',
  'Novillo gordo': 'NG',
  'Vaca en 4ta bza': 'VG',
  'Vaca 4ta bza': 'VG',
  'Vaca gorda': 'VG',
  'Vaquillona en 4ta bza': 'VQ',
  'Vaquillona 4ta bza': 'VQ',
  'Vaquillona': 'VQ'
};

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

    // Usar la primera hoja (generalmente es la que tiene la serie histórica)
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false });

    // Buscar la fila de headers (generalmente está en las primeras filas)
    let headerRowIdx = -1;
    let headers = null;

    for (let i = 0; i < Math.min(10, data.length); i++) {
      const row = data[i];
      if (!row) continue;
      const rowText = row.join(' ').toLowerCase();
      if (rowText.includes('novillo') && (rowText.includes('vaca') || rowText.includes('bza'))) {
        headerRowIdx = i;
        headers = row.map(h => (h || '').toString().trim());
        break;
      }
    }

    if (headerRowIdx === -1) {
      throw new Error('No se encontró fila de headers con categorías ganaderas');
    }

    console.log(`  Headers encontrados en fila ${headerRowIdx + 1}`);

    // Identificar qué columnas corresponden a qué categoría IGU
    const mapeoColumnas = {};  // { indiceColumna: codigoIGU }

    headers.forEach((header, idx) => {
      const headerNorm = header.toLowerCase().replace(/\s+/g, ' ').trim();

      // Priorizar 4ta balanza (estándar de la metodología)
      if (headerNorm.includes('novillo') && headerNorm.includes('bza')) {
        if (!Object.values(mapeoColumnas).includes('NG')) mapeoColumnas[idx] = 'NG';
      } else if (headerNorm.includes('vaca') && headerNorm.includes('bza') && !headerNorm.includes('vaquillona')) {
        if (!Object.values(mapeoColumnas).includes('VG')) mapeoColumnas[idx] = 'VG';
      } else if (headerNorm.includes('vaquillona') && headerNorm.includes('bza')) {
        if (!Object.values(mapeoColumnas).includes('VQ')) mapeoColumnas[idx] = 'VQ';
      }
    });

    console.log(`  Columnas mapeadas:`, mapeoColumnas);

    if (Object.keys(mapeoColumnas).length === 0) {
      throw new Error('No se pudieron mapear columnas. Headers: ' + headers.slice(0, 10).join(' | '));
    }

    // Buscar la última fila con datos válidos (la más reciente)
    let ultimaFilaValida = null;
    let fechaUltima = null;

    for (let i = data.length - 1; i > headerRowIdx; i--) {
      const row = data[i];
      if (!row || row.length < 2) continue;

      // La fecha suele estar en la primera o segunda columna
      const posibleFecha = parsearFechaExcel(row[0]) || parsearFechaExcel(row[1]);
      if (!posibleFecha) continue;

      // Verificar que al menos una categoría tenga precio válido
      const tienePrecios = Object.keys(mapeoColumnas).some(idx => {
        const val = parseFloat(row[idx]);
        return !isNaN(val) && val > 0;
      });

      if (tienePrecios) {
        ultimaFilaValida = row;
        fechaUltima = posibleFecha;
        break;
      }
    }

    if (!ultimaFilaValida) {
      throw new Error('No se encontró fila con datos válidos recientes');
    }

    const fechaISO = fechaUltima.toISOString().split('T')[0];
    console.log(`  Datos más recientes: ${fechaISO}`);

    // Extraer precios de cada categoría
    Object.entries(mapeoColumnas).forEach(([idxStr, codigoIGU]) => {
      const idx = parseInt(idxStr);
      const precio = parseFloat(ultimaFilaValida[idx]);

      if (!isNaN(precio) && precio > 0) {
        resultados.push({
          fecha: fechaISO,
          categoria_codigo: codigoIGU,
          fuente: 'inac',
          precio: precio,
          unidad: 'USD/kg',
          volumen: null,  // INAC publica promedio ponderado, sin volumen individual
          observaciones: `INAC serie semanal - ${headers[idx]} (4ta balanza)`
        });
      }
    });

    console.log(`  ✓ ${resultados.length} categorías extraídas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio} USD/kg`);
    });

    logScraping(db, 'inac', 'success', resultados.length, null, Date.now() - startTime, fechaISO);

  } catch (err) {
    console.error('  ✗ INAC error:', err.message);
    logScraping(db, 'inac', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
}

// Función para parsear fechas que pueden venir en varios formatos
function parsearFechaExcel(valor) {
  if (!valor) return null;

  // Si ya es un objeto Date
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    return valor;
  }

  // Si es un string, intentar varios formatos
  if (typeof valor === 'string') {
    // Formato DD/MM/YYYY
    const matchDDMMYYYY = valor.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
    if (matchDDMMYYYY) {
      const [_, d, m, y] = matchDDMMYYYY;
      return new Date(parseInt(y), parseInt(m) - 1, parseInt(d));
    }

    // Formato YYYY-MM-DD
    const matchYYYYMMDD = valor.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (matchYYYYMMDD) {
      return new Date(valor);
    }

    // Intentar parseo nativo
    const d = new Date(valor);
    if (!isNaN(d.getTime()) && d.getFullYear() > 2000 && d.getFullYear() < 2100) {
      return d;
    }
  }

  // Si es un número (serial date de Excel)
  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    // Excel serial date: días desde 1900-01-01
    const excelEpoch = new Date(1900, 0, 1);
    const d = new Date(excelEpoch.getTime() + (valor - 2) * 24 * 60 * 60 * 1000);
    return d;
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
