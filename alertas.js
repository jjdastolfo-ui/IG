// alertas.js
// IGU - Sistema de alertas por email
//
// Dependencia: nodemailer (agregar a package.json: "nodemailer": "^6.9.0")
//
// Variables de entorno requeridas (configurar en Railway):
//   SMTP_HOST        ej: smtp.gmail.com
//   SMTP_PORT        ej: 587
//   SMTP_USER        ej: igu.alertas@gmail.com
//   SMTP_PASS        ej: app-password de Gmail
//   SMTP_FROM        ej: "IGU Alertas <igu.alertas@gmail.com>"
//   ALERT_TO         ej: jjdastolfo@gmail.com
//   ALERT_ENABLED    ej: true (default: false en desarrollo)
//
// Uso:
//   const { alertar } = require('./alertas');
//   await alertar('scraper_fallido', { fuente: 'inac', error: 'timeout' });

const nodemailer = require('nodemailer');

const CONFIG = {
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || '587'),
  secure: process.env.SMTP_PORT === '465',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
};

const FROM = process.env.SMTP_FROM || 'IGU Alertas <igu.alertas@gmail.com>';
const TO = process.env.ALERT_TO || 'jjdastolfo@gmail.com';
const ENABLED = process.env.ALERT_ENABLED === 'true';

let transporter = null;

function getTransporter() {
  if (!transporter && CONFIG.host && CONFIG.auth.user) {
    transporter = nodemailer.createTransport(CONFIG);
  }
  return transporter;
}

/**
 * Plantillas de alertas. Cada tipo tiene asunto y cuerpo.
 */
const PLANTILLAS = {
  scraper_fallido: (data) => ({
    asunto: `🚨 IGU - Scraper ${data.fuente} falló`,
    cuerpo: `
El scraper <strong>${data.fuente}</strong> falló durante la ejecución programada.

<strong>Error:</strong> ${data.error || 'Sin detalle'}
<strong>Fecha:</strong> ${data.fecha || new Date().toISOString()}
<strong>Intento:</strong> ${data.intento || 1}

<strong>Acción requerida:</strong>
- Verificar si la página fuente cambió de estructura
- Revisar logs en Railway: https://railway.app
- Si es necesario, correr scraper manual desde /admin

Este es un mensaje automático del sistema IGU.
    `.trim()
  }),

  outlier_detectado: (data) => ({
    asunto: `⚠️ IGU - Outlier detectado en ${data.categoria}`,
    cuerpo: `
Se detectó un outlier en la categoría <strong>${data.categoria}</strong>.

<strong>Fecha:</strong> ${data.fecha}
<strong>Precio observado:</strong> ${data.precio} ${data.unidad || ''}
<strong>Variación:</strong> ${data.variacion ? data.variacion.toFixed(2) + '%' : 'n/a'}
<strong>Desvíos sigma:</strong> ${data.sigma ? data.sigma.toFixed(2) + 'σ' : 'n/a'}
<strong>Volumen:</strong> ${data.volumen || 'n/a'} cabezas
<strong>Volumen relativo:</strong> ${data.volumen_relativo ? (data.volumen_relativo * 100).toFixed(0) + '%' : 'n/a'} del promedio

<strong>Acción del sistema:</strong> ${data.accion || 'pendiente'}

Este outlier será ${data.interpolado ? 'INTERPOLADO' : 'revisado manualmente'} antes de publicación.

Revisar en dashboard admin: /admin/outliers
    `.trim()
  }),

  interpolacion_aplicada: (data) => ({
    asunto: `↻ IGU - Interpolación aplicada en ${data.categoria}`,
    cuerpo: `
Se aplicó interpolación automática en <strong>${data.categoria}</strong>.

<strong>Precio original:</strong> ${data.precio_original}
<strong>Precio interpolado:</strong> ${data.precio_interpolado}
<strong>Categoría referencia:</strong> ${data.categoria_ref}
<strong>Correlación:</strong> r = ${data.correlacion ? data.correlacion.toFixed(3) : 'n/a'}

<strong>Detalle:</strong>
${data.detalle || ''}

La interpolación se publica con marca de transparencia en el dashboard.
    `.trim()
  }),

  alta_volatilidad: (data) => ({
    asunto: `📈 IGU - Alta volatilidad aceptada (${data.categoria})`,
    cuerpo: `
Se registró un movimiento fuera de ±3σ en <strong>${data.categoria}</strong> 
pero con volumen normal → aceptado como movimiento real.

<strong>Variación:</strong> ${data.variacion ? data.variacion.toFixed(2) + '%' : 'n/a'}
<strong>Desvíos sigma:</strong> ${data.sigma ? data.sigma.toFixed(2) + 'σ' : 'n/a'}
<strong>Volumen:</strong> ${data.volumen} cabezas (${data.volumen_relativo ? (data.volumen_relativo * 100).toFixed(0) + '%' : 'n/a'} del promedio)

Podría reflejar un shock de mercado real. Sugerencia: revisar noticias macro 
(precios internacionales, política comercial, clima) y posiblemente comentar 
en el newsletter de esta semana.
    `.trim()
  }),

  volumen_bajo: (data) => ({
    asunto: `📉 IGU - Volumen semanal bajo`,
    cuerpo: `
El volumen total transado esta semana fue significativamente menor al habitual.

<strong>Semana:</strong> ${data.fecha}
<strong>Volumen semana:</strong> ${data.volumen_actual}
<strong>Volumen promedio 4 semanas:</strong> ${data.volumen_promedio}
<strong>Relativo:</strong> ${data.volumen_relativo ? (data.volumen_relativo * 100).toFixed(0) + '%' : 'n/a'}

Semanas con bajo volumen tienden a tener mayor variabilidad. El IGU de esta 
semana debería interpretarse con cautela y marcarse como "semana atípica".
    `.trim()
  }),

  publicacion_pendiente: (data) => ({
    asunto: `✅ IGU listo para publicación semanal`,
    cuerpo: `
El cálculo del IGU de esta semana está completo y listo para publicación.

<strong>Fecha:</strong> ${data.fecha}
<strong>Valor IGU:</strong> ${data.valor_igu}
<strong>Variación vs semana anterior:</strong> ${data.variacion}%

<strong>Desglose:</strong>
${data.desglose || 'ver dashboard'}

<strong>Banderas:</strong>
- Interpolaciones: ${data.n_interpolados || 0}
- Alta volatilidad: ${data.n_alta_vol || 0}
- Scrapers OK: ${data.scrapers_ok || 'sí'}

Publicación programada: Lunes 09:00 UY
    `.trim()
  })
};

/**
 * Envía una alerta por email. Si ALERT_ENABLED=false, solo loguea en consola.
 * Registra en tabla alertas_enviadas antes y después del envío.
 *
 * @param {string} tipo - clave de PLANTILLAS
 * @param {Object} data - datos para la plantilla
 * @param {Database} db - (opcional) instancia SQLite para loguear
 */
async function alertar(tipo, data, db = null) {
  if (!PLANTILLAS[tipo]) {
    console.error(`  ⚠ Tipo de alerta desconocido: ${tipo}`);
    return { enviado: false, error: 'tipo_invalido' };
  }

  const { asunto, cuerpo } = PLANTILLAS[tipo](data);

  // Log antes de enviar (por si el envío falla)
  let alertaId = null;
  if (db) {
    try {
      const result = db.prepare(`
        INSERT INTO alertas_enviadas (tipo, fuente, categoria_codigo, asunto, cuerpo, enviado)
        VALUES (?, ?, ?, ?, ?, 0)
      `).run(tipo, data.fuente || null, data.categoria || null, asunto, cuerpo);
      alertaId = result.lastInsertRowid;
    } catch (err) {
      console.error('  ⚠ Error logueando alerta:', err.message);
    }
  }

  if (!ENABLED) {
    console.log(`  📧 [DESHABILITADO] Alerta "${tipo}": ${asunto}`);
    if (alertaId && db) {
      db.prepare(`UPDATE alertas_enviadas SET enviado = -1, error_msg = ? WHERE id = ?`)
        .run('ALERT_ENABLED=false', alertaId);
    }
    return { enviado: false, deshabilitado: true };
  }

  const t = getTransporter();
  if (!t) {
    console.error('  ✗ SMTP no configurado. Revisar SMTP_HOST/USER/PASS en env.');
    return { enviado: false, error: 'smtp_no_configurado' };
  }

  try {
    await t.sendMail({
      from: FROM,
      to: TO,
      subject: asunto,
      html: cuerpo.replace(/\n/g, '<br>\n'),
      text: cuerpo.replace(/<[^>]+>/g, '')
    });

    console.log(`  📧 Alerta enviada: ${asunto}`);
    if (alertaId && db) {
      db.prepare(`UPDATE alertas_enviadas SET enviado = 1 WHERE id = ?`).run(alertaId);
    }
    return { enviado: true };

  } catch (err) {
    console.error(`  ✗ Error enviando email: ${err.message}`);
    if (alertaId && db) {
      db.prepare(`UPDATE alertas_enviadas SET enviado = -1, error_msg = ? WHERE id = ?`)
        .run(err.message, alertaId);
    }
    return { enviado: false, error: err.message };
  }
}

/**
 * Prueba de conexión SMTP (útil para diagnosticar desde /admin/test-smtp)
 */
async function probarConexion() {
  const t = getTransporter();
  if (!t) return { ok: false, error: 'SMTP no configurado' };

  try {
    await t.verify();
    return { ok: true, mensaje: 'Conexión SMTP OK' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  alertar,
  probarConexion,
  PLANTILLAS
};
