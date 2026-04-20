// healthcheck-routes.js
// Endpoints de healthcheck que se integran al server de Express.
//
// Integracion en server.js:
//   const healthcheckRoutes = require('./healthcheck-routes');
//   healthcheckRoutes(app, db);
//
// Endpoints creados:
//   GET /admin/healthcheck                - corre checks y devuelve JSON (requiere secret)
//   GET /admin/healthcheck-email          - corre checks + envia email si hay alertas
//   GET /admin/healthcheck-test-email     - envia email de prueba forzado
//   GET /api/healthcheck-public           - version publica reducida (sin secret)

const { ejecutarHealthcheck } = require('./healthcheck');
const SECRET = process.env.ADMIN_SECRET || 'IGU_INIT_2026';

module.exports = function(app, db) {

  // ══════════════════════════════════════════════════════════
  // GET /admin/healthcheck - checks completos
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck', (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const resultado = ejecutarHealthcheck(db);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /admin/healthcheck-email - checks + email si hay alertas
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck-email', async (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const resultado = ejecutarHealthcheck(db);

      let envio = { enviado: false, motivo: 'Email desactivado' };

      // Intentar enviar email si hay alertas o se fuerza con ?forzar=1
      const forzar = req.query.forzar === '1' || req.query.forzar === 'true';
      if (resultado.estado_general !== 'ok' || forzar) {
        try {
          const { enviarAlerta } = require('./email-alerts');
          envio = await enviarAlerta(resultado, { forzar });
        } catch (emailErr) {
          envio = {
            enviado: false,
            error: emailErr.message,
            nota: 'Healthcheck se corrio pero el email fallo. Verificar RESEND_API_KEY y EMAIL_TO en Railway.'
          };
        }
      }

      res.json({
        healthcheck: resultado,
        email: envio
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /admin/healthcheck-test-email - email de prueba forzado
  // Usar para probar que Resend este bien configurado
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck-test-email', async (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const resultado = ejecutarHealthcheck(db);

      const { enviarAlerta } = require('./email-alerts');
      const envio = await enviarAlerta(resultado, { forzar: true });

      res.json({
        mensaje: 'Email de prueba enviado (forzado, independientemente del estado)',
        healthcheck_summary: resultado.resumen_ejecutivo,
        email: envio
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
        hint: 'Verificar que RESEND_API_KEY y EMAIL_TO esten configurados en Railway'
      });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /api/healthcheck-public - version publica reducida
  // Sin datos sensibles, para monitoreo externo tipo UptimeRobot
  // ══════════════════════════════════════════════════════════
  app.get('/api/healthcheck-public', (req, res) => {
    try {
      const resultado = ejecutarHealthcheck(db);
      res.json({
        estado: resultado.estado_general,
        timestamp: resultado.timestamp,
        checks_ok: resultado.checks_ok.length,
        warnings: resultado.alertas_warning.length,
        criticas: resultado.alertas_criticas.length
      });
    } catch (err) {
      res.status(500).json({ estado: 'error', mensaje: err.message });
    }
  });

  console.log('Healthcheck endpoints: /admin/healthcheck, /admin/healthcheck-email, /admin/healthcheck-test-email, /api/healthcheck-public');
};
