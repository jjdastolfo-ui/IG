// scraper-pantalla.js
// Scraper de Pantalla Uruguay - remates por pantalla
// URL: https://www.pantallauruguay.com.uy/promedios
//
// METODOLOGIA: Pantalla Uruguay vende ganado de REPOSICION en PESO VIVO.
// Solo aporta al IGU las categorias TE (Ternero) y VI (Vaca de Invernada).

const axios = require('axios');
const cheerio = require('cheerio');
const { viernesReferenciaParaScrape } = require('./utils-fecha');

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

async function scrapePantallaUruguay(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaReferencia = viernesReferenciaParaScrape(db);

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
        unidad: 'USD/kg_vivo',  // IMPORTANTE: peso vivo
        volumen: null,
        observaciones: `Pantalla Uruguay remate ${nroRemate} - ${categoriaTexto} - peso vivo`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorías de reposición extraídas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio.toFixed(2)} USD/kg vivo`);
    });

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
