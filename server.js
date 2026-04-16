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

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ============================================================================
// NÚCLEO: Cálculo del Índice Ganadero Uruguayo (IGU)
// Fórmula Laspeyres con ponderaciones fijas
// ============================================================================

function calcularPromedioPonderadoDiario(fecha) {
  // Agrupar precios raw del día por categoría, ponderados por volumen
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

  // Guardar promedios diarios
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
  // 1. Obtener promedios del día
  let promedios = db.prepare(`
    SELECT categoria_codigo, precio_promedio
    FROM precios_promedio_diario
    WHERE fecha = ?
  `).all(fecha);

  // Si no hay promedios calculados aún, calcularlos
  if (promedios.length === 0) {
    calcularPromedioPonderadoDiario(fecha);
    promedios = db.prepare(`
      SELECT categoria_codigo, precio_promedio
      FROM precios_promedio_diario
      WHERE fecha = ?
    `).all(fecha);
  }

  if (promedios.length === 0) {
    console.log(`⚠ Sin datos para ${fecha}. Intentando imputación con día anterior...`);
    // Imputación: usar precio del día hábil anterior (manejo de feriados/fines de semana)
    const ultimoDia = db.prepare(`
      SELECT fecha FROM precios_promedio_diario
      WHERE fecha < ? ORDER BY fecha DESC LIMIT 1
    `).get(fecha);

    if (!ultimoDia) {
      return { error: 'No hay datos históricos suficientes para calcular el índice' };
    }
    promedios = db.prepare(`
      SELECT categoria_codigo, precio_promedio
      FROM precios_promedio_diario
      WHERE fecha = ?
    `).all(ultimoDia.fecha);
  }

  // 2. Obtener ponderaciones y bases
  const categorias = db.prepare(`
    SELECT c.codigo, c.ponderacion, b.precio_base, b.cantidad_base
    FROM categorias c
    JOIN base_index b ON c.codigo = b.categoria_codigo
    WHERE c.activo = 1
  `).all();

  // 3. Calcular IGU general (Laspeyres)
  // IGU_t = Σ(Pt_i × Q0_i × W_i) / Σ(P0_i × Q0_i × W_i) × 100
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

  // 4. Calcular sub-índices
  const subIndices = {
    sub_carne: calcularSubIndice(['NG', 'VG'], promedios, categorias),
    sub_reposicion: calcularSubIndice(['TE', 'VQ'], promedios, categorias),
    sub_cria: calcularSubIndice(['VI'], promedios, categorias)
  };

  // 5. Calcular variaciones
  const variaciones = calcularVariaciones(fecha, iguGeneral);

  // 6. Persistir en tabla indice
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

    // Renormalizar ponderación dentro del sub-índice
    const pondNormalizada = cat.ponderacion / pondTotal;
    num += precio.precio_promedio * cat.cantidad_base * pondNormalizada;
    den += cat.precio_base * cat.cantidad_base * pondNormalizada;
  });

  return den > 0 ? (num / den) * 100 : null;
}

function calcularVariaciones(fecha, iguActual) {
  const fechaDate = new Date(fecha);

  // Día anterior (hábil)
  const ayer = db.prepare(`
    SELECT igu_general FROM indice
    WHERE fecha < ? ORDER BY fecha DESC LIMIT 1
  `).get(fecha);

  // Hace 30 días
  const haceMes = new Date(fechaDate);
  haceMes.setDate(haceMes.getDate() - 30);
  const mesAtras = db.prepare(`
    SELECT igu_general FROM indice
    WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1
  `).get(haceMes.toISOString().split('T')[0]);

  // Hace 365 días
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

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IGU API', timestamp: new Date().toISOString() });
});

// GET /api/indice/actual - Último valor del IGU
app.get('/api/indice/actual', (req, res) => {
  const ultimo = db.prepare(`
    SELECT * FROM indice ORDER BY fecha DESC LIMIT 1
  `).get();

  if (!ultimo) return res.json({ error: 'Sin datos aún' });
  res.json(ultimo);
});

// GET /api/indice/historico?desde=2024-01-01&hasta=2025-12-31
app.get('/api/indice/historico', (req, res) => {
  const { desde = '2020-01-01', hasta = new Date().toISOString().split('T')[0] } = req.query;
  const historico = db.prepare(`
    SELECT * FROM indice
    WHERE fecha BETWEEN ? AND ?
    ORDER BY fecha ASC
  `).all(desde, hasta);
  res.json(historico);
});

// GET /api/indice/:fecha - IGU de un día específico
app.get('/api/indice/:fecha', (req, res) => {
  const registro = db.prepare(`SELECT * FROM indice WHERE fecha = ?`).get(req.params.fecha);
  if (!registro) return res.status(404).json({ error: 'Fecha sin datos' });
  res.json(registro);
});

// GET /api/categorias - Lista de categorías con ponderaciones
app.get('/api/categorias', (req, res) => {
  const cats = db.prepare(`
    SELECT c.*, b.precio_base, b.fecha_base
    FROM categorias c
    LEFT JOIN base_index b ON c.codigo = b.categoria_codigo
    WHERE c.activo = 1
  `).all();
  res.json(cats);
});

// GET /api/precios/:fecha - Precios promedio de un día
app.get('/api/precios/:fecha', (req, res) => {
  const precios = db.prepare(`
    SELECT p.*, c.nombre, c.ponderacion
    FROM precios_promedio_diario p
    JOIN categorias c ON p.categoria_codigo = c.codigo
    WHERE p.fecha = ?
  `).all(req.params.fecha);
  res.json(precios);
});

// GET /api/precios/raw/:fecha - Observaciones raw de un día (auditable)
app.get('/api/precios/raw/:fecha', (req, res) => {
  const raws = db.prepare(`
    SELECT * FROM precios_raw WHERE fecha = ? ORDER BY categoria_codigo, fuente
  `).all(req.params.fecha);
  res.json(raws);
});

// POST /api/precios - Cargar precio manualmente
app.post('/api/precios', (req, res) => {
  const { fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones } = req.body;

  if (!fecha || !categoria_codigo || !fuente || !precio) {
    return res.status(400).json({ error: 'Faltan campos requeridos' });
  }

  const result = db.prepare(`
    INSERT INTO precios_raw (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(fecha, categoria_codigo, fuente, precio, unidad || 'USD/kg', volumen || null, observaciones || null);

  // Recalcular índice del día automáticamente
  const indiceActualizado = calcularIGU(fecha);

  res.json({
    success: true,
    id: result.lastInsertRowid,
    indice_recalculado: indiceActualizado
  });
});

// POST /api/calcular/:fecha - Forzar recálculo del índice para una fecha
app.post('/api/calcular/:fecha', (req, res) => {
  const resultado = calcularIGU(req.params.fecha);
  res.json(resultado);
});

// POST /api/scrape - Ejecutar scraping manualmente
app.post('/api/scrape', async (req, res) => {
  try {
    const resultado = await scraper.scrapeAll(db);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/stats - Estadísticas generales del sistema
app.get('/api/stats', (req, res) => {
  const stats = {
    total_observaciones: db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n,
    dias_con_indice: db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n,
    primer_registro: db.prepare(`SELECT MIN(fecha) as f FROM indice`).get().f,
    ultimo_registro: db.prepare(`SELECT MAX(fecha) as f FROM indice`).get().f,
    fuentes_activas: db.prepare(`SELECT DISTINCT fuente FROM precios_raw`).all().map(r => r.fuente),
    ultimo_scraping: db.prepare(`SELECT * FROM scraping_log ORDER BY fecha_ejecucion DESC LIMIT 1`).get()
  };
  res.json(stats);
});

// ============================================================================
// CRON JOBS - Ejecución automática
// ============================================================================

// Scraping diario a las 19:00 hs Uruguay (después del cierre de remates)
cron.schedule('0 19 * * 1-5', async () => {
  console.log('🕖 Ejecutando scraping diario...');
  try {
    await scraper.scrapeAll(db);
    const hoy = new Date().toISOString().split('T')[0];
    calcularIGU(hoy);
    console.log('✓ Scraping + cálculo IGU completado');
  } catch (err) {
    console.error('✗ Error en scraping automático:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// Cálculo diario del índice a las 20:00 hs (por si faltó scraping)
cron.schedule('0 20 * * 1-5', () => {
  const hoy = new Date().toISOString().split('T')[0];
  console.log(`🧮 Recalculando IGU para ${hoy}...`);
  try {
    const resultado = calcularIGU(hoy);
    console.log(`✓ IGU ${hoy}:`, resultado.igu_general?.toFixed(2));
  } catch (err) {
    console.error('✗ Error en cálculo:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// ============================================================================
// Arranque del servidor
// ============================================================================

app.listen(PORT, () => {
  console.log('━'.repeat(60));
  console.log(`🐂 Índice Ganadero Uruguayo (IGU) - Servidor activo`);
  console.log(`📡 Puerto: ${PORT}`);
  console.log(`💾 Base de datos: ${DB_PATH}`);
  console.log(`🌐 Dashboard: http://localhost:${PORT}`);
  console.log(`📊 API: http://localhost:${PORT}/api/indice/actual`);
  console.log('━'.repeat(60));
});

module.exports = { app, calcularIGU, calcularPromedioPonderadoDiario };
