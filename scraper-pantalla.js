// scraper-pantalla.js
// Scraper de Pantalla Uruguay - promedios del último remate
// URL: https://www.pantallauruguay.com.uy/promedios
// Estructura: tabla HTML con columnas Categoría | Máximo | Mínimo | Prom. | Prom. Bulto
//
// NOTA IMPORTANTE sobre formato de precios:
// Pantalla Uruguay muestra los precios USD/kg con formato europeo donde el
// punto es separador de miles. Ejemplo: "4.180" significa 4.18 USD/kg, no 4180.
// Los vientres preñados/entorados tienen precios en miles (ej: 1099) que son USD/animal.

const axios = require('axios');
const cheerio = require('cheerio');

// Mapeo de categorías de Pantalla Uruguay a códigos IGU
const MAPEO_PANTALLA = {
  'Terneros': 'TE',
  'Terneros entre 140 y 180 kg': 'TE',
  'Terneros menos 140 kg': 'TE',
  'Terneros más 180 kg': 'TE',
  'Novillos 2 a 3 años': 'NG',
  'Novillos más de 3 años': 'NG',
  'Vacas de Invernada': 'VI',
  'Vaquillonas sin Servicio 1 a 2 años': 'VQ',
  'Vaquillonas sin Servicio 2 a 3 años': 'VQ'
};

// Categorías preferidas cuando hay múltiples opciones para el mismo código IGU
const PREFERIDAS_PANTALLA = {
  'TE': 'Terneros entre 140 y 180 kg',    // Tamaño estándar metodología IGU
  'NG': 'Novillos 2 a 3 años',            // Peso típico 480-520 kg
  'VI': 'Vacas de Invernada',
  'VQ': 'Vaquillonas sin Servicio 1 a 2 años'  // Peso típico 220-280 kg
};

/**
 * Parsea un precio de Pantalla Uruguay.
 * Formato: "4.180" → 4.18 (punto es separador de miles, divide por 1000)
 * Excepción: precios por animal (vientres) que son grandes (ej: 1099) se dejan como están
 * pero estos no entran al IGU porque no son USD/kg.
 */
function parsearPrecio(texto) {
  if (!texto) return NaN;
  const limpio = texto.toString().trim().replace(/[^\d.,]/g, '');
  if (!limpio) return NaN;

  // Formato Pantalla Uruguay: "4.180" = 4.18 USD/kg
  // Si el número tiene un punto y 3 dígitos después, dividir por 1000
  const match = limpio.match(/^(\d+)\.(\d{3})$/);
  if (match) {
    return parseFloat(`${match[1]}.${match[2]}`) / 1000 * 1000; // Mantiene los decimales
    // En realidad: "4.180" debe interpretarse como 4.180 literal (con punto decimal)
    // Pero si son 4180 como entero sin punto decimal, sería 4.18
  }

  // Reemplazar coma por punto si es separador decimal
  return parseFloat(limpio.replace(',', '.'));
}

/**
 * Parseo robusto considerando el formato específico de Pantalla Uruguay
 * donde "4.180" en la tabla significa 4.18 USD/kg
 */
function parsearPrecioPantalla(texto) {
  if (!texto) return NaN;
  const limpio = texto.toString().trim().replace(/\s/g, '');
  if (!limpio) return NaN;

  // Si contiene punto seguido de 3 dígitos al final, es formato europeo (miles)
  // Ej: "4.180" => 4.18, "1.083" => 1.083 USD/kg (redondeado a 1.08)
  // Realmente el formato es: 4180 = 4.18, 3940 = 3.94, se divide por 1000

  const num = parseFloat(limpio.replace(',', '.'));
  if (isNaN(num)) return NaN;

  // Si el número sin punto es >= 100, seguro que está en formato "miles"
  // Ej: 4180 → 4.18 USD/kg, 3790 → 3.79 USD/kg
  if (num >= 100 && num < 10000) {
    return num / 1000;
  }

  return num;
}

async function scrapePantallaUruguay(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaHoy = new Date().toISOString().split('T')[0];

  try {
    console.log('→ Pantalla Uruguay: descargando promedios...');

    const response = await axios.get('https://www.pantallauruguay.com.uy/promedios', {
      timeout: 20000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0; +https://indicegandero.uy)',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });

    const $ = cheerio.load(response.data);

    // Extraer número y nombre del remate
    // El título aparece como "## 310 Remate Pantalla Uruguay Ganadera Brangus"
    let nroRemate = 'desconocido';
    let nombreRemate = '';
    $('h2').each((i, el) => {
      const texto = $(el).text().trim();
      const match = texto.match(/^(\d+)\s+Remate/i);
      if (match) {
        nroRemate = match[1];
        nombreRemate = texto;
      }
    });
    console.log(`  Remate detectado: ${nroRemate}`);

    // Buscar la tabla de promedios
    // Estructura: Categoría | Máximo | Mínimo | Prom. | Prom. Bulto
    const categoriasProcesadas = new Set();

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const categoriaTexto = $(cells[0]).text().trim();
      if (!categoriaTexto) return;

      // El precio promedio está en la columna "Prom." (índice 3)
      const promTexto = $(cells[3]).text().trim();
      const bultoTexto = $(cells[4])?.text().trim() || '';

      if (!promTexto) return;

      // Filtrar categorías que no son USD/kg (vientres, piezas)
      if (categoriaTexto.match(/Vientres?|Piezas?|Preñad|Entorad/i)) return;
      if (categoriaTexto.match(/Ovinos|Corderos?|Corderas?|Ovejas?|Borregos?|Borregas?|Capones/i)) return;
      if (categoriaTexto.match(/Toros/i)) return;
      if (categoriaTexto.match(/Holando/i)) return;  // Excluir lechería

      const codigoIGU = MAPEO_PANTALLA[categoriaTexto];
      if (!codigoIGU) return;

      const precio = parsearPrecioPantalla(promTexto);
      if (isNaN(precio) || precio <= 0 || precio > 20) return;  // Sanity check

      // Si ya procesamos esta categoría, usar solo la preferida
      const preferida = PREFERIDAS_PANTALLA[codigoIGU];
      if (categoriasProcesadas.has(codigoIGU)) {
        if (categoriaTexto !== preferida) return;
        const idxAnterior = resultados.findIndex(r => r.categoria_codigo === codigoIGU);
        if (idxAnterior >= 0) resultados.splice(idxAnterior, 1);
      }

      // Intentar estimar volumen (cabezas) si está disponible en la página
      // Pantalla Uruguay no muestra cabezas por categoría en la tabla pública,
      // pero sí total de cabezas en el resumen superior
      resultados.push({
        fecha: fechaHoy,
        categoria_codigo: codigoIGU,
        fuente: 'pantalla_uruguay',
        precio: precio,
        unidad: 'USD/kg',
        volumen: null,  // Pantalla no publica cabezas por categoría
        observaciones: `Pantalla Uruguay remate ${nroRemate} - ${categoriaTexto}`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorías extraídas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio.toFixed(2)} USD/kg (${r.observaciones})`);
    });

    logScraping(db, 'pantalla_uruguay', 'success', resultados.length, null,
                Date.now() - startTime, `Remate ${nroRemate}`);

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
