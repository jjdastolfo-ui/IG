// scraper-plazarural.js v2.2
// Scraper de Plaza Rural - remates por pantalla
// URL: https://www.plazarural.com.uy/promedios
//
// CAMBIOS v2.2 (17/4/2026):
// - NUEVO: categoria VP (Vacas/Vaquillonas Preñadas)
// - VP se extrae como USD/cabeza y se CONVIERTE a USD/kg dividiendo por 420 kg
//   para mantener homogeneidad con el resto del indice
//
// METODOLOGIA:
//   TE, VI: peso vivo USD/kg (precio directo)
//   VP: USD/cabeza convertido a USD/kg usando peso estandar 420 kg

const axios = require('axios');
const cheerio = require('cheerio');
const { viernesReferenciaParaScrape } = require('./utils-fecha');

// Peso estandar para convertir VP de USD/cabeza a USD/kg
// Ver: migraciones/002-categoria-vp.sql y constantes_metodologicas
const PESO_ESTANDAR_VP_KG = 420;

const MAPEO_PLAZARURAL = {
  // Ternero (peso vivo)
  'Terneros': 'TE',
  'Terneros entre 140 y 180 kg': 'TE',
  'Terneros - 140 Kg': 'TE',
  'Terneros + 180 kg': 'TE',
  // Vaca de Invernada (peso vivo)
  'Vacas de Invernada': 'VI',
  // Vacas/Vaquillonas Preñadas (USD/cabeza -> convertir a USD/kg)
  'Vientres Preñados': 'VP',
  'Vacas Preñadas': 'VP',
  'Vaquillonas Preñadas': 'VP'
};

const PREFERIDAS_PLAZARURAL = {
  'TE': 'Terneros entre 140 y 180 kg',
  'VI': 'Vacas de Invernada',
  'VP': 'Vientres Preñados'
};

// Categorias que Plaza Rural publica en USD/cabeza (a convertir)
const CATEGORIAS_POR_CABEZA = ['VP'];

// Helper de retry con backoff exponencial
async function fetchConRetry(fetchFn, descripcion, intentos = 3) {
  const esperas = [0, 2000, 5000];
  let ultimoError;
  for (let i = 0; i < intentos; i++) {
    if (esperas[i] > 0) {
      console.log(`  ⏳ Reintentando ${descripcion} (${i + 1}/${intentos})...`);
      await new Promise(r => setTimeout(r, esperas[i]));
    }
    try {
      return await fetchFn();
    } catch (err) {
      ultimoError = err;
      if (i < intentos - 1) {
        console.log(`  ⚠️  ${descripcion} fallo: ${err.message}`);
      }
    }
  }
  throw new Error(`${descripcion} fallo tras ${intentos} intentos: ${ultimoError.message}`);
}

async function scrapePlazaRural(db) {
  const startTime = Date.now();
  const resultados = [];
  const fechaReferencia = viernesReferenciaParaScrape(db);

  // Intentar obtener peso estandar desde DB (por si cambio)
  let pesoVP = PESO_ESTANDAR_VP_KG;
  try {
    const row = db.prepare(`SELECT valor FROM constantes_metodologicas WHERE clave = 'peso_estandar_vp'`).get();
    if (row && row.valor) pesoVP = row.valor;
  } catch (e) { /* tabla puede no existir aun */ }

  try {
    console.log(`→ Plaza Rural (TE/VI/VP): descargando... (fecha ref: ${fechaReferencia}, peso VP: ${pesoVP} kg)`);

    const response = await fetchConRetry(
      () => axios.get('https://www.plazarural.com.uy/promedios', {
        timeout: 20000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Scraper/1.0)' }
      }),
      'Plaza Rural'
    );

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
      const promTexto = $(cells[5]).text().trim();
      const pctVentas = parseFloat($(cells[7]).text().trim().replace(',', '.')) || 0;

      if (!promTexto || cabezas === 0) return;
      if (categoriaTexto.includes('Pieza') || categoriaTexto.includes('Entorad')) return;

      const codigoIGU = MAPEO_PLAZARURAL[categoriaTexto];
      if (!codigoIGU) return;

      const esPorCabeza = CATEGORIAS_POR_CABEZA.includes(codigoIGU);
      let precioRaw;
      let precioFinal;
      let observacionExtra = '';

      if (esPorCabeza) {
        // Plaza Rural muestra preñadas como "1247.42" = 1247.42 USD/cabeza
        // IMPORTANTE: Plaza Rural usa formato anglosajon (punto como decimal, sin
        // separador de miles). parseFloat directo funciona bien.
        // Solo reemplazar coma por punto si la pagina llegara a cambiar el formato.
        precioRaw = parseFloat(promTexto.replace(',', '.'));
        if (isNaN(precioRaw) || precioRaw < 100 || precioRaw > 5000) return;
        // Convertir a USD/kg equivalente
        precioFinal = parseFloat((precioRaw / pesoVP).toFixed(4));
        observacionExtra = ` | USD ${precioRaw.toFixed(2)}/cabeza ÷ ${pesoVP} kg = ${precioFinal.toFixed(4)} USD/kg`;
      } else {
        // USD/kg vivo directo
        precioFinal = parseFloat(promTexto.replace(',', '.'));
        if (isNaN(precioFinal) || precioFinal <= 0 || precioFinal > 20) return;
        precioRaw = precioFinal;
      }

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
        precio: precioFinal,
        unidad: 'USD/kg',  // Todas normalizadas a USD/kg
        volumen: cabezas,
        observaciones: `Plaza Rural remate ${nroRemate} - ${categoriaTexto} (${pctVentas}% venta)${observacionExtra}`
      });

      categoriasProcesadas.add(codigoIGU);
    });

    console.log(`  ✓ ${resultados.length} categorias extraidas:`);
    resultados.forEach(r => {
      console.log(`    ${r.categoria_codigo}: ${r.precio.toFixed(4)} USD/kg (${r.volumen} cabezas)`);
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

module.exports = { scrapePlazaRural, MAPEO_PLAZARURAL, PESO_ESTANDAR_VP_KG };
