// server.js v2.3
// Indice Ganadero Uruguayo (IGU)
// BASE: 1.0000 = viernes 2/1/2026
//
// METODOLOGIA v2.2 (17/4/2026):
//   6 categorias, todas normalizadas a USD/kg:
//     NG (38%) - Novillo Gordo - INAC 4ta balanza
//     VG (25%) - Vaca Gorda - INAC 4ta balanza
//     VQ (12%) - Vaquillona Gorda - INAC 4ta balanza
//     TE (15%) - Ternero - Plaza Rural + Pantalla Uruguay
//     VI (7%)  - Vaca Invernada - Plaza Rural + Pantalla Uruguay
//     VP (3%)  - Vacas/Vaquillonas Preñadas - Plaza + Pantalla (USD/cabeza÷420)
//
//   Sub-indices:
//     sub_carne:      NG + VG + VQ = 75%
//     sub_reposicion: TE + VI = 22%
//     sub_cria:       VP = 3%
//
// CAMBIOS v2.3 (20/4/2026):
//   - Healthcheck automatico con 10 validaciones tecnicas
//   - Envio de alertas por email via Resend cuando hay warnings/criticas
//   - Endpoints: /admin/healthcheck, /admin/healthcheck-email,
//     /admin/healthcheck-test-email, /api/healthcheck-public
//   - Cron horario: corre checks cada hora, manda email si hay alertas
//   - Variables de entorno nuevas: RESEND_API_KEY, EMAIL_FROM, EMAIL_TO

require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const cron = require('node-cron');
const path = require('path');
const scraper = require('./scraper');
const adminInit = require('./admin-init');
const healthcheckRoutes = require('./healthcheck-routes');
const auditoriaRoutes = require('./auditoria-routes');
const { ultimoViernesHabil } = require('./utils-fecha');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');
const VENTANA_DIAS = 14;
const FUENTES_SIN_VOLUMEN_OK = ['inac', 'pantalla_uruguay'];

// Definicion de sub-indices v2.2
const SUB_INDICES_DEF = {
  sub_carne:      ['NG', 'VG', 'VQ'],
  sub_reposicion: ['TE', 'VI'],
  sub_cria:       ['VP']
};

// ============================================================================
// REDIRECT 301 DOMINIO CANONICO
// ============================================================================
const DOMINIO_CANONICO = 'www.igu.com.uy';

app.use((req, res, next) => {
  const host = (req.headers.host || '').toLowerCase();
  if (host === 'igu.uy' || host === 'www.igu.uy') {
    return res.redirect(301, `https://${DOMINIO_CANONICO}${req.url}`);
  }
  if (host === 'igu.com.uy') {
    return res.redirect(301, `https://${DOMINIO_CANONICO}${req.url}`);
  }
  next();
});

// ============================================================================
// AUTH HTTP BASIC - MODO PRIVADO
// ============================================================================
const AUTH_ENABLED = process.env.AUTH_ENABLED === 'true';
const AUTH_USER = process.env.AUTH_USER || 'igu';
const AUTH_PASS = process.env.AUTH_PASS || '';

function basicAuthMiddleware(req, res, next) {
  if (!AUTH_ENABLED) return next();
  if (req.path === '/health') return next();
  if (req.path.startsWith('/admin/')) return next();
  if (req.path === '/webhook-interno') return next();
  if (req.path === '/api/healthcheck-public') return next();

  const header = req.headers.authorization || '';
  const token = header.split(' ')[1] || '';
  const [user, pass] = Buffer.from(token, 'base64').toString().split(':');

  if (user === AUTH_USER && pass === AUTH_PASS && AUTH_PASS !== '') {
    return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="IGU - Acceso restringido"');
  res.status(401).send(`
    <html><head><title>IGU - Acceso restringido</title>
    <style>body{font-family:Georgia,serif;background:#f5f1e6;color:#2d4a2b;
    display:flex;align-items:center;justify-content:center;height:100vh;
    margin:0;text-align:center;padding:2rem}h1{font-size:3rem;margin:0 0 1rem;
    font-weight:400}p{font-size:1rem;color:#6b6b5c;max-width:500px;line-height:1.6}
    .gold{color:#c4914e;font-weight:600}</style></head>
    <body><div><h1>IGU</h1>
    <p><strong>Acceso restringido temporalmente.</strong></p>
    <p>El <span class="gold">Indice Ganadero Uruguayo</span> esta en periodo de proteccion
    de propiedad intelectual. Proximamente disponible publicamente.</p>
    <p style="font-size:0.85rem;margin-top:2rem;color:#8c8670;">
    Si tenes credenciales, refresca e ingresalas en el popup.</p>
    </div></body></html>
  `);
}

app.use(basicAuthMiddleware);
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ============================================================================
// CALCULO IGU - LASPEYRES BASE 1.0000
// ============================================================================

function calcularIGUVentana(fechaRef) {
  const fechaFin = new Date(fechaRef);
  const fechaInicio = new Date(fechaFin);
  fechaInicio.setDate(fechaInicio.getDate() - VENTANA_DIAS);
  const fechaInicioStr = fechaInicio.toISOString().split('T')[0];

  console.log(`Calculando IGU para ${fechaRef} (ventana ${fechaInicioStr} a ${fechaRef})`);

  // Query ponderada por volumen, excluye sin volumen salvo INAC
  const fuentesSinVolumenStr = FUENTES_SIN_VOLUMEN_OK.map(f => `'${f}'`).join(',');

  const query = `
    SELECT
      categoria_codigo,
      SUM(precio * CASE
        WHEN volumen IS NOT NULL AND volumen > 0 THEN volumen
        WHEN fuente IN (${fuentesSinVolumenStr}) THEN 10000
        ELSE 0
      END) /
      NULLIF(SUM(CASE
        WHEN volumen IS NOT NULL AND volumen > 0 THEN volumen
        WHEN fuente IN (${fuentesSinVolumenStr}) THEN 10000
        ELSE 0
      END), 0) AS precio_promedio,
      COUNT(CASE
        WHEN (volumen IS NOT NULL AND volumen > 0) OR fuente IN (${fuentesSinVolumenStr})
        THEN 1 END) AS num_observaciones,
      SUM(COALESCE(volumen, 0)) AS volumen_total,
      GROUP_CONCAT(DISTINCT fuente) AS fuentes
    FROM precios_raw
    WHERE fecha >= ? AND fecha <= ?
      AND ((volumen IS NOT NULL AND volumen > 0) OR fuente IN (${fuentesSinVolumenStr}))
    GROUP BY categoria_codigo
    HAVING precio_promedio IS NOT NULL
  `;

  const promedios = db.prepare(query).all(fechaInicioStr, fechaRef);

  if (promedios.length === 0) {
    return { error: 'No hay datos en la ventana', fechaRef };
  }

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

  const categorias = db.prepare(`
    SELECT c.codigo, c.ponderacion, c.unidad, b.precio_base, b.cantidad_base
    FROM categorias c
    JOIN base_index b ON c.codigo = b.categoria_codigo
    WHERE c.activo = 1
  `).all();

  // Laspeyres: IGU = Σ(Pt × Q0 × W) / Σ(P0 × Q0 × W)
  // Todas las categorias estan en USD/kg (VP ya convertido en scrapers)
  let numerador = 0, denominador = 0;
  const detalles = {};

  categorias.forEach(cat => {
    const precioActual = promedios.find(p => p.categoria_codigo === cat.codigo);
    if (!precioActual) {
      detalles[cat.codigo] = { sin_datos: true, precio_base: cat.precio_base };
      return;
    }

    numerador += precioActual.precio_promedio * cat.cantidad_base * cat.ponderacion;
    denominador += cat.precio_base * cat.cantidad_base * cat.ponderacion;

    detalles[cat.codigo] = {
      precio_actual: precioActual.precio_promedio,
      precio_base: cat.precio_base,
      unidad: cat.unidad,
      indice_individual: precioActual.precio_promedio / cat.precio_base,
      num_observaciones: precioActual.num_observaciones,
      fuentes: precioActual.fuentes
    };
  });

  const iguGeneral = denominador > 0 ? (numerador / denominador) : null;

  const subIndices = {
    sub_carne:      calcularSubIndice(SUB_INDICES_DEF.sub_carne,      promedios, categorias),
    sub_reposicion: calcularSubIndice(SUB_INDICES_DEF.sub_reposicion, promedios, categorias),
    sub_cria:       calcularSubIndice(SUB_INDICES_DEF.sub_cria,       promedios, categorias)
  };

  const variaciones = calcularVariaciones(fechaRef, iguGeneral);

  db.prepare(`
    INSERT OR REPLACE INTO indice
    (fecha, igu_general, sub_carne, sub_reposicion, sub_cria,
     variacion_diaria, variacion_mensual, variacion_anual, metodologia_version)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2.2')
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
    },
    metodologia_version: '2.2'
  };
}

function calcularSubIndice(codigos, promedios, categorias) {
  let num = 0, den = 0;
  const subCats = categorias.filter(c => codigos.includes(c.codigo));
  const pondTotal = subCats.reduce((s, c) => s + c.ponderacion, 0);
  if (pondTotal === 0) return null;

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

// ============================================================================
// REGISTRAR RUTAS DE MODULOS
// ============================================================================
adminInit(app, db, calcularIGUVentana);
healthcheckRoutes(app, db);
auditoriaRoutes(app, db);

// ============================================================================
// API REST
// ============================================================================

app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IGU API', version: '2.3', timestamp: new Date().toISOString() });
});

app.get('/api/indice/actual', (req, res) => {
  try {
    const ultimo = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();
    if (!ultimo) return res.json({ error: 'Sin datos aun' });
    res.json(ultimo);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/indice/historico', (req, res) => {
  try {
    const { desde = '2020-01-01', hasta = new Date().toISOString().split('T')[0] } = req.query;
    const historico = db.prepare(`
      SELECT * FROM indice WHERE fecha BETWEEN ? AND ? ORDER BY fecha ASC
    `).all(desde, hasta);
    res.json(historico);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/indice/:fecha', (req, res) => {
  try {
    const registro = db.prepare(`SELECT * FROM indice WHERE fecha = ?`).get(req.params.fecha);
    if (!registro) return res.status(404).json({ error: 'Fecha sin datos' });
    res.json(registro);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/categorias', (req, res) => {
  try {
    const cats = db.prepare(`
      SELECT c.*, b.precio_base, b.fecha_base
      FROM categorias c
      LEFT JOIN base_index b ON c.codigo = b.categoria_codigo
      WHERE c.activo = 1
      ORDER BY c.ponderacion DESC
    `).all();
    res.json(cats);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/precios/:fecha', (req, res) => {
  try {
    const precios = db.prepare(`
      SELECT p.*, c.nombre, c.ponderacion, c.unidad
      FROM precios_promedio_diario p
      JOIN categorias c ON p.categoria_codigo = c.codigo
      WHERE p.fecha = ?
    `).all(req.params.fecha);
    res.json(precios);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/precios/raw/:fecha', (req, res) => {
  try {
    const raws = db.prepare(`
      SELECT * FROM precios_raw WHERE fecha = ? ORDER BY categoria_codigo, fuente
    `).all(req.params.fecha);
    res.json(raws);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ============================================================================
// POST /api/precios - CARGA MANUAL PROTEGIDA
// ============================================================================
const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.IGU_INIT_SECRET || 'IGU_INIT_2026';

app.post('/api/precios', (req, res) => {
  try {
    const secret = req.headers['x-admin-secret'] || req.query.secret;
    if (secret !== ADMIN_SECRET) {
      return res.status(403).json({
        error: 'Carga manual deshabilitada. Requiere secret admin.',
        hint: 'Solo para correcciones auditables.'
      });
    }

    const { fecha, categoria_codigo, precio, unidad, volumen, observaciones } = req.body;
    if (!fecha || !categoria_codigo || !precio || !observaciones) {
      return res.status(400).json({
        error: 'Requeridos: fecha, categoria_codigo, precio, observaciones',
        nota: 'observaciones debe documentar la razon de la correccion.'
      });
    }

    const result = db.prepare(`
      INSERT INTO precios_raw (fecha, categoria_codigo, fuente, precio, unidad, volumen, observaciones)
      VALUES (?, ?, 'manual_admin', ?, ?, ?, ?)
    `).run(fecha, categoria_codigo, precio, unidad || 'USD/kg', volumen || null, observaciones);

    const indiceActualizado = calcularIGU(fecha);
    res.json({
      success: true,
      id: result.lastInsertRowid,
      fuente: 'manual_admin',
      indice_recalculado: indiceActualizado,
      aviso: 'Carga manual registrada.'
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/calcular/:fecha', (req, res) => {
  try { res.json(calcularIGUVentana(req.params.fecha)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

async function ejecutarScrape(req, res) {
  try {
    const resultado = await scraper.scrapeAll(db, calcularIGUVentana);
    res.json(resultado);
  } catch (err) { res.status(500).json({ error: err.message }); }
}

app.post('/api/scrape', ejecutarScrape);
app.get('/api/scrape', ejecutarScrape);

app.get('/api/stats', (req, res) => {
  try {
    const stats = {
      version: '2.3',
      total_observaciones: db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n,
      dias_con_indice: db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n,
      primer_registro: db.prepare(`SELECT MIN(fecha) as f FROM indice`).get().f,
      ultimo_registro: db.prepare(`SELECT MAX(fecha) as f FROM indice`).get().f,
      fuentes_activas: db.prepare(`SELECT DISTINCT fuente FROM precios_raw`).all().map(r => r.fuente),
      ventana_dias: VENTANA_DIAS,
      base: '1.0000 = viernes 2 de enero 2026',
      categorias: db.prepare(`SELECT codigo, nombre, ponderacion, unidad FROM categorias WHERE activo = 1 ORDER BY ponderacion DESC`).all(),
      sub_indices: SUB_INDICES_DEF,
      ultimo_viernes: ultimoViernesHabil()
    };
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: 'Base no inicializada. Usar /admin/init-db', detalle: err.message });
  }
});

// ============================================================================
// CRON SEMANAL LUNES 09:00 UY - Publicacion oficial
// ============================================================================

cron.schedule('0 9 * * 1', async () => {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] Publicacion semanal IGU`);
  console.log('='.repeat(60));

  try {
    await scraper.scrapeAll(db, calcularIGUVentana);
    const viernesRef = ultimoViernesHabil();
    const igu = calcularIGUVentana(viernesRef);
    if (igu && igu.igu_general != null) {
      console.log(`IGU publicado ${viernesRef}: ${igu.igu_general.toFixed(4)}`);
    }
  } catch (err) {
    console.error('Error en publicacion semanal:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// ============================================================================
// CRON HORARIO - Healthcheck + email si hay alertas
// ============================================================================

cron.schedule('15 * * * *', async () => {
  try {
    const { ejecutarHealthcheck } = require('./healthcheck');
    const resultado = ejecutarHealthcheck(db);

    // Log conciso en Railway
    const prefijo = resultado.estado_general === 'ok' ? '[healthcheck]' : '[HEALTHCHECK ' + resultado.estado_general.toUpperCase() + ']';
    console.log(`${prefijo} ${resultado.resumen_ejecutivo}`);

    // Enviar email solo si hay alertas
    if (resultado.estado_general !== 'ok') {
      try {
        const { enviarAlerta } = require('./email-alerts');
        const envio = await enviarAlerta(resultado);
        if (envio.enviado) {
          console.log(`[healthcheck] Email enviado: ${envio.subject} -> ${envio.destinatario}`);
        } else {
          console.log(`[healthcheck] Email no enviado: ${envio.motivo || envio.error || 'razon desconocida'}`);
        }
      } catch (emailErr) {
        console.error('[healthcheck] Error enviando email:', emailErr.message);
      }
    }
  } catch (err) {
    console.error('[healthcheck] Error ejecutando checks:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// ============================================================================
// CRON SEMANAL LUNES 09:15 UY - Auditoria de Veracidad (Capas A, B y C)
// ============================================================================
// Se ejecuta DESPUES del cron de publicacion (09:00) para auditar los valores
// recien publicados.

cron.schedule('15 9 * * 1', async () => {
  console.log('='.repeat(60));
  console.log(`[${new Date().toISOString()}] Auditoria semanal de veracidad`);
  console.log('='.repeat(60));

  try {
    const { ejecutarAuditoriaCompleta } = require('./auditoria-valores');
    const resultado = await ejecutarAuditoriaCompleta(db);

    console.log(`[auditoria] ${resultado.resumen_ejecutivo}`);

    // Siempre enviar email del reporte semanal de auditoria (incluso si todo OK)
    // Porque es un informe semanal, no una alerta
    if (process.env.EMAIL_TO && process.env.RESEND_API_KEY) {
      try {
        const auditoriaRoutes = require('./auditoria-routes');
        const { Resend } = require('resend');
        // Para el email, llamamos al helper interno exportando solo el necesario
        // (Lo mas limpio: llamar al mismo endpoint con forzar=true)
        const http = require('http');
        http.get(`http://localhost:${PORT}/admin/auditoria-valores-email?secret=${process.env.ADMIN_SECRET || 'IGU_INIT_2026'}&forzar=1`, (res) => {
          let data = '';
          res.on('data', chunk => data += chunk);
          res.on('end', () => console.log('[auditoria] Email semanal enviado'));
        }).on('error', (e) => console.error('[auditoria] Error llamando endpoint:', e.message));
      } catch (emailErr) {
        console.error('[auditoria] Error enviando email:', emailErr.message);
      }
    }
  } catch (err) {
    console.error('[auditoria] Error en auditoria semanal:', err.message);
  }
}, { timezone: 'America/Montevideo' });

// ============================================================================
// INICIAR SERVIDOR
// ============================================================================

app.listen(PORT, () => {
  console.log('='.repeat(60));
  console.log('IGU v2.4 - Indice Ganadero Uruguayo');
  console.log(`Puerto: ${PORT} | DB: ${DB_PATH}`);
  console.log(`Base: 1.0000 = 2/1/2026 | Ventana: ${VENTANA_DIAS} dias`);
  console.log(`Categorias: NG/VG/VQ (canal) + TE/VI (vivo) + VP (cabeza/420)`);
  console.log(`Ponderaciones: NG38 VG25 VQ12 TE15 VI7 VP3`);
  console.log(`Crons activos:`);
  console.log(`  - Lunes 09:00 UY: publicacion semanal IGU`);
  console.log(`  - Lunes 09:15 UY: auditoria de veracidad (3 capas)`);
  console.log(`  - Cada hora :15:  healthcheck + email si hay alertas`);
  const emailConfigurado = process.env.RESEND_API_KEY && process.env.EMAIL_TO;
  console.log(`  Email alertas: ${emailConfigurado ? 'CONFIGURADO (' + process.env.EMAIL_TO + ')' : 'NO configurado (setear RESEND_API_KEY y EMAIL_TO)'}`);
  console.log('='.repeat(60));
});

module.exports = { app, calcularIGU, calcularIGUVentana };
