// scraper-pantalla.js v2
// Scraper de Pantalla Uruguay - remates por pantalla
// URL: https://www.pantallauruguay.com.uy/promedios
//
// CAMBIOS v2:
// - Extracción de volumen (cabezas) además del precio
// - Validación de estructura de tabla antes de parsear
// - Alerta si no se encuentra volumen
//
// METODOLOGIA: Pantalla Uruguay vende ganado de REPOSICION en PESO VIVO.
// Solo aporta al IGU las categorias TE (Ternero) y VI (Vaca de Invernada).

const axios = require('axios');
const cheerio = require('cheerio');
const { ultimoViernesHabil } = require('./utils-fecha');

const MAPEO_PANTALLA = {
  'Terneros': 'TE',
  'Terneros entre 140 y 180 kg': 'TE',
  'Terneros menos 140 kg': 'TE',
  'Terneros más 180 kg': 'TE',
  'Vacas de Invernada': 'VI'
};

const PREFERIDAS_PANTALLA = {
  'TE': 'Terneros entre 140 y 180 kg',
  'VI': 'Vacas de Invernada'
};

function parsearPrecioPantalla(texto) {
  if (!texto) return NaN;
  const limpio = texto.toString().trim().replace(/\s/g, '');
  if (!limpio) return NaN;

  const num = parseFloat(limpio.replace(',', '.'));
  if (isNaN(num)) return NaN;

  // Pantalla Uruguay muestra "4.180" que significa 4.18 USD/kg
  if (num >= 100 && num < 10000) {
    return num / 1000;
  }

  return num;
}

/**
 * Parsea cantidad de cabezas de distintos formatos posibles.
 * Ejemplos: "1.234", "1234", "1,234"
 */
function parsearCabezas(texto) {
  if (!texto) return 0;
  const limpio = texto.toString().trim().replace(/[^\d]/g, '');
  const num = parseInt(limpio);
  return isNaN(num) ? 0 : num;
}

/**
 * Detecta qué columna de la tabla contiene las cabezas.
 * Estructura típica de Pantalla Uruguay:
 * [Categoria] [Cabezas] [Mín] [Prom] [Máx] ...
 * Pero puede variar. Buscamos por heurística.
 */
function detectarColumnaCabezas($, table) {
  const headers = [];
  $(table).find('thead th, tr:first-child td, tr:first-child th').each((i, el) => {
    headers.push($(el).text().trim().toLowerCase());
  });

  // Buscar columna con "cabezas", "animales", "cab" o similar
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].match(/cabeza|cab\.?$|animales|cant\.?|total/i)) {
      return i;
    }
  }

  // Fallback: asumir columna 1 (después de categoría)
  return 1;
}

async function scrapePantallaUruguay(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaReferencia = ultimoViernesHabil();

  try {
    console.log(`→ Pantalla Uruguay (peso vivo TE/VI): descargando... (fecha ref: ${fechaReferencia})`);

    const response = await axios.get('https://www.pantallauruguay.com.uy/promedios', {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0)' }
    });

    const $ = cheerio.load(response.data);

    let nroRemate = 'desconocido';
    $('h2').each((i, el) => {
      const texto = $(el).text().trim();
      const match = texto.match(/^(\d+)\s+Remate/i);
      if (match) nroRemate = match[1];
    });
    console.log(`  Remate detectado: ${nroRemate}`);

    const categoriasProcesadas = new Set();
    let tablaEncontrada = false;

    // Detectar columna de cabezas (intento global, primera tabla con categorías)
    let idxCabezas = -1;
    $('table').each((i, table) => {
      if (idxCabezas !== -1) return;
      const tieneCategorias = $(table).text().match(/Terneros|Vacas de Invernada/i);
      if (tieneCategorias) {
        idxCabezas = detectarColumnaCabezas($, table);
        tablaEncontrada = true;
        console.log(`  Tabla detectada, columna cabezas = ${idxCabezas}`);
      }
    });

    if (!tablaEncontrada) {
      throw new Error('No se encontró tabla con categorías de reposición');
    }

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const categoriaTexto = $(cells[0]).text().trim();
      if (!categoriaTexto) return;

      const promTexto = $(cells[3]).text().trim();
      if (!promTexto) return;

      if (categoriaTexto.match(/Vientres?|Piezas?|Preñad|Entorad/i)) return;
      if (categoriaTexto.match(/Ovinos|Corderos?|Corderas?|Ovejas?|Borregos?|Borregas?|Capones/i)) return;
      if (categoriaTexto.match(/Toros/i)) return;
      if (categoriaTexto.match(/Holando/i)) return;

      const codigoIGU = MAPEO_PANTALLA[categoriaTexto];
      if (!codigoIGU) return;

      const precio = parsearPrecioPantalla(promTexto);
      if (isNaN(precio) || precio <= 0 || precio > 20) return;

      // Extraer volumen (cabezas) usando columna detectada
      let cabezas = 0;
      if (idxCabezas >= 0 && idxCabezas < cells.length) {
        cabezas = parsearCabezas($(cells[idxCabezas]).text());
      }

      // Si no encontró cabezas, intentar otras columnas comunes
      if (cabezas === 0) {
        for (const idx of [1, 2]) {
          if (idx < cells.length) {
            const candidato = parsearCabezas($(cells[idx]).text());
            if (candidato > 0 && candidato < 100000) {
              cabezas = candidato;
              break;
            }
          }
        }
      }

      const preferida = PREFERIDAS_PANTALLA[codigoIGU];
      if (categoriasProcesadas.has(codigoIGU)) {
        if (categoriaTexto !== preferida) return;
        const idxAnterior = resultados.findIndex(r => r.categoria_codigo === codigoIGU);
        if (idxAnterior >= 0) resultados.splice(idxAnterior, 1);
      }

      resultados.push({
        fecha: fechaReferencia,
        categoria_codigo: codigoIGU,
        fuente: 'pantalla_uruguay',
        precio: precio,
        unidad: 'USD/kg_vivo',
        volumen: cabezas > 0 ? cabezas : null,
        observaciones: `Pantalla Uruguay remate ${nroRemate} - ${categoriaTexto} - peso vivo${cabezas > 0 ? ` (${cabezas} cabezas)` : ' (SIN VOLUMEN)'}`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorías de reposición extraídas:`);
    resultados.forEach(r => {
      const volTxt = r.volumen ? `${r.volumen} cab` : 'SIN VOLUMEN';
      console.log(`    ${r.categoria_codigo}: ${r.precio.toFixed(2)} USD/kg vivo (${volTxt})`);
    });

    // Alerta si alguna categoría quedó sin volumen
    const sinVolumen = resultados.filter(r => !r.volumen);
    if (sinVolumen.length > 0) {
      console.warn(`  ⚠ ${sinVolumen.length} categoría(s) sin volumen - posible cambio de estructura en página`);
    }

    logScraping(db, 'pantalla_uruguay', 'success', resultados.length, null,
                Date.now() - startTime, `Remate ${nroRemate} → ${fechaReferencia}`);

  } catch (err) {
    console.error('  ✗ Pantalla Uruguay error:', err.message);
    logScraping(db, 'pantalla_uruguay', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
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

module.exports = { scrapePantallaUruguay, MAPEO_PANTALLA };
