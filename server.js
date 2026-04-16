// server.js
// Servidor principal del Índice Ganadero Uruguayo (IGU)
// Stack: Node.js + Express + SQLite

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const scraper = require('./scraper');
const adminInit = require('./admin-init');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// Activar endpoints de administracion (init-db desde navegador)
adminInit(app, db);

// ============================================================================
// NUCLEO: Calculo del Indice Ganadero Uruguayo (IGU)
// ============================================================================

function calcularPromedioPonderadoDiario(fecha) {
  const query = `
    SELECT
      categoria_codigo,
      SUM(precio * COALESCE(volumen, 1)) / SUM(COALESCE(volumen, 1)) AS precio_promedio,
      COUNT(*) AS num_observaciones,
      SUM(COALESCE(volumen, 0)) AS volumen_total,
      GROUP_CONCAT(DISTINCT fuente) AS fuentes
    FROM precios_raw
    WHERE fecha = ?
    GROUP BY categoria_codigo
  `;

  const promedios = db.prepare(query).all(fecha);

  const insertPromedio = db.prepare(`
    INSERT OR REPLACE INTO precios_promedio_diario
    (fecha, categoria_codigo, precio_promedio, num_observaciones, volumen_total, fuentes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  promedios.forEach(p => {
    insertPromedio.run(
      fecha,
      p.categoria_codigo,
      p.precio_promedio,
      p.num_observaciones,
      p.volumen_total,
      p.fuentes
    );
  });

  return promedios;
}

function calcularIGU(fecha) {
  let promedios = db.prepare(`
    SELECT categoria_codigo, precio_promedio
    FROM precios_promedio_diario
    WHERE fecha = ?
  `).all(fecha);

  if (promedios.length === 0) {
    calcularPromedioPonderadoDiario(fecha);
    promedios = db.prepare(`
      SELECT categoria_codigo, precio_promedio
      FROM precios_promedio_diario
      WHERE fecha = ?
    `).all(fecha);
  }

  if (promedios.length === 0) {
    const ultimoDia = db.prepare(`
      SELECT fecha FROM precios_promedio_diario
      WHERE fecha < ? ORDER BY fecha DESC LIMIT 1
    `).get(fecha);

    if (!ultimoDia) {
      return { error: 'No hay datos historicos suficientes para calcular el indice' };
    }
    promedios = db.prepare(`
      SELECT categoria_codigo, precio_promedio
      FROM precios_promedio_diario
      WHERE fecha = ?
    `).all(ultimoDia.fecha);
  }

  const categorias = db.prepare(`
    SELECT c.codigo, c.ponderacion, b.precio_base, b.cantidad_base
    FROM categorias c
    JOIN base_index b ON c.codigo = b.categoria_codigo
    WHERE c.activo = 1
  `).all();

  let numerador = 0;
  let denominador = 0;
  const detallesCategorias = {};

  categorias.forEach(cat => {
    const precioActual = promedios.find(p => p.categoria_codigo === cat.codigo);
    if (!precioActual) return;

    const aporteNum = precioActual.precio_promedio * cat.cantidad_base * cat.ponderacion;
    const aporteDen = cat.precio_base * cat.cantidad_base * cat.ponderacion;

    numerador += aporteNum;
    denominador += aporteDen;

    detallesCategorias[cat.codigo] = {
      precio_actual: precioActual.precio_promedio,
      precio_base: cat.precio_base,
      indice_individual: (precioActual.precio_promedio / cat.precio_base) * 100,
      aporte_ponderado: (aporteNum / aporteDen) * cat.ponderacion * 100
    };
  });

  const iguGeneral = denominador > 0 ? (numerador / denominador) * 100 : null;

  const subIndices = {
    sub_carne: calcularSubIndice(['NG', 'VG'], promedios, categorias),
    sub_reposicion: calcularSubIndice(['TE', 'VQ'], promedios, categorias),
    sub_cria: calcularSubIndice(['VI'], promedios, categorias)
  };

  const variaciones = calcularVariaciones(fecha, iguGeneral);

  db.prepare(`
    INSERT OR REPLACE INTO indice
    (fecha, igu_general, sub_carne, sub_reposicion, sub_cria,
     variacion_diaria, variacion_mensual, variacion_anual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fecha,
    iguGeneral,
    subIndices.sub_carne,
    subIndices.sub_reposicion,
    subIndices.sub_cria,
    variaciones.diaria,
    variaciones.mensual,
    variaciones.anual
  );

  return {
    fecha,
    igu_general: iguGeneral,
    ...subIndices,
    variaciones,
    detalles_categorias: detallesCategorias
  };
}

function calcularSubIndice(codigos, promedios, categorias) {
  let num = 0, den = 0;
  const pondTotal = categorias
    .filter(c => codigos.includes(c.codigo))
    .reduce((s, c) => s + c.ponderacion, 0);

  codigos.forEach(codigo => {
    const cat = categorias.find(c => c.codigo === codigo);
    const precio = promedios.find(p => p.categoria_codigo === codigo);
    if (!cat || !precio) return;

    const pondNormalizada = cat.ponderacion / pondTotal;
    num += precio.precio_promedio * cat.cantidad_base * pondNormalizada;
    den += cat.precio_base * cat.cantidad_base * pondNormalizada;
  });

  return den > 0 ? (num / den) * 100 : null;
}

function calcularVariaciones(fecha, iguActual) {
  const fechaDate = new Date(fecha);

  const ayer = db.prepare(`
    SELECT igu_general FROM indice
    WHERE fecha < ? ORDER BY fecha DESC LIMIT 1
  `).get(fecha);

  const haceMes = new Date(fechaDate);
  haceMes.setDate(haceMes.getDate() - 30);
  const mesAtras = db.prepare(`
    SELECT igu_general FROM indice
    WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1
  `).get(haceMes.toISOString().split('T')[0]);

  const haceAnio = new Date(fechaDate);
  haceAnio.setDate(haceAnio.getDate() - 365);
  const anioAtras = db.prepare(`
    SELECT igu_general FROM indice
    WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1
  `).get(haceAnio.toISOString().split('T')[0]);

  return {
    diaria: ayer ? ((iguActual - ayer.igu_general) / ayer.igu_general) * 100 : null,
    mensual: mesAtras ? ((iguActual - mesAtras.igu_general) / mesAtras.igu_general) * 100 : null,
    anual: anioAtras ? ((iguActual - anioAtras.igu_general) / anioAtras.igu_general) * 100 : null
  };
}

// ============================================================================
// API REST
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IGU API', timestamp: new Date().toISOString() });
});

app.get('/api/indice/actual', (req, res) => {
  try {
    const ultimo = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();
    if (!ultimo) return res.json({ error: 'Sin datos aun' });
    res.json(ultimo);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indice/historico', (req, res) => {
  try {
    const { desde = '2020-01-01', hasta = new Date().toISOString().split('T')[0] } = req.query;
    const historico = db.prepare(`
      SELECT * FROM indice
      WHERE fecha BETWEEN ? AND ?
      ORDER BY fecha ASC
    `).all(desde, hasta);
    res.json(historico);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/indice/:fecha', (req, res) => {
  try {
    const registro = db.prepare(`SELECT * FROM indice WHERE fecha = ?`).get(req.params.fecha);
    if (!registro) return res.status(404).json({ error: 'Fecha sin datos' });
    res.json(registro);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/categorias', (req, res) => {
  try {
    const cats = db.prepare(`
      SELECT c.*, b.precio_base, b.fecha_base
      FROM categorias c
      LEFT JOIN base_index b ON c.codigo = b.categoria_codigo
      WHERE c.activo = 1
    `).all();
    res.json(cats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/precios/:fecha', (req, res) => {
  try {
    const precios = db.prepare(`
      SELECT p.*, c.nombre, c.ponderacion
      FROM precios_promedio_diario p
      JOIN categorias c ON p.categoria_codigo = c.codigo
      WHERE p.fecha = ?
    `).all(req.params.fecha);
    res.json(precios);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/precios/raw/:fecha', (req, res) => {
  try {
    const raws = db.prepare(`
      SELECT * FROM precios_raw WHERE fecha = ? ORDER BY categoria_codigo, fuente
    `).all(req.params.fecha);
    res.json(raws);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/precios', (req, res) => {
  try {
    const { fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones } = req.body;

    if (!fecha || !categoria_codigo || !fuente || !precio) {
      return res.status(400).json({ error: 'Faltan campos requeridos' });
    }

    const result = db.prepare(`
      INSERT INTO precios_raw (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(fecha, categoria_codigo, fuente, precio, unidad || 'USD/kg', volumen || null, observaciones || null);

    const indiceActualizado = calcularIGU(fecha);

    res.json({
      success: true,
      id: result.lastInsertRowid,
      indice_recalculado: indiceActualizado
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calcular/:fecha', (req, res) => {
  try {
    const resultado = calcularIGU(req.params.fecha);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/scrape', async (req, res) => {
  try {
    const resultado = await scraper.scrapeAll(db);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      total_observaciones: db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n,
      dias_con_indice: db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n,
      primer_registro: db.prepare(`SELECT MIN(fecha) as f FROM indice`).get().f,
      ultimo_registro: db.prepare(`SELECT MAX(fecha) as f FROM indice`).get().f,
      fuentes_activas: db.prepare(`SELECT DISTINCT fuente FROM precios_raw`).all().map(r => r.fuente),
      ultimo_scraping: db.prepare(`SELECT * FROM scraping_log ORDER BY fecha_ejecucion DESC LIMIT 1`).get()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({
      error: 'Base de datos no inicializada. Ejecutar /admin/init-db?secret=IGU_INIT_2026 primero.',
      detalle: err.message
    });
  }
});

// ============================================================================
// CRON JOBS
// ============================================================================

cron.schedule('0 19 * * 1-5', async () => {
  console.log('Ejecutando scraping diario...');
  try {
    await scraper.scrapeAll(db);
    const hoy = new Date().toISOString().split('T')[0];
    calcularIGU(hoy);
    console.log('Scraping + calculo IGU completado');
  } catch (err) {
    console.error('Error en scraping automatico:', err.message);
  }
}, { timezone: 'America/Montevideo' });

cron.schedule('0 20 * * 1-5', () => {
  const hoy = new Date().toISOString().split('T')[0];
  console.log(`Recalculando IGU para ${hoy}...`);
  try {
    const resultado = calcularIGU(hoy);
    console.log(`IGU ${hoy}:`, resultado.igu_general?.toFixed(2));
  } catch (err) {
    console.error('Error en calculo:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// ============================================================================
// Arranque del servidor
// ============================================================================

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('IGU - Indice Ganadero Uruguayo - Servidor activo');
  console.log(`Puerto: ${PORT}`);
  console.log(`Base de datos: ${DB_PATH}`);
  console.log(`Dashboard: http://localhost:${PORT}`);
  console.log(`API: http://localhost:${PORT}/api/indice/actual`);
  console.log('='.repeat(60));
});

module.exports = { app, calcularIGU, calcularPromedioPonderadoDiario };
