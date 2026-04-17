// server.js
// Servidor del Indice Ganadero Uruguayo (IGU)
// BASE: 1.0000 (4 decimales) = viernes 2 de enero 2026
// METODOLOGIA:
//   - NG, VG, VQ: USD/kg en 4ta balanza (canal) - fuente INAC
//   - TE, VI: USD/kg peso vivo - fuente Plaza Rural + Pantalla Uruguay
//   - Ventana de calculo: 14 dias hacia atras desde fecha de referencia
//   - Fecha de referencia: ultimo viernes habil

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const scraper = require('./scraper');
const adminInit = require('./admin-init');
const { ultimoViernesHabil } = require('./utils-fecha');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');
const VENTANA_DIAS = 14;

// ============================================================================
// REDIRECT 301 - DOMINIO CANONICO
// ============================================================================
// igu.uy y www.igu.uy redirigen permanentemente a www.igu.com.uy
// Beneficios: SEO (evita contenido duplicado), branding unificado, analytics
// en un solo lugar.
// ============================================================================

const DOMINIO_CANONICO = 'www.igu.com.uy';

app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();

  // Si viene de igu.uy o www.igu.uy, redirigir al canonico
  if (host === 'igu.uy' || host === 'www.igu.uy') {
    return res.redirect(301, `https://${DOMINIO_CANONICO}${req.url}`);
  }

  // Si viene de igu.com.uy (sin www), redirigir al www
  if (host === 'igu.com.uy') {
    return res.redirect(301, `https://${DOMINIO_CANONICO}${req.url}`);
  }

  next();
});

// ============================================================================
// AUTENTICACION HTTP BASIC - MODO PRIVADO MIENTRAS SE PATENTA LA IP
// ============================================================================
// Se activa solo si la variable de entorno AUTH_ENABLED === 'true'
// Las credenciales vienen de AUTH_USER y AUTH_PASS en Railway
//
// Rutas protegidas: todo salvo /health (para monitoring) y /admin/* (tienen su secret)
// ============================================================================

const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_USER = process.env.AUTH_USER || 'igu';
const AUTH_PASS = process.env.AUTH_PASS || '';

function basicAuthMiddleware(req, res, next) {
  if (!AUTH_ENABLED) return next();

  // Bypass para endpoints internos que no deben requerir auth
  if (req.path === '/health') return next();
  if (req.path.startsWith('/admin/')) return next();  // tienen su propio secret
  if (req.path === '/webhook-interno') return next(); // por si se usa

  // Parsear header Authorization: Basic base64(user:pass)
  const header = req.headers.authorization || '';
  const token = header.split(' ')[1] || '';
  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');

  if (user === AUTH_USER && pass === AUTH_PASS && AUTH_PASS !== '') {
    return next();
  }

  // No autenticado: pedir credenciales
  res.set('WWW-Authenticate', 'Basic realm="IGU - Acceso restringido mientras se protege la IP"');
  res.status(401).send(`
    <html>
      <head>
        <title>IGU - Acceso restringido</title>
        <style>
          body { font-family: Georgia, serif; background: #f5f1e6; color: #2d4a2b;
                 display: flex; align-items: center; justify-content: center;
                 height: 100vh; margin: 0; text-align: center; padding: 2rem; }
          h1 { font-size: 3rem; margin: 0 0 1rem; font-weight: 400; }
          p { font-size: 1rem; color: #6b6b5c; max-width: 500px; line-height: 1.6; }
          .gold { color: #c4914e; font-weight: 600; }
        </style>
      </head>
      <body>
        <div>
          <h1>IGU</h1>
          <p><strong>Acceso restringido temporalmente.</strong></p>
          <p>El <span class="gold">Índice Ganadero Uruguayo</span> está en periodo de protección de propiedad intelectual. Próximamente disponible públicamente.</p>
          <p style="font-size: 0.85rem; margin-top: 2rem; color: #8c8670;">Si tenés credenciales, refrescá e ingresalas en el popup del navegador.</p>
        </div>
      </body>
    </html>
  `);
}

app.use(basicAuthMiddleware);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ============================================================================
// CALCULO DEL IGU CON VENTANA 14 DIAS - BASE 1.0000
// ============================================================================

function calcularIGUVentana(fechaRef) {
  const fechaFin = new Date(fechaRef);
  const fechaInicio = new Date(fechaFin);
  fechaInicio.setDate(fechaInicio.getDate() - VENTANA_DIAS);
  const fechaInicioStr = fechaInicio.toISOString().split('T')[0];

  console.log(`Calculando IGU para ${fechaRef} (ventana ${fechaInicioStr} a ${fechaRef})`);

  // Promedio ponderado por volumen en la ventana
  const query = `
    SELECT
      categoria_codigo,
      SUM(precio * COALESCE(volumen, 100)) / SUM(COALESCE(volumen, 100)) AS precio_promedio,
      COUNT(*) AS num_observaciones,
      SUM(COALESCE(volumen, 0)) AS volumen_total,
      GROUP_CONCAT(DISTINCT fuente) AS fuentes
    FROM precios_raw
    WHERE fecha >= ? AND fecha <= ?
    GROUP BY categoria_codigo
  `;

  const promedios = db.prepare(query).all(fechaInicioStr, fechaRef);

  if (promedios.length === 0) {
    return { error: 'No hay datos en la ventana', fechaRef };
  }

  // Guardar promedios diarios
  const insertPromedio = db.prepare(`
    INSERT OR REPLACE INTO precios_promedio_diario
    (fecha, categoria_codigo, precio_promedio, num_observaciones, volumen_total, fuentes)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  promedios.forEach(p => {
    insertPromedio.run(
      fechaRef, p.categoria_codigo, p.precio_promedio,
      p.num_observaciones, p.volumen_total, p.fuentes
    );
  });

  // Obtener categorias y bases
  const categorias = db.prepare(`
    SELECT c.codigo, c.ponderacion, b.precio_base, b.cantidad_base
    FROM categorias c
    JOIN base_index b ON c.codigo = b.categoria_codigo
    WHERE c.activo = 1
  `).all();

  // Calcular IGU Laspeyres - BASE 1.0000 (sin multiplicar por 100)
  let numerador = 0;
  let denominador = 0;
  const detalles = {};

  categorias.forEach(cat => {
    const precioActual = promedios.find(p => p.categoria_codigo === cat.codigo);
    if (!precioActual) {
      detalles[cat.codigo] = { sin_datos: true, precio_base: cat.precio_base };
      return;
    }

    const aporteNum = precioActual.precio_promedio * cat.cantidad_base * cat.ponderacion;
    const aporteDen = cat.precio_base * cat.cantidad_base * cat.ponderacion;

    numerador += aporteNum;
    denominador += aporteDen;

    detalles[cat.codigo] = {
      precio_actual: precioActual.precio_promedio,
      precio_base: cat.precio_base,
      indice_individual: precioActual.precio_promedio / cat.precio_base,  // BASE 1
      num_observaciones: precioActual.num_observaciones,
      fuentes: precioActual.fuentes
    };
  });

  // IGU en base 1 (no multiplicar por 100)
  const iguGeneral = denominador > 0 ? (numerador / denominador) : null;

  const subIndices = {
    sub_carne: calcularSubIndice(['NG', 'VG'], promedios, categorias),
    sub_reposicion: calcularSubIndice(['TE', 'VQ'], promedios, categorias),
    sub_cria: calcularSubIndice(['VI'], promedios, categorias)
  };

  const variaciones = calcularVariaciones(fechaRef, iguGeneral);

  db.prepare(`
    INSERT OR REPLACE INTO indice
    (fecha, igu_general, sub_carne, sub_reposicion, sub_cria,
     variacion_diaria, variacion_mensual, variacion_anual)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fechaRef, iguGeneral,
    subIndices.sub_carne, subIndices.sub_reposicion, subIndices.sub_cria,
    variaciones.diaria, variaciones.mensual, variaciones.anual
  );

  console.log(`  IGU = ${iguGeneral?.toFixed(4)}`);

  return {
    fecha: fechaRef,
    igu_general: iguGeneral,
    ...subIndices,
    variaciones,
    detalles_categorias: detalles,
    ventana: {
      desde: fechaInicioStr,
      hasta: fechaRef,
      dias: VENTANA_DIAS,
      observaciones_totales: promedios.reduce((s, p) => s + p.num_observaciones, 0)
    }
  };
}

function calcularSubIndice(codigos, promedios, categorias) {
  let num = 0, den = 0;
  const subCats = categorias.filter(c => codigos.includes(c.codigo));
  const pondTotal = subCats.reduce((s, c) => s + c.ponderacion, 0);

  let cuentaCategorias = 0;
  codigos.forEach(codigo => {
    const cat = categorias.find(c => c.codigo === codigo);
    const precio = promedios.find(p => p.categoria_codigo === codigo);
    if (!cat || !precio) return;

    cuentaCategorias++;
    const pondNorm = cat.ponderacion / pondTotal;
    num += precio.precio_promedio * cat.cantidad_base * pondNorm;
    den += cat.precio_base * cat.cantidad_base * pondNorm;
  });

  if (cuentaCategorias === 0) return null;
  // BASE 1 (sin multiplicar por 100)
  return den > 0 ? (num / den) : null;
}

function calcularVariaciones(fecha, iguActual) {
  if (iguActual === null) return { diaria: null, mensual: null, anual: null };

  const fechaDate = new Date(fecha);

  const semanaAnt = new Date(fechaDate);
  semanaAnt.setDate(semanaAnt.getDate() - 7);
  const rSemana = db.prepare(`
    SELECT igu_general FROM indice WHERE fecha <= ? AND fecha < ? ORDER BY fecha DESC LIMIT 1
  `).get(semanaAnt.toISOString().split('T')[0], fecha);

  const haceMes = new Date(fechaDate);
  haceMes.setDate(haceMes.getDate() - 30);
  const rMes = db.prepare(`
    SELECT igu_general FROM indice WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1
  `).get(haceMes.toISOString().split('T')[0]);

  const haceAnio = new Date(fechaDate);
  haceAnio.setDate(haceAnio.getDate() - 365);
  const rAnio = db.prepare(`
    SELECT igu_general FROM indice WHERE fecha <= ? ORDER BY fecha DESC LIMIT 1
  `).get(haceAnio.toISOString().split('T')[0]);

  return {
    diaria: rSemana ? ((iguActual - rSemana.igu_general) / rSemana.igu_general) * 100 : null,
    mensual: rMes ? ((iguActual - rMes.igu_general) / rMes.igu_general) * 100 : null,
    anual: rAnio ? ((iguActual - rAnio.igu_general) / rAnio.igu_general) * 100 : null
  };
}

// Wrapper: acepta cualquier fecha, calcula el ultimo viernes correspondiente
function calcularIGU(fechaInput) {
  const f = new Date(fechaInput);
  let viernesRef;

  if (f.getDay() === 5) {
    viernesRef = fechaInput;
  } else {
    const diasAtras = (f.getDay() + 2) % 7;
    f.setDate(f.getDate() - diasAtras);
    viernesRef = f.toISOString().split('T')[0];
  }

  return calcularIGUVentana(viernesRef);
}

// Activar endpoints de administracion (pasando calcularIGUVentana)
adminInit(app, db, calcularIGUVentana);

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
      SELECT * FROM indice WHERE fecha BETWEEN ? AND ? ORDER BY fecha ASC
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
    res.json({ success: true, id: result.lastInsertRowid, indice_recalculado: indiceActualizado });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/calcular/:fecha', (req, res) => {
  try {
    res.json(calcularIGUVentana(req.params.fecha));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

async function ejecutarScrape(req, res) {
  try {
    const resultado = await scraper.scrapeAll(db, calcularIGUVentana);
    res.json(resultado);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

app.post('/api/scrape', ejecutarScrape);
app.get('/api/scrape', ejecutarScrape);

app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      total_observaciones: db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n,
      dias_con_indice: db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n,
      primer_registro: db.prepare(`SELECT MIN(fecha) as f FROM indice`).get().f,
      ultimo_registro: db.prepare(`SELECT MAX(fecha) as f FROM indice`).get().f,
      fuentes_activas: db.prepare(`SELECT DISTINCT fuente FROM precios_raw`).all().map(r => r.fuente),
      ventana_dias: VENTANA_DIAS,
      base: '1.0000 = viernes 2 de enero 2026',
      metodologia: {
        NG_VG_VQ: 'USD/kg 4ta balanza (canal) - fuente INAC',
        TE_VI: 'USD/kg peso vivo - fuente Plaza Rural + Pantalla Uruguay'
      },
      ultimo_viernes: ultimoViernesHabil()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Base no inicializada. Usar /admin/init-db', detalle: err.message });
  }
});

// ============================================================================
// CRON JOBS - PUBLICACION SEMANAL LUNES 09:00 UY
// ============================================================================
//
// El IGU se publica los lunes con datos del viernes anterior.
// Por que lunes?
//   - INAC publica los miercoles los datos del viernes anterior (disponibles)
//   - Plaza Rural / Pantalla cierran remates el jueves-viernes (disponibles)
//   - Lunes a primera hora → dashboard actualizado para empezar la semana

cron.schedule('0 9 * * 1', async () => {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] Publicacion semanal IGU`);
  console.log('='.repeat(60));

  try {
    // 1. Scrape de todas las fuentes
    const resultado = await scraper.scrapeAll(db, calcularIGUVentana);

    // 2. Recalculo final del IGU del viernes anterior
    const viernesRef = resultado.detalles && resultado.detalles.length > 0
      ? resultado.detalles[0].fecha
      : ultimoViernesHabil();

    const igu = calcularIGUVentana(viernesRef);
    if (igu && igu.igu_general !== null) {
      console.log(`IGU publicado ${viernesRef}: ${igu.igu_general.toFixed(4)}`);
    }
  } catch (err) {
    console.error('Error en publicacion semanal:', err.message);
  }
}, { timezone: 'America/Montevideo' });

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('IGU v2.0 - Indice Ganadero Uruguayo');
  console.log(`Puerto: ${PORT} | DB: ${DB_PATH}`);
  console.log(`Base: 1.0000 = 2/1/2026`);
  console.log(`Ventana: ${VENTANA_DIAS} dias | Publicacion: LUNES 09:00 UY`);
  console.log(`Metodologia: NG/VG/VQ=canal (INAC) | TE/VI=vivo (Pantallas)`);
  console.log('='.repeat(60));
});

module.exports = { app, calcularIGU, calcularIGUVentana };
