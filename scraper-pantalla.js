// scraper-pantalla.js v2.2
// Scraper de Pantalla Uruguay - remates por pantalla
// URL: https://www.pantallauruguay.com.uy/promedios
//
// CAMBIOS v2.2 (17/4/2026):
// - FIX CRITICO: usa viernesReferenciaParaScrape() igual que Plaza Rural
// - NUEVO: categoria VP convertida de USD/cabeza a USD/kg (÷420 kg)
// - Extraccion de volumen

const axios = require('axios');
const cheerio = require('cheerio');
const { viernesReferenciaParaScrape } = require('./utils-fecha');

const PESO_ESTANDAR_VP_KG = 420;

const MAPEO_PANTALLA = {
  'Terneros': 'TE',
  'Terneros entre 140 y 180 kg': 'TE',
  'Terneros menos 140 kg': 'TE',
  'Terneros más 180 kg': 'TE',
  'Vacas de Invernada': 'VI',
  'Vacas Preñadas': 'VP',
  'Vaquillonas Preñadas': 'VP',
  'Vacas y Vaquillonas Preñadas': 'VP',
  'Vientres Preñados': 'VP'
};

const PREFERIDAS_PANTALLA = {
  'TE': 'Terneros entre 140 y 180 kg',
  'VI': 'Vacas de Invernada',
  'VP': 'Vacas Preñadas'
};

const CATEGORIAS_POR_CABEZA = ['VP'];

function parsearPrecioKg(texto) {
  if (!texto) return NaN;
  const limpio = texto.toString().trim().replace(/\s/g, '');
  if (!limpio) return NaN;
  const num = parseFloat(limpio.replace(',', '.'));
  if (isNaN(num)) return NaN;
  // Pantalla muestra "4.180" = 4.18 USD/kg
  if (num >= 100 && num < 10000) return num / 1000;
  return num;
}

function parsearPrecioCabeza(texto) {
  if (!texto) return NaN;
  // Pantalla Uruguay usa formato europeo consistente:
  //   "1154.000" = 1154 USD/cabeza (puntos son separadores de miles + milesimas)
  //   "4.180"    = 4.18 USD/kg (misma logica, ver parsearPrecioKg)
  // Por eso dividimos por 1000 despues de quitar los puntos.
  const limpio = texto.toString().trim().replace(/\./g, '').replace(',', '.').replace(/[^\d.]/g, '');
  const num = parseFloat(limpio);
  if (isNaN(num)) return NaN;

  // Pantalla multiplica por 1000: "1154.000" llega aqui como 1154000
  // Dividimos por 1000 para obtener USD/cabeza real
  let precioReal;
  if (num >= 100000) {
    precioReal = num / 1000;  // "1154000" -> 1154 USD/cab
  } else {
    precioReal = num;         // defensivo: si viene en formato distinto
  }

  if (precioReal < 100) return NaN;  // descarte rango valido (100 - 5000 USD/cab)
  return precioReal;
}

function parsearCabezas(texto) {
  if (!texto) return 0;
  const limpio = texto.toString().trim().replace(/[^\d]/g, '');
  const num = parseInt(limpio);
  return isNaN(num) ? 0 : num;
}

function detectarColumnaCabezas($, table) {
  const headers = [];
  $(table).find('thead th, tr:first-child td, tr:first-child th').each((i, el) => {
    headers.push($(el).text().trim().toLowerCase());
  });
  for (let i = 0; i < headers.length; i++) {
    if (headers[i].match(/cabeza|cab\.?$|animales|cant\.?|total/i)) return i;
  }
  return 1;
}

async function scrapePantallaUruguay(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaReferencia = viernesReferenciaParaScrape(db);

  let pesoVP = PESO_ESTANDAR_VP_KG;
  try {
    const row = db.prepare(`SELECT valor FROM constantes_metodologicas WHERE clave = 'peso_estandar_vp'`).get();
    if (row && row.valor) pesoVP = row.valor;
  } catch (e) { /* tabla puede no existir aun */ }

  try {
    console.log(`→ Pantalla Uruguay (TE/VI/VP): descargando... (fecha ref: ${fechaReferencia}, peso VP: ${pesoVP} kg)`);

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
    let idxCabezas = -1;

    $('table').each((i, table) => {
      if (idxCabezas !== -1) return;
      const tieneCategorias = $(table).text().match(/Terneros|Vacas de Invernada|Preñad/i);
      if (tieneCategorias) {
        idxCabezas = detectarColumnaCabezas($, table);
        tablaEncontrada = true;
      }
    });

    if (!tablaEncontrada) throw new Error('No se encontro tabla con categorias ganaderas');

    $('table tr').each((i, row) => {
      const cells = $(row).find('td');
      if (cells.length < 4) return;

      const categoriaTexto = $(cells[0]).text().trim();
      if (!categoriaTexto) return;

      const promTexto = $(cells[3]).text().trim();
      if (!promTexto) return;

      if (categoriaTexto.match(/Piezas?|Entorad/i)) return;
      if (categoriaTexto.match(/Ovinos|Corderos?|Corderas?|Ovejas?|Borregos?|Borregas?|Capones/i)) return;
      if (categoriaTexto.match(/Toros/i)) return;
      if (categoriaTexto.match(/Holando/i)) return;

      const codigoIGU = MAPEO_PANTALLA[categoriaTexto];
      if (!codigoIGU) return;

      const esPorCabeza = CATEGORIAS_POR_CABEZA.includes(codigoIGU);
      let precioRaw, precioFinal, observacionExtra = '';

      if (esPorCabeza) {
        precioRaw = parsearPrecioCabeza(promTexto);
        if (isNaN(precioRaw) || precioRaw < 100 || precioRaw > 5000) return;
        precioFinal = parseFloat((precioRaw / pesoVP).toFixed(4));
        observacionExtra = ` | USD ${precioRaw.toFixed(2)}/cabeza ÷ ${pesoVP} kg = ${precioFinal.toFixed(4)} USD/kg`;
      } else {
        precioFinal = parsearPrecioKg(promTexto);
        if (isNaN(precioFinal) || precioFinal <= 0 || precioFinal > 20) return;
        precioRaw = precioFinal;
      }

      let cabezas = 0;
      // Solo usar cabezas si detectamos explicitamente la columna "Cabezas"
      // (Pantalla Uruguay en /promedios NO tiene esta columna, solo Maximo/Minimo/Prom/Prom.Bulto)
      // Si no hay columna Cabezas, guardar volumen: null en lugar de valores erroneos.
      if (idxCabezas >= 0 && idxCabezas < cells.length) {
        const candidato = parsearCabezas($(cells[idxCabezas]).text());
        // Validar rango razonable: un remate ganadero rara vez tiene >50k cabezas por categoria
        if (candidato > 0 && candidato < 50000) {
          cabezas = candidato;
        }
      }
      // NOTA: se elimina el fallback a columnas [1,2] porque esas son Maximo/Minimo,
      // no cabezas. Preferimos volumen=null y que el server use peso default para INAC.

      const preferida = PREFERIDAS_PANTALLA[codigoIGU];
      // Para VP permitimos acumular multiples subcategorias (Vacas Preñadas + Vaquillonas
      // Preñadas) ya que son dos medidas complementarias del mismo segmento "cria".
      // El server despues hace promedio ponderado por cabezas al calcular el IGU.
      const esAcumulable = codigoIGU === 'VP';

      if (categoriasProcesadas.has(codigoIGU) && !esAcumulable) {
        if (categoriaTexto !== preferida) return;
        const idxAnterior = resultados.findIndex(r => r.categoria_codigo === codigoIGU);
        if (idxAnterior >= 0) resultados.splice(idxAnterior, 1);
      }

      resultados.push({
        fecha: fechaReferencia,
        categoria_codigo: codigoIGU,
        fuente: 'pantalla_uruguay',
        precio: precioFinal,
        unidad: 'USD/kg',
        volumen: cabezas > 0 ? cabezas : null,
        observaciones: `Pantalla Uruguay remate ${nroRemate} - ${categoriaTexto}${cabezas > 0 ? ` (${cabezas} cabezas)` : ''}${observacionExtra}`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorias extraidas:`);
    resultados.forEach(r => {
      const volTxt = r.volumen ? `${r.volumen} cab` : 'SIN VOLUMEN';
      console.log(`    ${r.categoria_codigo}: ${r.precio.toFixed(4)} USD/kg (${volTxt})`);
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

module.exports = { scrapePantallaUruguay, MAPEO_PANTALLA, PESO_ESTANDAR_VP_KG };
