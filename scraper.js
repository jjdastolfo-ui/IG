// scraper.js
// Módulo de scraping para fuentes de precios ganaderos uruguayos
//
// Fuentes soportadas:
// - Plaza Rural (remates de ganado)
// - ACG (Asociación de Consignatarios de Ganado)
// - INAC (precios kg carne equivalente)
// - Pantalla Uruguay
//
// NOTA: Los selectores CSS y endpoints deben ajustarse al HTML real de cada sitio.
// Este módulo está diseñado para ser robusto ante cambios - cada fuente es independiente
// y los errores no bloquean al resto.

const axios = require('axios');
const cheerio = require('cheerio');

// ============================================================================
// Configuración de fuentes
// ============================================================================

const FUENTES = {
  plaza_rural: {
    nombre: 'Plaza Rural',
    url: 'https://www.plazarural.com.uy/remates/resultados', // Ajustar al endpoint real
    activo: true
  },
  acg: {
    nombre: 'ACG',
    url: 'https://www.acg.com.uy/precios-referencia', // Ajustar al endpoint real
    activo: true
  },
  inac: {
    nombre: 'INAC',
    url: 'https://www.inac.uy/innovaportal/v/20134/10/innova.front/precios-semanales', // Ajustar
    activo: true
  },
  pantalla_uruguay: {
    nombre: 'Pantalla Uruguay',
    url: 'https://www.pantallauruguay.com.uy/remates', // Ajustar al endpoint real
    activo: false // Activar cuando se defina selector
  }
};

// Mapeo de nombres de categorías a códigos IGU
const MAPEO_CATEGORIAS = {
  'novillo': 'NG',
  'novillo gordo': 'NG',
  'novillo pesado': 'NG',
  'novillo faena': 'NG',
  'vaca gorda': 'VG',
  'vaca faena': 'VG',
  'vaca': 'VG',
  'ternero': 'TE',
  'ternero macho': 'TE',
  'terneros': 'TE',
  'vaquillona': 'VQ',
  'vaquillona reposición': 'VQ',
  'vaquillonas': 'VQ',
  'vaca invernada': 'VI',
  'vaca de invernada': 'VI',
  'vaca preñada': 'VI'
};

function mapearCategoria(texto) {
  const lower = texto.toLowerCase().trim();
  for (const [key, codigo] of Object.entries(MAPEO_CATEGORIAS)) {
    if (lower.includes(key)) return codigo;
  }
  return null;
}

// ============================================================================
// Scraper: Plaza Rural
// ============================================================================

async function scrapePlazaRural(db) {
  const startTime = Date.now();
  const resultados = [];

  try {
    const response = await axios.get(FUENTES.plaza_rural.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IGU-Scraper/1.0 (Indice Ganadero Uruguayo)' }
    });

    const $ = cheerio.load(response.data);
    const fechaHoy = new Date().toISOString().split('T')[0];

    // TODO: Ajustar selectores al HTML real de Plaza Rural
    // Estructura placeholder - reemplazar con selectores reales:
    $('.resultado-remate, .precio-categoria, table.precios tr').each((i, el) => {
      const categoriaTexto = $(el).find('.categoria, td:nth-child(1)').text().trim();
      const precioTexto = $(el).find('.precio, td:nth-child(2)').text().trim();
      const volumenTexto = $(el).find('.cabezas, td:nth-child(3)').text().trim();

      const codigo = mapearCategoria(categoriaTexto);
      const precio = parseFloat(precioTexto.replace(/[^\d.,]/g, '').replace(',', '.'));
      const volumen = parseInt(volumenTexto.replace(/\D/g, '')) || null;

      if (codigo && !isNaN(precio) && precio > 0) {
        resultados.push({
          fecha: fechaHoy,
          categoria_codigo: codigo,
          fuente: 'plaza_rural',
          precio,
          volumen,
          observaciones: categoriaTexto
        });
      }
    });

    logScraping(db, 'plaza_rural', 'success', resultados.length, null, Date.now() - startTime);
  } catch (err) {
    console.error('✗ Plaza Rural error:', err.message);
    logScraping(db, 'plaza_rural', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
}

// ============================================================================
// Scraper: ACG
// ============================================================================

async function scrapeACG(db) {
  const startTime = Date.now();
  const resultados = [];

  try {
    const response = await axios.get(FUENTES.acg.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IGU-Scraper/1.0' }
    });

    const $ = cheerio.load(response.data);
    const fechaHoy = new Date().toISOString().split('T')[0];

    // TODO: Ajustar selectores reales
    $('table.precios-referencia tr, .tabla-precios tr').each((i, el) => {
      const categoriaTexto = $(el).find('td:nth-child(1)').text().trim();
      const precioTexto = $(el).find('td:nth-child(2)').text().trim();

      const codigo = mapearCategoria(categoriaTexto);
      const precio = parseFloat(precioTexto.replace(/[^\d.,]/g, '').replace(',', '.'));

      if (codigo && !isNaN(precio) && precio > 0) {
        resultados.push({
          fecha: fechaHoy,
          categoria_codigo: codigo,
          fuente: 'acg',
          precio,
          volumen: null,
          observaciones: `Precio referencia ACG - ${categoriaTexto}`
        });
      }
    });

    logScraping(db, 'acg', 'success', resultados.length, null, Date.now() - startTime);
  } catch (err) {
    console.error('✗ ACG error:', err.message);
    logScraping(db, 'acg', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
}

// ============================================================================
// Scraper: INAC (precio kg carne equivalente)
// ============================================================================

async function scrapeINAC(db) {
  const startTime = Date.now();
  const resultados = [];

  try {
    const response = await axios.get(FUENTES.inac.url, {
      timeout: 15000,
      headers: { 'User-Agent': 'IGU-Scraper/1.0' }
    });

    const $ = cheerio.load(response.data);
    const fechaHoy = new Date().toISOString().split('T')[0];

    // INAC publica precios promedios semanales kg carne equivalente
    // TODO: Ajustar selectores al estructura real
    $('.precios-semanales tr, table.precios tr').each((i, el) => {
      const categoriaTexto = $(el).find('td:nth-child(1)').text().trim();
      const precioTexto = $(el).find('td:nth-child(2)').text().trim();

      const codigo = mapearCategoria(categoriaTexto);
      const precio = parseFloat(precioTexto.replace(/[^\d.,]/g, '').replace(',', '.'));

      if (codigo && !isNaN(precio) && precio > 0) {
        resultados.push({
          fecha: fechaHoy,
          categoria_codigo: codigo,
          fuente: 'inac',
          precio,
          volumen: null,
          observaciones: `INAC kg carne equivalente - ${categoriaTexto}`
        });
      }
    });

    logScraping(db, 'inac', 'success', resultados.length, null, Date.now() - startTime);
  } catch (err) {
    console.error('✗ INAC error:', err.message);
    logScraping(db, 'inac', 'error', 0, err.message, Date.now() - startTime);
  }

  return resultados;
}

// ============================================================================
// Utilidades
// ============================================================================

function logScraping(db, fuente, status, registros, errorMsg, duracionMs) {
  db.prepare(`
    INSERT INTO scraping_log (fuente, status, registros_obtenidos, error_msg, duracion_ms)
    VALUES (?, ?, ?, ?, ?)
  `).run(fuente, status, registros, errorMsg, duracionMs);
}

function guardarResultados(db, resultados) {
  const insert = db.prepare(`
    INSERT INTO precios_raw
    (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const transaction = db.transaction((items) => {
    items.forEach(r => {
      insert.run(
        r.fecha,
        r.categoria_codigo,
        r.fuente,
        r.precio,
        r.unidad || 'USD/kg',
        r.volumen,
        r.observaciones
      );
    });
  });

  transaction(resultados);
}

// ============================================================================
// Orquestador
// ============================================================================

async function scrapeAll(db) {
  console.log('🔄 Iniciando scraping de todas las fuentes...');
  const startTime = Date.now();

  const resultados = {
    plaza_rural: [],
    acg: [],
    inac: []
  };

  // Ejecutar en paralelo (más rápido, y si una falla no afecta a las otras)
  if (FUENTES.plaza_rural.activo) {
    resultados.plaza_rural = await scrapePlazaRural(db);
  }
  if (FUENTES.acg.activo) {
    resultados.acg = await scrapeACG(db);
  }
  if (FUENTES.inac.activo) {
    resultados.inac = await scrapeINAC(db);
  }

  // Guardar todos los resultados en la BD
  const todos = [...resultados.plaza_rural, ...resultados.acg, ...resultados.inac];
  if (todos.length > 0) {
    guardarResultados(db, todos);
  }

  const resumen = {
    total_registros: todos.length,
    por_fuente: {
      plaza_rural: resultados.plaza_rural.length,
      acg: resultados.acg.length,
      inac: resultados.inac.length
    },
    duracion_ms: Date.now() - startTime,
    timestamp: new Date().toISOString()
  };

  console.log(`✓ Scraping completo: ${todos.length} registros en ${resumen.duracion_ms}ms`);
  return resumen;
}

module.exports = {
  scrapeAll,
  scrapePlazaRural,
  scrapeACG,
  scrapeINAC,
  FUENTES
};
