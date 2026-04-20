// auditoria-routes.js
// Endpoints HTTP para la auditoria de veracidad de valores.
//
// Integracion en server.js:
//   const auditoriaRoutes = require('./auditoria-routes');
//   auditoriaRoutes(app, db);
//
// Endpoints:
//   GET /admin/auditoria-valores            - ejecuta las 3 capas (retorna JSON)
//   GET /admin/auditoria-valores-email      - ejecuta + envia email si hay discrepancias
//   GET /admin/auditoria-ultima             - ver ultima auditoria guardada (resumen)
//   GET /admin/auditoria-discrepancias      - lista discrepancias historicas
//   GET /admin/auditoria-migrar             - aplica migracion SQL 003 (tabla auditoria_valores)

const SECRET = process.env.ADMIN_SECRET || 'IGU_INIT_2026';

module.exports = function(app, db) {

  // ==========================================================================
  // GET /admin/auditoria-migrar - crear tablas de auditoria
  // ==========================================================================
  app.get('/admin/auditoria-migrar', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS auditoria_valores (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fecha_auditoria TEXT DEFAULT CURRENT_TIMESTAMP,
          fecha_dato TEXT NOT NULL,
          categoria_codigo TEXT NOT NULL,
          fuente TEXT NOT NULL,
          valor_en_db REAL,
          valor_en_fuente REAL,
          diferencia_pct REAL,
          match INTEGER NOT NULL,
          severidad TEXT,
          detalle TEXT,
          url_fuente TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_auditoria_fecha ON auditoria_valores(fecha_dato);
        CREATE INDEX IF NOT EXISTS idx_auditoria_match ON auditoria_valores(match);
        CREATE INDEX IF NOT EXISTS idx_auditoria_ejec ON auditoria_valores(fecha_auditoria);

        CREATE TABLE IF NOT EXISTS auditoria_discrepancias (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fecha_deteccion TEXT DEFAULT CURRENT_TIMESTAMP,
          auditoria_id INTEGER,
          fecha_dato TEXT NOT NULL,
          categoria_codigo TEXT NOT NULL,
          fuente TEXT NOT NULL,
          valor_db REAL,
          valor_fuente REAL,
          diferencia_pct REAL,
          resolucion TEXT,
          nota_resolucion TEXT,
          fecha_resolucion TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_discrep_resolucion ON auditoria_discrepancias(resolucion);
      `);

      res.json({
        success: true,
        mensaje: 'Tablas de auditoria creadas correctamente',
        tablas: ['auditoria_valores', 'auditoria_discrepancias']
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // GET /admin/auditoria-valores - ejecuta las 3 capas
  // ==========================================================================
  app.get('/admin/auditoria-valores', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const { ejecutarAuditoriaCompleta } = require('./auditoria-valores');
      const resultado = await ejecutarAuditoriaCompleta(db);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // ==========================================================================
  // GET /admin/auditoria-valores-email - auditoria + email si hay discrepancias
  // ==========================================================================
  app.get('/admin/auditoria-valores-email', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const { ejecutarAuditoriaCompleta } = require('./auditoria-valores');
      const resultado = await ejecutarAuditoriaCompleta(db);

      let envio = { enviado: false, motivo: 'Email desactivado o sin discrepancias' };
      const forzar = req.query.forzar === '1' || req.query.forzar === 'true';

      if (resultado.estado_general !== 'ok' || forzar) {
        try {
          envio = await enviarEmailAuditoria(resultado);
        } catch (emailErr) {
          envio = { enviado: false, error: emailErr.message };
        }
      }

      res.json({ auditoria: resultado, email: envio });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // GET /admin/auditoria-ultima - resumen de la ultima auditoria guardada
  // ==========================================================================
  app.get('/admin/auditoria-ultima', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const ultimaEjecucion = db.prepare(`
        SELECT MAX(fecha_auditoria) AS ultima FROM auditoria_valores
      `).get();

      if (!ultimaEjecucion?.ultima) {
        return res.json({ mensaje: 'Aun no hay auditorias ejecutadas' });
      }

      const registros = db.prepare(`
        SELECT * FROM auditoria_valores
        WHERE fecha_auditoria = ?
        ORDER BY severidad DESC, categoria_codigo
      `).all(ultimaEjecucion.ultima);

      const resumen = {
        fecha_ejecucion: ultimaEjecucion.ultima,
        total_checks: registros.length,
        matches: registros.filter(r => r.match === 1).length,
        warnings: registros.filter(r => r.severidad === 'warning').length,
        criticas: registros.filter(r => r.severidad === 'critical').length,
        registros
      };

      res.json(resumen);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // GET /admin/auditoria-discrepancias - lista discrepancias pendientes
  // ==========================================================================
  app.get('/admin/auditoria-discrepancias', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const pendientes = db.prepare(`
        SELECT * FROM auditoria_discrepancias
        WHERE resolucion = 'pendiente' OR resolucion IS NULL
        ORDER BY fecha_deteccion DESC
      `).all();

      const historicas = db.prepare(`
        SELECT * FROM auditoria_discrepancias
        WHERE resolucion IS NOT NULL AND resolucion != 'pendiente'
        ORDER BY fecha_deteccion DESC
        LIMIT 20
      `).all();

      res.json({
        pendientes: pendientes.length,
        resueltas_recientes: historicas.length,
        detalle_pendientes: pendientes,
        detalle_resueltas: historicas
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('Auditoria endpoints: /admin/auditoria-valores, /admin/auditoria-valores-email, /admin/auditoria-ultima, /admin/auditoria-discrepancias, /admin/auditoria-migrar');
};

// ============================================================================
// Email especifico para auditoria
// ============================================================================

async function enviarEmailAuditoria(resultado) {
  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  if (!emailTo) throw new Error('EMAIL_TO no configurado');

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  const color = { ok: '#2d7a3e', warning: '#c4914e', critical: '#a84032' }[resultado.estado_general];
  const emoji = { ok: '✅', warning: '⚠️', critical: '🔴' }[resultado.estado_general];
  const subject = `${emoji} IGU Auditoria ${resultado.estado_general.toUpperCase()} - Veracidad de datos`;

  // Tabla de Capa A
  const filasCapaA = [
    ...resultado.capa_A.detalles.ok.map(r => formatearFilaCapaA(r, 'ok')),
    ...resultado.capa_A.detalles.warnings.map(r => formatearFilaCapaA(r, 'warning')),
    ...resultado.capa_A.detalles.criticas.map(r => formatearFilaCapaA(r, 'critical')),
    ...resultado.capa_A.detalles.errores.map(r => formatearFilaError(r))
  ].join('');

  // Tabla de Capa B
  const filasCapaB = [
    ...resultado.capa_B.detalles.ok.map(r => formatearFilaCapaB(r, 'ok')),
    ...resultado.capa_B.detalles.discrepancias.map(r => formatearFilaCapaB(r, 'warning'))
  ].join('');

  // Tabla de Capa C
  const filasCapaC = [
    ...resultado.capa_C.detalles.ok.map(r => formatearFilaCapaC(r, 'ok')),
    ...resultado.capa_C.detalles.alertas.map(r => formatearFilaCapaC(r, 'warning'))
  ].join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family: -apple-system, 'Segoe UI', sans-serif; background: #f5f1e6; margin: 0; padding: 20px;">
  <div style="max-width: 780px; margin: 0 auto; background: #fcfaf3; border-radius: 12px; overflow: hidden;">

    <div style="background: ${color}; color: white; padding: 24px; text-align: center;">
      <div style="font-size: 2rem;">${emoji}</div>
      <h1 style="margin: 8px 0 4px; font-size: 1.3rem; font-weight: 500;">IGU · Auditoria de Veracidad</h1>
      <p style="margin: 0; opacity: 0.9; font-size: 0.85rem;">${resultado.timestamp}</p>
    </div>

    <div style="padding: 24px;">
      <p style="margin: 0 0 20px; color: #3a3a2d;"><strong>${resultado.resumen_ejecutivo}</strong></p>

      <h3 style="color: #2d4a2b; margin: 20px 0 8px;">📊 Capa A · Fuente vs Base de Datos</h3>
      <p style="color: #6b6b5c; font-size: 0.85rem; margin: 0 0 12px;">Verifica que cada precio guardado coincida con lo publicado hoy en la fuente original.</p>
      ${filasCapaA ? `
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead><tr style="background: #f5f1e6;">
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Estado</th>
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Fuente</th>
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Cat</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">DB</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Fuente</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Diff %</th>
          </tr></thead>
          <tbody>${filasCapaA}</tbody>
        </table>
      ` : '<p style="color: #8c8670;">Sin resultados</p>'}

      <h3 style="color: #2d4a2b; margin: 24px 0 8px;">🔄 Capa B · Coherencia cruzada</h3>
      <p style="color: #6b6b5c; font-size: 0.85rem; margin: 0 0 12px;">Plaza Rural vs Pantalla Uruguay deberian publicar precios similares para TE, VI y VP.</p>
      ${filasCapaB ? `
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead><tr style="background: #f5f1e6;">
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Estado</th>
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Cat</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Plaza</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Pantalla</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Diff %</th>
          </tr></thead>
          <tbody>${filasCapaB}</tbody>
        </table>
      ` : '<p style="color: #8c8670;">Sin datos cruzados disponibles</p>'}

      <h3 style="color: #2d4a2b; margin: 24px 0 8px;">📈 Capa C · Rangos historicos</h3>
      <p style="color: #6b6b5c; font-size: 0.85rem; margin: 0 0 12px;">Precio actual vs promedio de las ultimas 8 semanas (alerta si varia >5%).</p>
      ${filasCapaC ? `
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          <thead><tr style="background: #f5f1e6;">
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Estado</th>
            <th style="padding: 8px; text-align: left; border: 1px solid #e6dfc9;">Cat</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Actual</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Prom 8sem</th>
            <th style="padding: 8px; text-align: right; border: 1px solid #e6dfc9;">Variacion %</th>
          </tr></thead>
          <tbody>${filasCapaC}</tbody>
        </table>
      ` : '<p style="color: #8c8670;">Sin datos historicos suficientes</p>'}

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e6dfc9; font-size: 0.8rem; color: #8c8670; text-align: center;">
        IGU · Auditoria automatica de veracidad de datos<br>
        <a href="https://www.igu.com.uy/admin/auditoria-ultima?secret=IGU_INIT_2026" style="color: #2d4a2b;">Ver detalle en vivo ↗</a>
      </div>
    </div>
  </div>
</body></html>`;

  const response = await resend.emails.send({ from: emailFrom, to: emailTo, subject, html });

  return {
    enviado: true,
    resend_id: response.data?.id || response.id,
    destinatario: emailTo,
    subject
  };
}

function formatearFilaCapaA(r, severidad) {
  const colores = { ok: '#2d7a3e', warning: '#c4914e', critical: '#a84032' };
  const emojis = { ok: '✓', warning: '⚠', critical: '✗' };
  return `<tr>
    <td style="padding: 6px; border: 1px solid #e6dfc9; color: ${colores[severidad]};">${emojis[severidad]}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;">${r.fuente}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;"><strong>${r.categoria}</strong></td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${(r.valor_db || 0).toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${(r.valor_fuente || 0).toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace; color: ${colores[severidad]};">${(r.diferencia_pct || 0).toFixed(2)}%</td>
  </tr>`;
}

function formatearFilaError(r) {
  return `<tr>
    <td style="padding: 6px; border: 1px solid #e6dfc9; color: #a84032;">✗</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;">${r.fuente || '—'}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;" colspan="4">Error: ${r.motivo}</td>
  </tr>`;
}

function formatearFilaCapaB(r, severidad) {
  const colores = { ok: '#2d7a3e', warning: '#c4914e' };
  const emojis = { ok: '✓', warning: '⚠' };
  return `<tr>
    <td style="padding: 6px; border: 1px solid #e6dfc9; color: ${colores[severidad]};">${emojis[severidad]}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;"><strong>${r.categoria}</strong></td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${r.plaza_rural.toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${r.pantalla_uruguay.toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace; color: ${colores[severidad]};">${r.diferencia_pct.toFixed(2)}%</td>
  </tr>`;
}

function formatearFilaCapaC(r, severidad) {
  const colores = { ok: '#2d7a3e', warning: '#c4914e' };
  const emojis = { ok: '✓', warning: '⚠' };
  return `<tr>
    <td style="padding: 6px; border: 1px solid #e6dfc9; color: ${colores[severidad]};">${emojis[severidad]}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9;"><strong>${r.categoria}</strong></td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${r.precio_ultimo.toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace;">${r.promedio_historico.toFixed(4)}</td>
    <td style="padding: 6px; border: 1px solid #e6dfc9; text-align: right; font-family: monospace; color: ${colores[severidad]};">${r.variacion_pct >= 0 ? '+' : ''}${r.variacion_pct.toFixed(2)}%</td>
  </tr>`;
}
