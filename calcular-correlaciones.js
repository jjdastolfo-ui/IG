// calcular-correlaciones.js
// IGU - Cálculo periódico de matriz de correlaciones
//
// Este script se corre manualmente o vía cron (sugerido mensual) y recalcula
// las correlaciones entre todas las categorías usando la serie histórica disponible.
//
// Se usa para: interpolación de datos outlier (módulo interpolator.js)
//
// Uso:
//   node calcular-correlaciones.js
//   node calcular-correlaciones.js --ventana 52  (usar última year)
//
// Resultado: inserta filas en tabla `correlaciones` con flag activo=1,
// y marca las anteriores como activo=0.

const Database = require('better-sqlite3');
const path = require('path');

const CATEGORIAS = ['NG', 'VG', 'VQ', 'TE', 'VI'];
const VENTANA_DEFAULT = 52; // 1 año de historia para correlaciones

/**
 * Calcula coeficiente de correlación de Pearson entre dos arrays.
 */
function pearson(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { r: 0, n: 0 };

  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    num += dx * dy;
    dx2 += dx * dx;
    dy2 += dy * dy;
  }

  const denom = Math.sqrt(dx2 * dy2);
  const r = denom === 0 ? 0 : num / denom;
  return { r, n };
}

/**
 * Calcula coeficientes de regresión lineal y = beta*x + alpha.
 * Usado para interpolación: dado un movimiento en x, predecir y.
 */
function regresionLineal(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return { beta: 0, alpha: 0 };

  const mx = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const my = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) * (x[i] - mx);
  }

  const beta = den === 0 ? 0 : num / den;
  const alpha = my - beta * mx;
  return { beta, alpha };
}

/**
 * Obtiene variaciones % semanales de una categoría en ventana dada.
 * Retorna array alineado con fechas.
 */
function obtenerSerieVariaciones(db, categoria, ventana) {
  const stmt = db.prepare(`
    SELECT fecha, precio
    FROM (
      SELECT fecha, 
             -- Priorizar INAC para NG/VG/VQ, fuentes de mercado para TE/VI
             precio,
             ROW_NUMBER() OVER (
               PARTITION BY fecha 
               ORDER BY 
                 CASE fuente WHEN 'inac' THEN 1 WHEN 'plaza_rural' THEN 2 ELSE 3 END
             ) as rn
      FROM precios_raw
      WHERE categoria_codigo = ?
        AND COALESCE(es_outlier, 0) = 0
    )
    WHERE rn = 1
    ORDER BY fecha DESC
    LIMIT ?
  `);

  const filas = stmt.all(categoria, ventana + 1);
  if (filas.length < 3) return { variaciones: [], fechas: [] };

  const ordenadas = filas.reverse(); // cronológico
  const variaciones = [];
  const fechas = [];

  for (let i = 1; i < ordenadas.length; i++) {
    const varPct = ((ordenadas[i].precio - ordenadas[i-1].precio) / ordenadas[i-1].precio) * 100;
    variaciones.push(varPct);
    fechas.push(ordenadas[i].fecha);
  }

  return { variaciones, fechas };
}

/**
 * Alinea dos series de variaciones por fecha común.
 */
function alinearSeries(serieA, serieB) {
  const mapB = new Map(serieB.fechas.map((f, i) => [f, serieB.variaciones[i]]));
  const x = [], y = [];
  serieA.fechas.forEach((f, i) => {
    if (mapB.has(f)) {
      x.push(serieA.variaciones[i]);
      y.push(mapB.get(f));
    }
  });
  return { x, y };
}

function main() {
  const args = process.argv.slice(2);
  const ventanaIdx = args.indexOf('--ventana');
  const ventana = ventanaIdx >= 0 ? parseInt(args[ventanaIdx + 1]) : VENTANA_DEFAULT;

  const dbPath = process.env.DB_PATH || '/data/igu.db';
  console.log(`\n🔢 IGU - Cálculo de correlaciones`);
  console.log(`   DB: ${dbPath}`);
  console.log(`   Ventana: ${ventana} semanas\n`);

  const db = new Database(dbPath);

  // Obtener series de todas las categorías
  const series = {};
  CATEGORIAS.forEach(cat => {
    series[cat] = obtenerSerieVariaciones(db, cat, ventana);
    console.log(`  ${cat}: ${series[cat].variaciones.length} variaciones disponibles`);
  });

  console.log('\n📊 Matriz de correlaciones:');
  console.log('        ' + CATEGORIAS.map(c => c.padStart(8)).join(''));

  // Marcar correlaciones previas como inactivas
  db.prepare(`UPDATE correlaciones SET activo = 0`).run();

  const insertCorr = db.prepare(`
    INSERT INTO correlaciones (
      categoria_a, categoria_b, coef_correlacion, coef_regresion, intercepto,
      n_observaciones, ventana_semanas, activo
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 1)
  `);

  const matriz = {};
  let guardadas = 0;

  CATEGORIAS.forEach(a => {
    matriz[a] = {};
    let fila = '  ' + a + '    ';

    CATEGORIAS.forEach(b => {
      if (a === b) {
        matriz[a][b] = 1.0;
        fila += '    1.00';
        return;
      }

      const { x, y } = alinearSeries(series[a], series[b]);
      if (x.length < 8) {
        matriz[a][b] = null;
        fila += '     -- ';
        return;
      }

      const { r, n } = pearson(x, y);
      // Regresión: predecir A dado B (para interpolar A usando B como referencia)
      const { beta, alpha } = regresionLineal(y, x);

      matriz[a][b] = r;
      fila += r.toFixed(2).padStart(8);

      // Guardar en DB
      insertCorr.run(a, b, r, beta, alpha, n, ventana);
      guardadas++;
    });

    console.log(fila);
  });

  console.log(`\n✓ ${guardadas} correlaciones guardadas en DB (marcadas como activas).`);

  // Reportar correlaciones "fuertes" (>= 0.70)
  console.log('\n🔗 Correlaciones fuertes (|r| >= 0.70):');
  CATEGORIAS.forEach(a => {
    CATEGORIAS.forEach(b => {
      if (a !== b && matriz[a][b] !== null && Math.abs(matriz[a][b]) >= 0.70) {
        console.log(`   ${a} ↔ ${b}: r = ${matriz[a][b].toFixed(3)}`);
      }
    });
  });

  db.close();
  console.log('\n✓ Proceso completado.\n');
}

// Solo correr si se invoca directamente
if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('❌ Error:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

module.exports = { pearson, regresionLineal };
