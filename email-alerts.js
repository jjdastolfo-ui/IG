// email-alerts.js
// Envio de alertas por email usando Resend (https://resend.com)
//
// Setup requerido:
//   1. Crear cuenta en resend.com (gratis, 3000 emails/mes)
//   2. Verificar dominio (o usar el de prueba)
//   3. Generar API key
//   4. En Railway, agregar variables de entorno:
//        RESEND_API_KEY=re_xxxxxxxxxxxxx
//        EMAIL_FROM=alertas@igu.com.uy  (o onboarding@resend.dev si no verificas dominio)
//        EMAIL_TO=jonatan@tudominio.com (o el que prefieras)
//
// Uso:
//   const { enviarAlerta } = require('./email-alerts');
//   await enviarAlerta(resultadoHealthcheck);

// Resend se importa dinamicamente para no romper si no esta instalado
async function getResend() {
  try {
    const { Resend } = require('resend');
    const apiKey = process.env.RESEND_API_KEY;
    if (!apiKey) {
      throw new Error('RESEND_API_KEY no configurada en variables de entorno');
    }
    return new Resend(apiKey);
  } catch (err) {
    if (err.message.includes('Cannot find module')) {
      throw new Error('Paquete "resend" no instalado. Agregar a package.json: "resend": "^4.0.0"');
    }
    throw err;
  }
}

function formatearEmailHTML(resultado) {
  const colorEstado = {
    ok: '#2d7a3e',
    warning: '#c4914e',
    critical: '#a84032'
  }[resultado.estado_general] || '#6b6b5c';

  const emojiEstado = {
    ok: '✅',
    warning: '⚠️',
    critical: '🔴'
  }[resultado.estado_general] || '❓';

  const alertasCriticas = resultado.alertas_criticas.map(a =>
    `<li style="margin: 4px 0; color: #a84032;"><strong>${a.check}:</strong> ${a.mensaje}</li>`
  ).join('');

  const alertasWarning = resultado.alertas_warning.map(a =>
    `<li style="margin: 4px 0; color: #c4914e;"><strong>${a.check}:</strong> ${a.mensaje}</li>`
  ).join('');

  const checksOK = resultado.checks_ok.map(c =>
    `<li style="margin: 2px 0; color: #2d7a3e;">✓ ${c}</li>`
  ).join('');

  const detalles = Object.entries(resultado.detalles).map(([k, v]) => {
    const valor = typeof v === 'object' ? JSON.stringify(v) : v;
    return `<tr><td style="padding: 4px 8px; border: 1px solid #e6dfc9;"><code>${k}</code></td><td style="padding: 4px 8px; border: 1px solid #e6dfc9;">${valor}</td></tr>`;
  }).join('');

  return `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>IGU Healthcheck</title></head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f5f1e6; margin: 0; padding: 20px;">
  <div style="max-width: 700px; margin: 0 auto; background: #fcfaf3; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,0.08);">

    <div style="background: ${colorEstado}; color: white; padding: 24px; text-align: center;">
      <div style="font-size: 2rem; margin-bottom: 8px;">${emojiEstado}</div>
      <h1 style="margin: 0; font-size: 1.4rem; font-weight: 500;">IGU Healthcheck · ${resultado.estado_general.toUpperCase()}</h1>
      <p style="margin: 8px 0 0; opacity: 0.9; font-size: 0.85rem;">${resultado.timestamp}</p>
    </div>

    <div style="padding: 24px;">
      <p style="margin: 0 0 16px; font-size: 1rem; color: #3a3a2d;">
        <strong>Resumen:</strong> ${resultado.resumen_ejecutivo}
      </p>

      ${resultado.alertas_criticas.length > 0 ? `
        <h3 style="color: #a84032; margin: 20px 0 8px;">🔴 Alertas Criticas</h3>
        <ul style="margin: 0; padding-left: 20px;">${alertasCriticas}</ul>
      ` : ''}

      ${resultado.alertas_warning.length > 0 ? `
        <h3 style="color: #c4914e; margin: 20px 0 8px;">⚠️ Warnings</h3>
        <ul style="margin: 0; padding-left: 20px;">${alertasWarning}</ul>
      ` : ''}

      ${resultado.checks_ok.length > 0 ? `
        <h3 style="color: #2d7a3e; margin: 20px 0 8px;">✅ Checks OK (${resultado.checks_ok.length})</h3>
        <ul style="margin: 0; padding-left: 20px; font-size: 0.9rem;">${checksOK}</ul>
      ` : ''}

      ${Object.keys(resultado.detalles).length > 0 ? `
        <h3 style="color: #3a3a2d; margin: 24px 0 8px;">📊 Detalles</h3>
        <table style="width: 100%; border-collapse: collapse; font-size: 0.85rem;">
          ${detalles}
        </table>
      ` : ''}

      <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e6dfc9; font-size: 0.8rem; color: #8c8670; text-align: center;">
        Sistema de auditoria automatica IGU v2.2<br>
        <a href="https://www.igu.com.uy/admin/healthcheck?secret=IGU_INIT_2026" style="color: #2d4a2b;">Ver ultimo check en vivo ↗</a>
      </div>
    </div>
  </div>
</body></html>
  `;
}

/**
 * Envia alerta por email si el estado es warning o critical.
 * Si el estado es 'ok', no envia nada (para no saturar).
 * Forzar envio siempre con opciones.forzar = true.
 */
async function enviarAlerta(resultado, opciones = {}) {
  const { forzar = false } = opciones;

  // Solo enviar si hay alertas (salvo que se fuerce)
  if (!forzar && resultado.estado_general === 'ok') {
    return {
      enviado: false,
      motivo: 'Estado OK, no hay alertas que enviar'
    };
  }

  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';

  if (!emailTo) {
    throw new Error('EMAIL_TO no configurado en variables de entorno');
  }

  const resend = await getResend();
  const subject = `${resultado.estado_general === 'critical' ? '🔴' : '⚠️'} IGU ${resultado.estado_general.toUpperCase()} - ${resultado.alertas_criticas.length + resultado.alertas_warning.length} alerta(s)`;
  const html = formatearEmailHTML(resultado);

  const response = await resend.emails.send({
    from: emailFrom,
    to: emailTo,
    subject,
    html
  });

  return {
    enviado: true,
    resend_id: response.data?.id || response.id,
    destinatario: emailTo,
    subject
  };
}

module.exports = { enviarAlerta, formatearEmailHTML };
