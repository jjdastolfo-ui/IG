// scraper-plazarural.js
// Scraper de Plaza Rural - remates por pantalla
// URL: https://www.plazarural.com.uy/promedios
//
// METODOLOGIA: Plaza Rural vende ganado de REPOSICION en PESO VIVO (USD/kg vivo).
// Solo aporta al IGU las categorias TE (Ternero) y VI (Vaca de Invernada).
// No aporta NG, VG ni VQ porque esas son en 4ta balanza (canal) y vienen de INAC.

const axios = require('axios');
const cheerio = require('cheerio');
const { viernesReferenciaParaScrape } = require('./utils-fecha');

// Solo TE y VI - ganado de reposicion en peso vivo
const MAPEO_PLAZARURAL = {
  'Terneros': 'TE',
  'Terneros entre 140 y 180 kg': 'TE',
  'Terneros - 140 Kg': 'TE',
  'Terneros + 180 kg': 'TE',
  'Vacas de Invernada': 'VI'
};

// Categoria preferida cuando hay varias opciones para TE
const PREFERIDAS_PLAZARURAL = {
  'TE': 'Terneros entre 140 y 180 kg',
  'VI': 'Vacas de Invernada'
};

async function scrapePlazaRural(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaReferencia = viernesReferenciaParaScrape(db);

  try {
    console.log(`→ Plaza Rural (peso vivo TE/VI): descargando... (fecha ref: ${fechaReferencia})`);

    const response = await axios.get('https://www.plazarural.com.uy/promedios', {
      timeout: 20000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0)' }
    });

    const $ = cheerio.load(response.data);

    const titulo = $('h2').text().trim();
    const matchRemate = titulo.match(/REMATE\s*(\d+)/i);
    const nroRemate = matchRemate ? matchRemate[1] : 'desconocido';
    console.log(`  Remate detectado: ${nroRemate}`);

    const categoriasProcesadas = new Set();

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 7) return;

      const categoriaTexto = $(cells[0]).text().trim();
      const cabezas = parseInt($(cells[1]).text().trim().replace(/\D/g, '')) || 0;
      const prom = parseFloat($(cells[5]).text().trim().replace(',', '.'));
      const pctVentas = parseFloat($(cells[7]).text().trim().replace(',', '.')) || 0;

      if (isNaN(prom) || prom <= 0 || cabezas === 0) return;
      if (categoriaTexto.includes('Vientre') || categoriaTexto.includes('Pieza')) return;

      const codigoIGU = MAPEO_PLAZARURAL[categoriaTexto];
      if (!codigoIGU) return;  // Si no esta en el mapeo (NG/VG/VQ), ignorar

      const preferida = PREFERIDAS_PLAZARURAL[codigoIGU];
      if (categoriasProcesadas.has(codigoIGU)) {
        if (categoriaTexto !== preferida) return;
        const idxAnterior = resultados.findIndex(r => r.categoria_codigo === codigoIGU);
        if (idxAnterior >= 0) resultados.splice(idxAnterior, 1);
      }

      resultados.push({
        fecha: fechaReferencia,
        categoria_codigo: codigoIGU,
        fuente: 'plaza_rural',
        precio: prom,
        unidad: 'USD/kg_vivo',  // IMPORTANTE: peso vivo, no canal
        volumen: cabezas,
        observaciones: `Plaza Rural remate ${nroRemate} - ${categoriaTexto} (${pctVentas}% venta) - peso vivo`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorías de reposición extraídas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio} USD/kg vivo (${r.volumen} cabezas)`);
    });

    logScraping(db, 'plaza_rural', 'success', resultados.length, null, Date.now() - startTime,
                `Remate ${nroRemate} → ${fechaReferencia}`);

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
