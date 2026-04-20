// analisis-claude-routes.js
// Endpoints HTTP para la capa 3 de auditoria (analisis con Claude API)
//
// Integracion en server.js:
//   const analisisClaudeRoutes = require('./analisis-claude-routes');
//   analisisClaudeRoutes(app, db);
//
// Endpoints:
//   GET /admin/analisis-migrar         - crear tabla analisis_claude_log
//   GET /admin/analisis-anomalias      - ejecutar manualmente (chequea y analiza si hay triggers)
//   GET /admin/analisis-forzar         - forzar analisis sin chequear triggers (para testing)
//   GET /admin/analisis-historial      - ver ultimos analisis ejecutados

const SECRET = process.env.ADMIN_SECRET || 'IGU_INIT_2026';

module.exports = function(app, db) {

  // ==========================================================================
  // GET /admin/analisis-migrar - crear tabla de log
  // ==========================================================================
  app.get('/admin/analisis-migrar', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      db.exec(`
        CREATE TABLE IF NOT EXISTS analisis_claude_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fecha_envio TEXT DEFAULT CURRENT_TIMESTAMP,
          triggers_hash TEXT NOT NULL,
          triggers_json TEXT,
          analisis_texto TEXT,
          modelo TEXT,
          input_tokens INTEGER,
          output_tokens INTEGER,
          email_enviado INTEGER DEFAULT 0,
          email_id TEXT,
          duracion_ms INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_analisis_fecha ON analisis_claude_log(fecha_envio);
        CREATE INDEX IF NOT EXISTS idx_analisis_hash ON analisis_claude_log(triggers_hash);
      `);

      res.json({
        success: true,
        mensaje: 'Tabla analisis_claude_log creada',
        anthropic_configurado: !!process.env.ANTHROPIC_API_KEY
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // GET /admin/analisis-anomalias - chequear triggers y analizar si hay
  // ==========================================================================
  app.get('/admin/analisis-anomalias', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      // 1. Correr auditoria
      const { ejecutarAuditoriaCompleta } = require('./auditoria-valores');
      const auditoria = await ejecutarAuditoriaCompleta(db);

      // 2. Correr healthcheck
      const { ejecutarHealthcheck } = require('./healthcheck');
      const healthcheck = ejecutarHealthcheck(db);

      // 3. Analisis condicional
      const { ejecutarAnalisisSiHayAnomalias } = require('./analisis-claude');
      const resultado = await ejecutarAnalisisSiHayAnomalias(db, auditoria, healthcheck);

      res.json({
        auditoria_estado: auditoria.estado_general,
        healthcheck_estado: healthcheck.estado_general,
        analisis: resultado
      });
    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack });
    }
  });

  // ==========================================================================
  // GET /admin/analisis-forzar - forzar analisis (para testing)
  // ==========================================================================
  app.get('/admin/analisis-forzar', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const { ejecutarAuditoriaCompleta } = require('./auditoria-valores');
      const auditoria = await ejecutarAuditoriaCompleta(db);

      const { ejecutarHealthcheck } = require('./healthcheck');
      const healthcheck = ejecutarHealthcheck(db);

      // Crear un trigger sintetico para forzar el analisis
      const { llamarClaudeAPI, construirPromptClaude, enviarEmailAnalisis } = require('./analisis-claude');

      const iguActual = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();
      const historicoIGU = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 8`).all().reverse();

      const triggersForzados = [{
        tipo: 'forzado_manual',
        severidad: 'warning',
        detalle: 'Test manual del sistema de analisis con Claude',
        datos: null
      }];

      const prompt = construirPromptClaude(triggersForzados, auditoria, healthcheck, iguActual, historicoIGU);
      const analisis = await llamarClaudeAPI(prompt);
      const envio = await enviarEmailAnalisis(analisis, triggersForzados, { iguActual });

      res.json({
        mensaje: 'Analisis forzado ejecutado con exito',
        tokens: `${analisis.input_tokens} in + ${analisis.output_tokens} out`,
        email: envio,
        preview: analisis.texto.slice(0, 300) + '...'
      });
    } catch (err) {
      res.status(500).json({
        error: err.message,
        hint: err.message.includes('ANTHROPIC_API_KEY')
          ? 'Agregar ANTHROPIC_API_KEY en variables de Railway'
          : 'Verificar configuracion'
      });
    }
  });

  // ==========================================================================
  // GET /admin/analisis-historial - ultimos analisis
  // ==========================================================================
  app.get('/admin/analisis-historial', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const historial = db.prepare(`
        SELECT id, fecha_envio, triggers_hash, modelo,
               input_tokens, output_tokens, email_enviado, duracion_ms,
               substr(analisis_texto, 1, 200) AS preview
        FROM analisis_claude_log
        ORDER BY fecha_envio DESC
        LIMIT 20
      `).all();

      const totalTokens = db.prepare(`
        SELECT
          COUNT(*) AS total_analisis,
          SUM(input_tokens) AS total_input,
          SUM(output_tokens) AS total_output
        FROM analisis_claude_log
      `).get();

      // Costo estimado (Sonnet 4.5: $3/M input, $15/M output)
      const costoEstimado = totalTokens.total_analisis > 0
        ? ((totalTokens.total_input || 0) * 3 / 1_000_000 + (totalTokens.total_output || 0) * 15 / 1_000_000)
        : 0;

      res.json({
        total_analisis: totalTokens.total_analisis,
        total_input_tokens: totalTokens.total_input,
        total_output_tokens: totalTokens.total_output,
        costo_usd_estimado: costoEstimado.toFixed(4),
        ultimos_20: historial
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  console.log('Analisis Claude endpoints: /admin/analisis-migrar, /admin/analisis-anomalias, /admin/analisis-forzar, /admin/analisis-historial');
};
