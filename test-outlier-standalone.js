// test-outlier-standalone.js
// Tests del outlier-detector que NO dependen de better-sqlite3.
// Usa un mock mínimo de la interfaz DB.

const { test } = require('node:test');
const assert = require('node:assert');

const {
  analizarOutlier,
  estadisticos,
  variacionPct
} = require('../modulos/outlier-detector');

/**
 * Mock de la interfaz que usa outlier-detector:
 *   db.prepare(sql).all(params) → array
 *   db.prepare(sql).get(params) → objeto | undefined
 *
 * Almacenamos datos en memoria y atendemos las 3 queries que hace el módulo.
 */
function crearMockDB(datos) {
  return {
    prepare(sql) {
      return {
        all(categoria, fechaCorte, n) {
          // obtenerVariacionesHistoricas: filas ordenadas DESC por fecha
          return datos
            .filter(d => d.categoria_codigo === categoria && d.fecha < fechaCorte && !d.es_outlier && !d.es_interpolado)
            .sort((a, b) => b.fecha.localeCompare(a.fecha))
            .slice(0, n)
            .map(d => ({ precio: d.precio, fecha: d.fecha }));
        },
        get(...args) {
          if (sql.includes('AVG(volumen)')) {
            // obtenerVolumenPromedio
            const [categoria, fuente, fechaCorte, n] = args;
            const filtrados = datos
              .filter(d => d.categoria_codigo === categoria && d.fuente === fuente &&
                           d.fecha < fechaCorte && d.volumen && d.volumen > 0)
              .sort((a, b) => b.fecha.localeCompare(a.fecha))
              .slice(0, n);
            if (filtrados.length === 0) return { vol_promedio: null, n: 0 };
            const vol = filtrados.reduce((s, d) => s + d.volumen, 0) / filtrados.length;
            return { vol_promedio: vol, n: filtrados.length };
          }
          // obtenerPrecioPrevio
          const [categoria, fechaCorte] = args;
          const previos = datos
            .filter(d => d.categoria_codigo === categoria && d.fecha < fechaCorte && !d.es_outlier)
            .sort((a, b) => b.fecha.localeCompare(a.fecha));
          return previos[0];
        },
        run() { /* no-op */ }
      };
    }
  };
}

/** Helper para generar una serie semanal de fechas ISO a partir de una base */
function serieSemanas(base, precios, fuente, categoria, volumenes) {
  const fecha0 = new Date(base);
  return precios.map((p, i) => {
    const f = new Date(fecha0);
    f.setDate(f.getDate() + i * 7);
    return {
      fecha: f.toISOString().split('T')[0],
      categoria_codigo: categoria,
      fuente,
      precio: p,
      volumen: volumenes ? volumenes[i] : null,
      es_outlier: 0,
      es_interpolado: 0
    };
  });
}

// ═══════════════════════════════════════════════════════════
// TESTS DE FUNCIONES AUXILIARES
// ═══════════════════════════════════════════════════════════

test('estadisticos: media y desvío (muestral) de [1..5]', () => {
  const r = estadisticos([1, 2, 3, 4, 5]);
  assert.strictEqual(r.media, 3);
  assert.ok(Math.abs(r.desvio - 1.5811) < 0.01, `desvío ~1.58, got ${r.desvio}`);
});

test('estadisticos: array vacío devuelve ceros', () => {
  const r = estadisticos([]);
  assert.deepStrictEqual(r, { media: 0, desvio: 0, n: 0 });
});

test('variacionPct: cálculos básicos', () => {
  assert.strictEqual(variacionPct(110, 100), 10);
  assert.strictEqual(variacionPct(90, 100), -10);
  assert.strictEqual(variacionPct(100, 0), 0);
  assert.strictEqual(variacionPct(100, null), 0);
});

// ═══════════════════════════════════════════════════════════
// TESTS DE REGLAS DE DECISIÓN
// ═══════════════════════════════════════════════════════════

test('Regla 1: INAC siempre se acepta (sin análisis)', () => {
  const db = crearMockDB([]);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'NG',
    fuente: 'inac',
    precio: 99.0, // valor absurdo
    volumen: null
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'ACEPTAR');
  assert.strictEqual(r.motivo, 'fuente_oficial');
});

test('Regla 2: Sin histórico se acepta como primer dato', () => {
  const db = crearMockDB([]);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'TE',
    fuente: 'plaza_rural',
    precio: 3.80,
    volumen: 500
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'ACEPTAR');
  assert.strictEqual(r.motivo, 'sin_historico');
});

test('Regla 3: Dato dentro de ±3σ se acepta', () => {
  const datos = serieSemanas(
    '2026-01-02',
    [3.80, 3.82, 3.78, 3.81, 3.79, 3.83, 3.80, 3.82, 3.79, 3.81, 3.80, 3.82],
    'plaza_rural', 'TE',
    [500, 520, 480, 510, 500, 490, 500, 510, 495, 505, 500, 510]
  );
  const db = crearMockDB(datos);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'TE',
    fuente: 'plaza_rural',
    precio: 3.85,
    volumen: 500
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'ACEPTAR');
  assert.strictEqual(r.motivo, 'dentro_de_rango');
});

test('Regla 4a: Fuera de 3σ + volumen BAJO → OUTLIER', () => {
  const datos = serieSemanas(
    '2026-01-02',
    [3.80, 3.82, 3.78, 3.81, 3.79, 3.83, 3.80, 3.82, 3.79, 3.81, 3.80, 3.82],
    'plaza_rural', 'TE',
    [500, 520, 480, 510, 500, 490, 500, 510, 495, 505, 500, 510]
  );
  const db = crearMockDB(datos);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'TE',
    fuente: 'plaza_rural',
    precio: 5.50,   // +36% (muy fuera de rango)
    volumen: 50     // 10% del promedio
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'OUTLIER');
  assert.strictEqual(r.es_outlier, 1);
  assert.strictEqual(r.motivo, 'outlier_confirmado');
  assert.ok(r.volumen_relativo < 0.25, `vol_rel debe ser <25%, got ${r.volumen_relativo}`);
});

test('Regla 4b: Fuera de 3σ + volumen NORMAL → ACEPTAR_CON_FLAG', () => {
  const datos = serieSemanas(
    '2026-01-02',
    [3.80, 3.82, 3.78, 3.81, 3.79, 3.83, 3.80, 3.82, 3.79, 3.81, 3.80, 3.82],
    'plaza_rural', 'TE',
    [500, 520, 480, 510, 500, 490, 500, 510, 495, 505, 500, 510]
  );
  const db = crearMockDB(datos);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'TE',
    fuente: 'plaza_rural',
    precio: 4.80,   // +26% fuera de rango
    volumen: 520    // volumen normal (100% del promedio)
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'ACEPTAR_CON_FLAG');
  assert.strictEqual(r.motivo, 'alta_volatilidad_real');
});

test('Histórico insuficiente (<4 variaciones): aceptar', () => {
  const datos = serieSemanas('2026-04-03', [3.80, 3.82], 'plaza_rural', 'TE', [500, 520]);
  const db = crearMockDB(datos);
  const dato = {
    fecha: '2026-04-10',
    categoria_codigo: 'TE',
    fuente: 'plaza_rural',
    precio: 4.50,
    volumen: 500
  };
  const r = analizarOutlier(dato, db);
  assert.strictEqual(r.decision, 'ACEPTAR');
  assert.strictEqual(r.motivo, 'historico_insuficiente');
});

// ═══════════════════════════════════════════════════════════
// TESTS DE CONSISTENCIA MATEMÁTICA
// ═══════════════════════════════════════════════════════════

test('Consistencia Laspeyres: +10% en NG (40%) = +4.0% IGU', () => {
  const ponderaciones = { NG: 0.40, VG: 0.25, TE: 0.15, VQ: 0.12, VI: 0.08 };
  const variaciones = { NG: 10, VG: 0, TE: 0, VQ: 0, VI: 0 };

  const varIGU = Object.keys(ponderaciones).reduce(
    (acc, cat) => acc + ponderaciones[cat] * (variaciones[cat] / 100), 0
  ) * 100;

  assert.ok(Math.abs(varIGU - 4) < 0.01, `esperado 4%, got ${varIGU}`);
});

test('Consistencia Laspeyres: suma de ponderaciones = 1.0', () => {
  const ponderaciones = { NG: 0.40, VG: 0.25, TE: 0.15, VQ: 0.12, VI: 0.08 };
  const suma = Object.values(ponderaciones).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(suma - 1.0) < 0.001, `suma debe ser 1.0, got ${suma}`);
});

test('Consistencia Laspeyres: precios estables = IGU constante en 1.0', () => {
  const precios_base = { NG: 5.282, VG: 4.754, VQ: 5.128, TE: 3.80, VI: 2.20 };
  const precios_hoy = { NG: 5.282, VG: 4.754, VQ: 5.128, TE: 3.80, VI: 2.20 };
  const ponderaciones = { NG: 0.40, VG: 0.25, TE: 0.15, VQ: 0.12, VI: 0.08 };

  const igu = Object.keys(ponderaciones).reduce(
    (acc, cat) => acc + ponderaciones[cat] * (precios_hoy[cat] / precios_base[cat]), 0
  );

  assert.ok(Math.abs(igu - 1.0) < 0.0001, `IGU debe ser 1.0, got ${igu}`);
});
