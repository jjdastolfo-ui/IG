// analisis-claude.js
// Capa 3 de auditoria: analisis narrativo con Claude API
//
// Se activa SOLO cuando hay anomalias que ameritan analisis profesional.
// NO corre automaticamente cada semana.
//
// TRIGGERS (cualquiera activa el analisis):
//   - Capa A: discrepancia fuente-base > 2%
//   - Capa B: diferencia cruzada > 10%
//   - Capa C: variacion vs promedio historico > 5%
//   - IGU: variacion semanal > 3%
//   - Healthcheck: estado critical
//
// ANTI-SPAM:
//   Si la misma anomalia persiste, solo envia email la primera vez
//   y la silencia por 7 dias.
//
// COSTO APROX: USD 0.05-0.10 por analisis (Claude Sonnet 4.5)

const UMBRAL_DISCREPANCIA_CAPA_A = 2.0;
const UMBRAL_CRUZADA_CAPA_B = 10.0;
const UMBRAL_HISTORICO_CAPA_C = 5.0;
const UMBRAL_VARIACION_SEMANAL_IGU = 3.0;
const SILENCIO_DIAS = 7;
const MODELO_CLAUDE = 'claude-sonnet-4-5';

/**
 * Evalua si hay anomalias que ameriten llamar a Claude.
 * Devuelve un objeto con disparadores o null si todo OK.
 */
function detectarAnomalias(auditoriaResultado, healthcheckResultado, iguActual) {
  const triggers = [];

  // Capa A - discrepancias fuente vs DB
  if (auditoriaResultado?.capa_A?.detalles) {
    const { warnings = [], criticas = [] } = auditoriaResultado.capa_A.detalles;
    [...warnings, ...criticas].forEach(r => {
      if (r.diferencia_pct > UMBRAL_DISCREPANCIA_CAPA_A) {
        triggers.push({
          tipo: 'capa_a_discrepancia',
          severidad: r.diferencia_pct > 5 ? 'critical' : 'warning',
          detalle: `${r.fuente}/${r.categoria}: DB=${r.valor_db} vs fuente=${r.valor_fuente} (${r.diferencia_pct}%)`,
          datos: r
        });
      }
    });
  }

  // Capa B - divergencia cruzada Plaza vs Pantalla
  if (auditoriaResultado?.capa_B?.detalles?.discrepancias) {
    auditoriaResultado.capa_B.detalles.discrepancias.forEach(r => {
      if (r.diferencia_pct > UMBRAL_CRUZADA_CAPA_B) {
        triggers.push({
          tipo: 'capa_b_cruzada',
          severidad: 'warning',
          detalle: `${r.categoria}: Plaza=${r.plaza_rural} vs Pantalla=${r.pantalla_uruguay} (${r.diferencia_pct}%)`,
          datos: r
        });
      }
    });
  }

  // Capa C - variacion historica
  if (auditoriaResultado?.capa_C?.detalles?.alertas) {
    auditoriaResultado.capa_C.detalles.alertas.forEach(r => {
      const abs = Math.abs(r.variacion_pct);
      if (abs > UMBRAL_HISTORICO_CAPA_C) {
        triggers.push({
          tipo: 'capa_c_historico',
          severidad: abs > 10 ? 'critical' : 'warning',
          detalle: `${r.categoria}: ${r.variacion_pct >= 0 ? '+' : ''}${r.variacion_pct}% vs promedio 8sem`,
          datos: r
        });
      }
    });
  }

  // IGU variacion semanal
  if (iguActual?.variacion_diaria != null) {
    const abs = Math.abs(iguActual.variacion_diaria);
    if (abs > UMBRAL_VARIACION_SEMANAL_IGU) {
      triggers.push({
        tipo: 'igu_volatil',
        severidad: abs > 5 ? 'critical' : 'warning',
        detalle: `IGU vario ${iguActual.variacion_diaria.toFixed(2)}% en la semana`,
        datos: iguActual
      });
    }
  }

  // Healthcheck critical
  if (healthcheckResultado?.estado_general === 'critical') {
    healthcheckResultado.alertas_criticas.forEach(a => {
      triggers.push({
        tipo: 'healthcheck_critical',
        severidad: 'critical',
        detalle: `${a.check}: ${a.mensaje}`,
        datos: a
      });
    });
  }

  return triggers.length > 0 ? triggers : null;
}

/**
 * Construye un "hash" de la situacion para anti-spam.
 * Si los mismos triggers persisten, no re-enviar antes de SILENCIO_DIAS.
 */
function hashTriggers(triggers) {
  const resumen = triggers
    .map(t => `${t.tipo}|${t.detalle.slice(0, 40)}`)
    .sort()
    .join('||');
  // Hash simple
  let hash = 0;
  for (let i = 0; i < resumen.length; i++) {
    hash = ((hash << 5) - hash) + resumen.charCodeAt(i);
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Verifica si ya enviamos un email con los mismos triggers en los ultimos 7 dias.
 * Devuelve true si deberiamos silenciar.
 */
function debeSilenciarse(db, triggersHash) {
  try {
    const row = db.prepare(`
      SELECT id, fecha_envio FROM analisis_claude_log
      WHERE triggers_hash = ?
        AND email_enviado = 1
        AND datetime(fecha_envio) > datetime('now', '-${SILENCIO_DIAS} days')
      ORDER BY fecha_envio DESC LIMIT 1
    `).get(triggersHash);
    return !!row;
  } catch (err) {
    return false;
  }
}

/**
 * Construye el contexto que le mandamos a Claude para que analice.
 */
function construirPromptClaude(triggers, auditoriaResultado, healthcheckResultado, iguActual, historicoIGU) {
  const triggersFormateados = triggers
    .map((t, i) => `${i + 1}. [${t.severidad.toUpperCase()}] ${t.tipo}: ${t.detalle}`)
    .join('\n');

  const preciosActuales = auditoriaResultado?.capa_A?.detalles?.ok || [];
  const preciosDisplay = preciosActuales
    .map(p => `  ${p.fuente} / ${p.categoria}: ${p.valor_db} USD/kg`)
    .join('\n');

  const historicoDisplay = (historicoIGU || []).slice(-8)
    .map(r => `  ${r.fecha}: IGU=${r.igu_general?.toFixed(4)} | Sub-Carne=${r.sub_carne?.toFixed(4)} | Sub-Reposicion=${r.sub_reposicion?.toFixed(4)} | Sub-Cria=${r.sub_cria?.toFixed(4)}`)
    .join('\n');

  const variacionHistoricaStr = auditoriaResultado?.capa_C?.detalles?.alertas
    ?.map(a => `  ${a.categoria}: actual ${a.precio_ultimo} vs promedio 8 semanas ${a.promedio_historico} (${a.variacion_pct >= 0 ? '+' : ''}${a.variacion_pct}%)`)
    .join('\n') || '  Ninguna.';

  return `Sos un analista senior del mercado ganadero uruguayo. El Indice Ganadero Uruguayo (IGU) es un indice Laspeyres ponderado de 6 categorias que mide la evolucion semanal del mercado ganadero uruguayo. Base 1.0000 = viernes 2 de enero 2026.

Categorias y ponderaciones:
- NG Novillo Gordo (38%) - INAC 4ta balanza USD/kg canal
- VG Vaca Gorda (25%) - INAC 4ta balanza USD/kg canal
- TE Ternero (15%) - Plaza Rural + Pantalla Uruguay USD/kg vivo
- VQ Vaquillona Gorda (12%) - INAC 4ta balanza USD/kg canal
- VI Vaca de Invernada (7%) - Plaza Rural + Pantalla Uruguay USD/kg vivo
- VP Vacas/Vaquillonas Preñadas (3%) - Plaza Rural + Pantalla Uruguay, convertido de USD/cab dividiendo por 420 kg

IGU actual: ${iguActual?.igu_general?.toFixed(4) || 'N/A'} (fecha: ${iguActual?.fecha || 'N/A'})
Variacion semanal: ${iguActual?.variacion_diaria?.toFixed(2) || 'N/A'}%
Variacion mensual: ${iguActual?.variacion_mensual?.toFixed(2) || 'N/A'}%

Sub-indices:
- Sub-Carne (NG+VG+VQ, 75%): ${iguActual?.sub_carne?.toFixed(4) || 'N/A'}
- Sub-Reposicion (TE+VI, 22%): ${iguActual?.sub_reposicion?.toFixed(4) || 'N/A'}
- Sub-Cria (VP, 3%): ${iguActual?.sub_cria?.toFixed(4) || 'N/A'}

ANOMALIAS DETECTADAS (triggers del sistema automatico):
${triggersFormateados}

Precios actuales auditados (matches exactos con fuente):
${preciosDisplay || '  (sin datos)'}

Variaciones historicas detectadas (Capa C):
${variacionHistoricaStr}

Serie IGU ultimas 8 semanas:
${historicoDisplay || '  (sin historico)'}

---

TU TAREA:
Escribir un informe ejecutivo profesional en español rioplatense (usos: "vos", "te", tono profesional pero cercano) siguiendo esta estructura:

**Situacion**
Describi concretamente que pasa, con numeros especificos.

**Validacion tecnica**
Confirmar si las anomalias son errores de datos (Capa A) o movimientos reales de mercado. Si Capa A muestra 0.00% de diferencia, significa que el dato es verdadero (no hay bug).

**Contexto de mercado**
Analizar la anomalia en contexto de las demas categorias. Buscar divergencias, correlaciones rotas, patrones temporales.

**Hipotesis plausibles**
Listar 2-4 razones posibles del movimiento. NO inventes datos que no tenes. Si no podes saber la causa con certeza, se honesto y sugeri verificacion con fuente primaria.

**Impacto en el IGU**
Como afecta al indice general y sub-indices.

**Conclusion**
En 1-2 frases: ¿requiere accion? ¿es error tecnico o mercado? ¿que recomendas monitorear?

IMPORTANTE:
- NO inventes cifras que no esten en los datos.
- NO des recomendaciones de inversion o compra/venta.
- NO uses jerga muy tecnica, pero si precisa.
- Longitud: 250-400 palabras.
- Lenguaje directo, sin muletillas.
- Sin bullet points excesivos — prosa clara.`;
}

/**
 * Llama a la API de Claude y obtiene el analisis narrativo.
 */
async function llamarClaudeAPI(prompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: MODELO_CLAUDE,
      max_tokens: 1500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Claude API error ${response.status}: ${errText}`);
  }

  const data = await response.json();
  const texto = data.content
    .filter(c => c.type === 'text')
    .map(c => c.text)
    .join('\n');

  return {
    texto,
    modelo: data.model,
    input_tokens: data.usage?.input_tokens,
    output_tokens: data.usage?.output_tokens
  };
}

/**
 * Envia el analisis por email.
 */
async function enviarEmailAnalisis(analisis, triggers, contexto) {
  const emailTo = process.env.EMAIL_TO;
  const emailFrom = process.env.EMAIL_FROM || 'onboarding@resend.dev';
  if (!emailTo) throw new Error('EMAIL_TO no configurado');

  const { Resend } = require('resend');
  const resend = new Resend(process.env.RESEND_API_KEY);

  // Color segun severidad mas alta
  const severidadMax = triggers.some(t => t.severidad === 'critical') ? 'critical' : 'warning';
  const color = severidadMax === 'critical' ? '#a84032' : '#c4914e';
  const emoji = severidadMax === 'critical' ? '🔴' : '⚠️';

  const triggerTitulo = triggers[0].detalle.slice(0, 60);
  const subject = `🧠 IGU · Análisis de anomalía — ${triggerTitulo}`;

  // Convertir markdown basico a HTML
  const analisisHTML = analisis.texto
    .replace(/\*\*(.+?)\*\*/g, '<strong style="color:#2d4a2b;">$1</strong>')
    .replace(/^(.+)$/gm, '<p style="margin:0 0 12px;line-height:1.6;">$1</p>')
    .replace(/<p[^>]*><\/p>/g, '');

  const triggersHTML = triggers
    .map(t => `<li style="margin:4px 0;color:${t.severidad === 'critical' ? '#a84032' : '#c4914e'};">
      <strong>${t.tipo}:</strong> ${t.detalle}
    </li>`)
    .join('');

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="font-family:-apple-system,'Segoe UI',sans-serif;background:#f5f1e6;margin:0;padding:20px;">
  <div style="max-width:720px;margin:0 auto;background:#fcfaf3;border-radius:12px;overflow:hidden;">

    <div style="background:${color};color:white;padding:24px;text-align:center;">
      <div style="font-size:2rem;">🧠</div>
      <h1 style="margin:8px 0 4px;font-size:1.3rem;font-weight:500;">IGU · Análisis de Anomalía</h1>
      <p style="margin:0;opacity:0.9;font-size:0.85rem;">${new Date().toISOString()}</p>
    </div>

    <div style="padding:24px;">

      <div style="background:#f5f1e6;padding:12px 16px;border-left:3px solid ${color};border-radius:6px;margin-bottom:20px;">
        <p style="margin:0 0 8px;color:#3a3a2d;font-weight:600;">${emoji} Disparadores detectados:</p>
        <ul style="margin:0;padding-left:20px;font-size:0.85rem;">${triggersHTML}</ul>
      </div>

      <h3 style="color:#2d4a2b;margin:20px 0 12px;border-bottom:1px solid #e6dfc9;padding-bottom:8px;">📋 Informe ejecutivo</h3>
      <div style="color:#3a3a2d;font-size:0.95rem;line-height:1.7;">
        ${analisisHTML}
      </div>

      <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e6dfc9;font-size:0.75rem;color:#8c8670;">
        <p style="margin:0 0 8px;"><strong>Datos del analisis:</strong></p>
        <p style="margin:0;">Modelo: ${analisis.modelo} · Tokens: ${analisis.input_tokens} in + ${analisis.output_tokens} out</p>
        <p style="margin:8px 0 0;">Este analisis es generado automaticamente por Claude AI y NO constituye asesoramiento financiero.</p>
      </div>

      <div style="margin-top:20px;text-align:center;font-size:0.8rem;color:#8c8670;">
        <a href="https://www.igu.com.uy/admin/auditoria-ultima?secret=IGU_INIT_2026" style="color:#2d4a2b;">Ver detalle tecnico ↗</a>
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

/**
 * Orquestador principal: ejecuta analisis si hay anomalias.
 */
async function ejecutarAnalisisSiHayAnomalias(db, auditoriaResultado, healthcheckResultado) {
  const inicio = Date.now();

  // 1. Obtener IGU actual e historico
  const iguActual = db.prepare(`
    SELECT * FROM indice ORDER BY fecha DESC LIMIT 1
  `).get();
  const historicoIGU = db.prepare(`
    SELECT * FROM indice ORDER BY fecha DESC LIMIT 8
  `).all().reverse();

  // 2. Detectar anomalias
  const triggers = detectarAnomalias(auditoriaResultado, healthcheckResultado, iguActual);

  if (!triggers) {
    return {
      accion: 'sin_anomalias',
      mensaje: 'No se detectaron anomalias. No se llamo a Claude.'
    };
  }

  // 3. Anti-spam: hash y chequeo
  const hash = hashTriggers(triggers);

  if (debeSilenciarse(db, hash)) {
    return {
      accion: 'silenciado',
      mensaje: `Anomalia ya reportada en los ultimos ${SILENCIO_DIAS} dias. Omitiendo email.`,
      triggers_hash: hash,
      triggers
    };
  }

  // 4. Construir prompt y llamar a Claude
  const prompt = construirPromptClaude(triggers, auditoriaResultado, healthcheckResultado, iguActual, historicoIGU);
  const analisis = await llamarClaudeAPI(prompt);

  // 5. Enviar email
  const envio = await enviarEmailAnalisis(analisis, triggers, { iguActual });

  // 6. Loguear para anti-spam futuro
  guardarLogAnalisis(db, {
    triggers_hash: hash,
    triggers_json: JSON.stringify(triggers),
    analisis_texto: analisis.texto,
    modelo: analisis.modelo,
    input_tokens: analisis.input_tokens,
    output_tokens: analisis.output_tokens,
    email_enviado: 1,
    email_id: envio.resend_id,
    duracion_ms: Date.now() - inicio
  });

  return {
    accion: 'analisis_enviado',
    triggers_detectados: triggers.length,
    email: envio,
    tokens: `${analisis.input_tokens} in + ${analisis.output_tokens} out`,
    duracion_ms: Date.now() - inicio
  };
}

function guardarLogAnalisis(db, datos) {
  try {
    db.prepare(`
      INSERT INTO analisis_claude_log
      (triggers_hash, triggers_json, analisis_texto, modelo,
       input_tokens, output_tokens, email_enviado, email_id, duracion_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      datos.triggers_hash, datos.triggers_json, datos.analisis_texto,
      datos.modelo, datos.input_tokens, datos.output_tokens,
      datos.email_enviado, datos.email_id, datos.duracion_ms
    );
  } catch (err) {
    console.error('[analisis-claude] Error guardando log:', err.message);
  }
}

module.exports = {
  ejecutarAnalisisSiHayAnomalias,
  detectarAnomalias,
  llamarClaudeAPI,
  enviarEmailAnalisis,
  construirPromptClaude
};
