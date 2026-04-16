// scraper-plazarural.js
// Scraper de Plaza Rural - promedios del último remate
// URL: https://www.plazarural.com.uy/promedios
// Estructura: tabla HTML con columnas Categoría | Cabezas | Lotes | Máx | Mín | Prom | Prom Bulto | % Ventas

const axios = require('axios');
const cheerio = require('cheerio');

// Mapeo de categorías de Plaza Rural a códigos IGU
const MAPEO_PLAZARURAL = {
  'Novillos 2-3 años': 'NG',      // Novillo Gordo
  'Novillos + 3 años': 'NG',      // Novillo Gordo (pesado)
  'Vacas de Invernada': 'VI',     // Vaca Invernada
  'Terneros': 'TE',                // Ternero
  'Terneros entre 140 y 180 kg': 'TE',  // Ternero (tamaño estándar IGU)
  'Terneros - 140 Kg': 'TE',
  'Terneros + 180 kg': 'TE',
  'Vaquillonas 1-2 años': 'VQ',   // Vaquillona
  'Vaquillonas + 2 años': 'VQ',
  // Nota: Plaza Rural no vende Vaca Gorda (VG) en sus remates,
  // esa categoría viene de INAC
};

// Categorías que son "preferidas" cuando hay múltiples opciones
const PREFERIDAS_PLAZARURAL = {
  'TE': 'Terneros entre 140 y 180 kg',    // Tamaño estándar de la metodología IGU
  'NG': 'Novillos 2-3 años',              // Peso típico de novillo gordo 480-520 kg
  'VI': 'Vacas de Invernada',
  'VQ': 'Vaquillonas 1-2 años'            // Peso típico 220-280 kg
};

async function scrapePlazaRural(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaHoy = new Date().toISOString().split('T')[0];

  try {
    console.log('→ Plaza Rural: descargando promedios...');

    const response = await axios.get('https://www.plazarural.com.uy/promedios', {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0; +https://indicegandero.uy)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const $ = cheerio.load(response.data);

    // Extraer número de remate del título
    const titulo = $('h2').text().trim();
    const matchRemate = titulo.match(/REMATE\s*(\d+)/i);
    const nroRemate = matchRemate ? matchRemate[1] : 'desconocido';
    console.log(`  Remate detectado: ${nroRemate}`);

    // La tabla de promedios tiene estructura:
    // Categoría | Cabezas | Lotes | Máx | Mín | Prom | Prom Bulto | % Ventas
    const categoriasProcesadas = new Set();

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 7) return;  // No es una fila de datos

      const categoriaTexto = $(cells[0]).text().trim();
      const cabezas = parseInt($(cells[1]).text().trim().replace(/\D/g, '')) || 0;
      const prom = parseFloat($(cells[5]).text().trim().replace(',', '.'));
      const pctVentas = parseFloat($(cells[7]).text().trim().replace(',', '.')) || 0;

      // Ignorar si no hay precio válido o no se vendió
      if (isNaN(prom) || prom <= 0 || cabezas === 0) return;

      // Los vientres preñados/entorados se venden "por bulto" (precio por animal)
      // y no aplican para el IGU que usa USD/kg
      if (categoriaTexto.includes('Vientre') || categoriaTexto.includes('Pieza')) return;

      const codigoIGU = MAPEO_PLAZARURAL[categoriaTexto];
      if (!codigoIGU) return;  // Categoría no mapeada

      // Si ya procesamos esta categoría IGU, preferir la "estándar" según metodología
      const preferida = PREFERIDAS_PLAZARURAL[codigoIGU];
      if (categoriasProcesadas.has(codigoIGU)) {
        // Solo sobreescribir si la nueva es la preferida
        if (categoriaTexto !== preferida) return;
        // Remover la anterior del array
        const idxAnterior = resultados.findIndex(r => r.categoria_codigo === codigoIGU);
        if (idxAnterior >= 0) resultados.splice(idxAnterior, 1);
      }

      resultados.push({
        fecha: fechaHoy,
        categoria_codigo: codigoIGU,
        fuente: 'plaza_rural',
        precio: prom,
        unidad: 'USD/kg',
        volumen: cabezas,
        observaciones: `Plaza Rural remate ${nroRemate} - ${categoriaTexto} (${pctVentas}% venta)`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorías extraídas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio} USD/kg (${r.volumen} cabezas)`);
    });

    logScraping(db, 'plaza_rural', 'success', resultados.length, null, Date.now() - startTime,
                `Remate ${nroRemate}`);

  } catch (err) {
    console.error('  ✗ Plaza Rural error:', err.message);
    logScraping(db, 'plaza_rural', 'error', 0, err.message, Date.now() - startTime);
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

module.exports = { scrapePlazaRural, MAPEO_PLAZARURAL };
