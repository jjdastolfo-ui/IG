// interpolator.js
// IGU - Módulo de Interpolación para datos marcados como outlier
//
// LÓGICA:
// Cuando una categoría es marcada como OUTLIER (fuera de 3σ + volumen bajo),
// se reemplaza su precio con una estimación basada en la categoría más
// correlacionada que SÍ tiene dato válido esa semana.
//
// Método: regresión lineal simple con coeficientes pre-calculados de
// la matriz de correlaciones (ver: calcular-correlaciones.js).
//
// Fórmula: precio_interpolado = precio_semana_anterior × (1 + variacion_estimada)
// donde variacion_estimada = beta * variacion_categoria_referencia + alpha

const CORRELACION_MINIMA = 0.70;

/**
 * Busca en la DB la matriz de correlaciones activa para una categoría.
 * Retorna las correlaciones ordenadas de mayor a menor (valor absoluto).
 */
function obtenerCorrelacionesDe(db, categoria) {
  const stmt = db.prepare(`
    SELECT categoria_b, coef_correlacion, coef_regresion, intercepto, n_observaciones
    FROM correlaciones
    WHERE categoria_a = ?
      AND activo = 1
      AND ABS(coef_correlacion) >= ?
    ORDER BY ABS(coef_correlacion) DESC
  `);
  return stmt.all(categoria, CORRELACION_MINIMA);
}

/**
 * Obtiene el precio aceptado de una categoría en una fecha específica.
 * Ignora outliers (ya fueron filtrados/interpolados).
 */
function obtenerPrecioEn(db, categoria, fecha) {
  const stmt = db.prepare(`
    SELECT precio FROM precios_raw
    WHERE categoria_codigo = ?
      AND fecha = ?
      AND COALESCE(es_outlier, 0) = 0
    ORDER BY 
      CASE fuente WHEN 'inac' THEN 1 ELSE 2 END,
      id DESC
    LIMIT 1
  `);
  const fila = stmt.get(categoria, fecha);
  return fila ? fila.precio : null;
}

/**
 * Obtiene el precio previo de una categoría (última semana con dato válido).
 */
function obtenerPrecioPrevio(db, categoria, fechaCorte) {
  const stmt = db.prepare(`
    SELECT precio, fecha FROM precios_raw
    WHERE categoria_codigo = ?
      AND fecha < ?
      AND COALESCE(es_outlier, 0) = 0
    ORDER BY fecha DESC
    LIMIT 1
  `);
  return stmt.get(categoria, fechaCorte);
}

/**
 * Interpola el precio de una categoría marcada como outlier.
 *
 * @param {Object} datoOutlier - { fecha, categoria_codigo, precio, ... }
 * @param {Database} db
 * @returns {Object} { exito, precio_interpolado, categoria_ref, correlacion, detalle }
 */
function interpolar(datoOutlier, db) {
  const { fecha, categoria_codigo, precio } = datoOutlier;

  const resultado = {
    exito: false,
    precio_interpolado: null,
    categoria_ref: null,
    correlacion: null,
    detalle: null
  };

  // 1. Precio de la semana anterior para la categoría a interpolar
  const precioPrevio = obtenerPrecioPrevio(db, categoria_codigo, fecha);
  if (!precioPrevio) {
    resultado.detalle = `Sin precio previo para ${categoria_codigo}. No se puede interpolar.`;
    return resultado;
  }

  // 2. Buscar categoría correlacionada con dato válido esta semana
  const correlaciones = obtenerCorrelacionesDe(db, categoria_codigo);

  if (correlaciones.length === 0) {
    resultado.detalle = `Sin correlaciones >= ${CORRELACION_MINIMA} disponibles para ${categoria_codigo}.`;
    return resultado;
  }

  // 3. Probar cada correlacionada hasta encontrar una con dato válido
  for (const corr of correlaciones) {
    const categoriaRef = corr.categoria_b;

    // Precio de referencia esta semana
    const precioRefActual = obtenerPrecioEn(db, categoriaRef, fecha);
    if (!precioRefActual) continue;

    // Precio de referencia semana anterior
    const precioRefPrevio = obtenerPrecioPrevio(db, categoriaRef, fecha);
    if (!precioRefPrevio) continue;

    // Variación % de la categoría de referencia
    const varRef = ((precioRefActual - precioRefPrevio.precio) / precioRefPrevio.precio) * 100;

    // Aplicar regresión lineal: var_estimada = beta * var_ref + alpha
    const varEstimada = corr.coef_regresion * varRef + corr.intercepto;

    // Precio interpolado
    const precioInterpolado = precioPrevio.precio * (1 + varEstimada / 100);

    // Validación sanity: el precio interpolado debe ser razonable
    const variacionResultante = ((precioInterpolado - precioPrevio.precio) / precioPrevio.precio) * 100;
    if (Math.abs(variacionResultante) > 50) {
      // Interpolación dio un valor absurdo, pasar a siguiente correlacionada
      continue;
    }

    resultado.exito = true;
    resultado.precio_interpolado = parseFloat(precioInterpolado.toFixed(4));
    resultado.categoria_ref = categoriaRef;
    resultado.correlacion = corr.coef_correlacion;
    resultado.detalle = `Interpolado desde ${categoriaRef} (r=${corr.coef_correlacion.toFixed(3)}, n=${corr.n_observaciones}): ` +
                       `var_${categoriaRef}=${varRef.toFixed(2)}% → var_estimada=${varEstimada.toFixed(2)}% → ` +
                       `${precioPrevio.precio.toFixed(4)} × (1 + ${(varEstimada/100).toFixed(4)}) = ${precioInterpolado.toFixed(4)}`;

    return resultado;
  }

  // Ninguna correlacionada tenía dato utilizable
  resultado.detalle = `Ninguna de las ${correlaciones.length} categorías correlacionadas tenía dato válido esta semana.`;
  return resultado;
}

/**
 * Aplica interpolación y guarda en DB con los flags correspondientes.
 */
function aplicarInterpolacion(datoOutlier, db) {
  const interpolacion = interpolar(datoOutlier, db);

  if (!interpolacion.exito) {
    console.warn(`  ⚠ No se pudo interpolar ${datoOutlier.categoria_codigo}: ${interpolacion.detalle}`);
    return null;
  }

  const datoInterpolado = {
    ...datoOutlier,
    precio_original: datoOutlier.precio,
    precio: interpolacion.precio_interpolado,
    es_outlier: 0,
    es_interpolado: 1,
    interpolado_desde: interpolacion.categoria_ref,
    razon_descarte: `Outlier confirmado (3σ + volumen bajo). Interpolado desde ${interpolacion.categoria_ref} (r=${interpolacion.correlacion.toFixed(3)})`,
    observaciones: `${datoOutlier.observaciones || ''} [INTERPOLADO desde ${interpolacion.categoria_ref}]`
  };

  // Log en tabla de decisiones
  try {
    db.prepare(`
      INSERT INTO log_decisiones (
        fecha_publicacion, categoria_codigo, tipo_decision, detalle,
        precio_original, precio_final, volumen, categoria_referencia
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      datoOutlier.fecha,
      datoOutlier.categoria_codigo,
      'interpolacion_aplicada',
      interpolacion.detalle,
      datoOutlier.precio,
      interpolacion.precio_interpolado,
      datoOutlier.volumen || null,
      interpolacion.categoria_ref
    );
  } catch (err) {
    console.error('Error logueando interpolación:', err.message);
  }

  console.log(`  ↻ ${datoOutlier.categoria_codigo} interpolado: ${datoOutlier.precio.toFixed(4)} → ${interpolacion.precio_interpolado.toFixed(4)} (desde ${interpolacion.categoria_ref})`);

  return datoInterpolado;
}

module.exports = {
  interpolar,
  aplicarInterpolacion,
  obtenerCorrelacionesDe,
  CORRELACION_MINIMA
};
