// healthcheck-routes.js v2
// Endpoints de healthcheck con soporte de modo manual.
//
// CAMBIOS v2:
//   - El endpoint /admin/healthcheck ahora acepta parametro ?modo=
//     para forzar un modo especifico (estructural | publicacion).
//   - Util para testing: ?modo=publicacion permite simular un lunes.

const { ejecutarHealthcheck } = require('./healthcheck');
const SECRET = process.env.ADMIN_SECRET || 'IGU_INIT_2026';

module.exports = function(app, db) {

  // ══════════════════════════════════════════════════════════
  // GET /admin/healthcheck - checks completos
  //   Parametros opcionales:
  //     - ?modo=estructural | ?modo=publicacion (forzar modo)
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck', (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const opciones = {};
      if (req.query.modo === 'estructural' || req.query.modo === 'publicacion') {
        opciones.modo = req.query.modo;
      }

      const resultado = ejecutarHealthcheck(db, opciones);
      res.json(resultado);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ══════════════════════════════════════════════════════════
  // GET /admin/healthcheck-email - checks + email si corresponde
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck-email', async (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const opciones = {};
      if (req.query.modo === 'estructural' || req.query.modo === 'publicacion') {
        opciones.modo = req.query.modo;
      }

      const resultado = ejecutarHealthcheck(db, opciones);

      let envio = { enviado: false, motivo: 'Email desactivado' };
      const forzar = req.query.forzar === '1' || req.query.forzar === 'true';

      if (resultado.debe_enviar_email || forzar) {
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
      } else {
        envio = {
          enviado: false,
          motivo: `Modo '${resultado.modo}' con estado '${resultado.estado_general}': no amerita email`
        };
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
  // ══════════════════════════════════════════════════════════
  app.get('/admin/healthcheck-test-email', async (req, res) => {
    if (req.query.secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const opciones = {};
      if (req.query.modo === 'estructural' || req.query.modo === 'publicacion') {
        opciones.modo = req.query.modo;
      }

      const resultado = ejecutarHealthcheck(db, opciones);

      const { enviarAlerta } = require('./email-alerts');
      const envio = await enviarAlerta(resultado, { forzar: true });

      res.json({
        mensaje: 'Email de prueba enviado (forzado, independientemente del estado)',
        modo: resultado.modo,
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
  // ══════════════════════════════════════════════════════════
  app.get('/api/healthcheck-public', (req, res) => {
    try {
      const resultado = ejecutarHealthcheck(db);
      res.json({
        estado: resultado.estado_general,
        modo: resultado.modo,
        timestamp: resultado.timestamp,
        checks_ok: resultado.checks_ok.length,
        warnings: resultado.alertas_warning.length,
        criticas: resultado.alertas_criticas.length
      });
    } catch (err) {
      res.status(500).json({ estado: 'error', mensaje: err.message });
    }
  });

  console.log('Healthcheck endpoints v2: /admin/healthcheck (soporta ?modo=), /admin/healthcheck-email, /admin/healthcheck-test-email, /api/healthcheck-public');
};
