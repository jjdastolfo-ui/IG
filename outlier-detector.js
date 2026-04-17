// outlier-detector.js
// IGU - Módulo de Detección de Outliers
//
// REGLAS (decididas 17/4/2026):
// - Ventana cálculo σ: 26 semanas (6 meses)
// - Umbral outlier: 3 desvíos estándar sobre variación % semanal
// - Volumen bajo: <25% del promedio móvil de 4 semanas
// - INAC (NG/VG/VQ): NO se aplica detección (fuente oficial)
// - Plaza Rural / Pantalla (TE/VI): SÍ se aplica detección
//
// FLUJO:
// 1. Si fuente = 'inac' → aceptar siempre
// 2. Si categoría fuera de 3σ:
//    a. Si volumen >= 25% promedio → aceptar con flag 'alta_volatilidad'
//    b. Si volumen < 25% promedio → marcar como OUTLIER (candidato a interpolar)
// 3. Si categoría dentro de 3σ → aceptar normal

const VENTANA_SIGMA = 26;
const UMBRAL_SIGMA = 3;
const VENTANA_VOLUMEN = 4;
const UMBRAL_VOLUMEN_PCT = 0.25;

const FUENTES_CONFIABLES = ['inac'];  // sin outlier check

/**
 * Calcula media y desvío estándar muestral de un array.
 */
function estadisticos(valores) {
  if (!valores || valores.length < 2) {
    return { media: 0, desvio: 0, n: 0 };
  }
  const n = valores.length;
  const media = valores.reduce((a, b) => a + b, 0) / n;
  const varianza = valores.reduce((acc, v) => acc + Math.pow(v - media, 2), 0) / (n - 1);
  const desvio = Math.sqrt(varianza);
  return { media, desvio, n };
}

/**
 * Variación % entre dos valores.
 */
function variacionPct(actual, anterior) {
  if (!anterior || anterior === 0) return 0;
  return ((actual - anterior) / anterior) * 100;
}

/**
 * Obtiene las últimas N variaciones % semanales de una categoría desde la DB.
 * Excluye datos marcados como outlier o interpolado (para no contaminar el σ).
 */
function obtenerVariacionesHistoricas(db, categoria, fechaCorte, n = VENTANA_SIGMA) {
  const stmt = db.prepare(`
    SELECT precio, fecha
    FROM precios_raw
    WHERE categoria_codigo = ?
      AND fecha < ?
      AND COALESCE(es_outlier, 0) = 0
      AND COALESCE(es_interpolado, 0) = 0
      AND fuente IN ('inac', 'plaza_rural', 'pantalla_uruguay')
    ORDER BY fecha DESC
    LIMIT ?
  `);

  const filas = stmt.all(categoria, fechaCorte, n + 1);
  if (filas.length < 2) return [];

  // Invertir a orden cronológico para calcular variaciones
  const ordenadas = filas.reverse();
  const variaciones = [];

  for (let i = 1; i < ordenadas.length; i++) {
    const v = variacionPct(ordenadas[i].precio, ordenadas[i - 1].precio);
    variaciones.push(v);
  }

  return variaciones;
}

/**
 * Obtiene el precio previo de una categoría (último antes de fechaCorte).
 */
function obtenerPrecioPrevio(db, categoria, fechaCorte) {
  const stmt = db.prepare(`
    SELECT precio FROM precios_raw
    WHERE categoria_codigo = ?
      AND fecha < ?
      AND COALESCE(es_outlier, 0) = 0
    ORDER BY fecha DESC
    LIMIT 1
  `);
  const fila = stmt.get(categoria, fechaCorte);
  return fila ? fila.precio : null;
}

/**
 * Obtiene el promedio de volumen de las últimas N semanas para una categoría+fuente.
 */
function obtenerVolumenPromedio(db, categoria, fuente, fechaCorte, n = VENTANA_VOLUMEN) {
  const stmt = db.prepare(`
    SELECT AVG(volumen) as vol_promedio, COUNT(*) as n
    FROM precios_raw
    WHERE categoria_codigo = ?
      AND fuente = ?
      AND fecha < ?
      AND volumen IS NOT NULL
      AND volumen > 0
    ORDER BY fecha DESC
    LIMIT ?
  `);
  const resultado = stmt.get(categoria, fuente, fechaCorte, n);
  return resultado && resultado.n > 0 ? resultado.vol_promedio : null;
}

/**
 * Función principal de detección.
 * Analiza un dato candidato y devuelve veredicto.
 *
 * @param {Object} dato - { fecha, categoria_codigo, fuente, precio, volumen, ... }
 * @param {Database} db
 * @returns {Object} { decision, motivo, detalle, ...campos para insertar }
 */
function analizarOutlier(dato, db) {
  const { fecha, categoria_codigo, fuente, precio, volumen } = dato;

  const resultado = {
    decision: 'ACEPTAR',  // ACEPTAR | ACEPTAR_CON_FLAG | OUTLIER
    motivo: null,
    detalle: null,
    es_outlier: 0,
    desvios_sigma: null,
    volumen_relativo: null,
    variacion_pct: null
  };

  // ============================================================
  // REGLA 1: Si la fuente es confiable (INAC), aceptar siempre
  // ============================================================
  if (FUENTES_CONFIABLES.includes(fuente)) {
    resultado.motivo = 'fuente_oficial';
    resultado.detalle = `Fuente ${fuente.toUpperCase()} es oficial. No se aplica detección de outlier.`;
    return resultado;
  }

  // ============================================================
  // REGLA 2: Para fuentes de mercado, calcular desvío vs histórico
  // ============================================================
  const precioAnterior = obtenerPrecioPrevio(db, categoria_codigo, fecha);

  if (!precioAnterior) {
    resultado.motivo = 'sin_historico';
    resultado.detalle = 'Sin precio previo disponible. Aceptado como primer dato de la serie.';
    return resultado;
  }

  const variacion = variacionPct(precio, precioAnterior);
  resultado.variacion_pct = variacion;

  const variacionesHist = obtenerVariacionesHistoricas(db, categoria_codigo, fecha, VENTANA_SIGMA);

  // Si no hay suficiente histórico (< 4 semanas), no podemos calcular σ confiable
  if (variacionesHist.length < 4) {
    resultado.motivo = 'historico_insuficiente';
    resultado.detalle = `Solo ${variacionesHist.length} variaciones históricas disponibles. Se requieren 4+ para calcular σ. Dato aceptado.`;
    return resultado;
  }

  const { media, desvio } = estadisticos(variacionesHist);

  // Si σ es muy chico (serie sin movimiento), usar piso de 2%
  const desvioEfectivo = Math.max(desvio, 2.0);

  const desvios = desvio > 0 ? Math.abs(variacion - media) / desvioEfectivo : 0;
  resultado.desvios_sigma = desvios;

  // ============================================================
  // REGLA 3: Si la variación está dentro de 3σ, aceptar normal
  // ============================================================
  if (desvios <= UMBRAL_SIGMA) {
    resultado.motivo = 'dentro_de_rango';
    resultado.detalle = `Variación ${variacion.toFixed(2)}% está a ${desvios.toFixed(2)}σ de la media (${media.toFixed(2)}%, σ=${desvioEfectivo.toFixed(2)}%). Dentro de ±3σ.`;
    return resultado;
  }

  // ============================================================
  // REGLA 4: Fuera de 3σ → chequear volumen
  // ============================================================
  const volumenPromedio = obtenerVolumenPromedio(db, categoria_codigo, fuente, fecha, VENTANA_VOLUMEN);

  if (!volumenPromedio || !volumen || volumen === 0) {
    // Sin referencia de volumen, ser conservador: marcar como outlier
    resultado.decision = 'OUTLIER';
    resultado.es_outlier = 1;
    resultado.motivo = 'fuera_sigma_sin_volumen';
    resultado.detalle = `Variación ${variacion.toFixed(2)}% a ${desvios.toFixed(2)}σ, sin datos de volumen para validar. Candidato a interpolación.`;
    return resultado;
  }

  const volumenRelativo = volumen / volumenPromedio;
  resultado.volumen_relativo = volumenRelativo;

  if (volumenRelativo < UMBRAL_VOLUMEN_PCT) {
    // Volumen bajo + fuera de sigma = OUTLIER confirmado
    resultado.decision = 'OUTLIER';
    resultado.es_outlier = 1;
    resultado.motivo = 'outlier_confirmado';
    resultado.detalle = `Variación ${variacion.toFixed(2)}% a ${desvios.toFixed(2)}σ + volumen ${volumen} (${(volumenRelativo * 100).toFixed(0)}% del promedio 4 semanas). OUTLIER - candidato a interpolación.`;
  } else {
    // Volumen OK pero variación alta: aceptar con flag de alta volatilidad
    resultado.decision = 'ACEPTAR_CON_FLAG';
    resultado.motivo = 'alta_volatilidad_real';
    resultado.detalle = `Variación ${variacion.toFixed(2)}% a ${desvios.toFixed(2)}σ PERO volumen ${volumen} (${(volumenRelativo * 100).toFixed(0)}% del promedio) es normal. Movimiento real aceptado con flag.`;
  }

  return resultado;
}

/**
 * Registra decisión en tabla de log público.
 */
function registrarDecision(db, dato, resultado) {
  try {
    db.prepare(`
      INSERT INTO log_decisiones (
        fecha_publicacion, categoria_codigo, tipo_decision,
        detalle, precio_original, precio_final, volumen, desvios_sigma
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      dato.fecha,
      dato.categoria_codigo,
      resultado.motivo,
      resultado.detalle,
      dato.precio,
      resultado.decision === 'OUTLIER' ? null : dato.precio,
      dato.volumen || null,
      resultado.desvios_sigma
    );
  } catch (err) {
    console.error('Error registrando decisión:', err.message);
  }
}

module.exports = {
  analizarOutlier,
  registrarDecision,
  estadisticos,
  variacionPct,
  // Exportados para tests
  VENTANA_SIGMA,
  UMBRAL_SIGMA,
  VENTANA_VOLUMEN,
  UMBRAL_VOLUMEN_PCT
};
