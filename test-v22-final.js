// test-v22-final.js
// Tests completos de la v2.2 final del IGU

const { test } = require('node:test');
const assert = require('node:assert');

const PONDERACIONES = { NG: 0.38, VG: 0.25, VQ: 0.12, TE: 0.15, VI: 0.07, VP: 0.03 };
const PRECIOS_BASE = {
  NG: 5.282,   // USD/kg canal
  VG: 4.754,   // USD/kg canal
  VQ: 5.128,   // USD/kg canal
  TE: 3.80,    // USD/kg vivo
  VI: 2.20,    // USD/kg vivo
  VP: 2.500    // USD/kg (derivado de 1050/cab ÷ 420kg)
};
const SUB_INDICES = {
  sub_carne: ['NG', 'VG', 'VQ'],
  sub_reposicion: ['TE', 'VI'],
  sub_cria: ['VP']
};
const PESO_VP = 420;

function calcularIGU(preciosHoy, preciosBase, ponderaciones) {
  let num = 0, den = 0;
  Object.keys(ponderaciones).forEach(cat => {
    if (preciosHoy[cat] != null) {
      num += preciosHoy[cat] * ponderaciones[cat];
      den += preciosBase[cat] * ponderaciones[cat];
    }
  });
  return den > 0 ? num / den : null;
}

// ═══════════════════════════════════════════════════════════
// TESTS DE CONFIGURACION v2.2
// ═══════════════════════════════════════════════════════════

test('Ponderaciones suman exactamente 1.0', () => {
  const suma = Object.values(PONDERACIONES).reduce((a, b) => a + b, 0);
  assert.ok(Math.abs(suma - 1.0) < 0.001, `suma = ${suma}`);
});

test('Sub-Carne (NG+VG+VQ) pesa 75%', () => {
  const peso = SUB_INDICES.sub_carne.reduce((s, c) => s + PONDERACIONES[c], 0);
  assert.ok(Math.abs(peso - 0.75) < 0.001, `sub_carne = ${peso}`);
});

test('Sub-Reposicion (TE+VI) pesa 22%', () => {
  const peso = SUB_INDICES.sub_reposicion.reduce((s, c) => s + PONDERACIONES[c], 0);
  assert.ok(Math.abs(peso - 0.22) < 0.001, `sub_reposicion = ${peso}`);
});

test('Sub-Cria (VP) pesa 3%', () => {
  const peso = SUB_INDICES.sub_cria.reduce((s, c) => s + PONDERACIONES[c], 0);
  assert.ok(Math.abs(peso - 0.03) < 0.001, `sub_cria = ${peso}`);
});

test('VI esta en sub_reposicion', () => {
  assert.ok(SUB_INDICES.sub_reposicion.includes('VI'));
  assert.ok(!SUB_INDICES.sub_cria.includes('VI'));
});

test('VP esta en sub_cria solo', () => {
  assert.strictEqual(SUB_INDICES.sub_cria.length, 1);
  assert.strictEqual(SUB_INDICES.sub_cria[0], 'VP');
});

// ═══════════════════════════════════════════════════════════
// TESTS DE CONVERSION VP
// ═══════════════════════════════════════════════════════════

test('Conversion VP: 1050 USD/cabeza = 2.500 USD/kg con peso 420 kg', () => {
  const preciosCabeza = 1050;
  const preciosKg = preciosCabeza / PESO_VP;
  assert.ok(Math.abs(preciosKg - 2.500) < 0.001, `${preciosCabeza}/${PESO_VP} = ${preciosKg}, esperado 2.500`);
});

test('Conversion VP: 1247.42 USD/cabeza (remate 320) = 2.970 USD/kg', () => {
  const preciosCabeza = 1247.42;
  const preciosKg = preciosCabeza / PESO_VP;
  assert.ok(Math.abs(preciosKg - 2.9701) < 0.01, `precio convertido = ${preciosKg}`);
});

// ═══════════════════════════════════════════════════════════
// TESTS DEL CALCULO IGU
// ═══════════════════════════════════════════════════════════

test('IGU con precios base = 1.0000 exacto', () => {
  const igu = calcularIGU({ ...PRECIOS_BASE }, PRECIOS_BASE, PONDERACIONES);
  assert.ok(Math.abs(igu - 1.0) < 0.0001, `IGU = ${igu}`);
});

test('+10% en NG (38%) produce variacion coherente en IGU', () => {
  const preciosHoy = { ...PRECIOS_BASE, NG: PRECIOS_BASE.NG * 1.10 };
  const igu = calcularIGU(preciosHoy, PRECIOS_BASE, PONDERACIONES);
  const variacion = (igu - 1.0) * 100;

  // Ahora que todas las categorias estan en USD/kg, la formula Laspeyres clasica
  // produce variaciones ponderadas correctamente.
  // El peso economico efectivo = (P_NG × W_NG) / sum(P_i × W_i)
  const pesoEconomicoNG = (PRECIOS_BASE.NG * PONDERACIONES.NG) /
    Object.keys(PONDERACIONES).reduce((s, c) => s + PRECIOS_BASE[c] * PONDERACIONES[c], 0);
  const variacionEsperada = 10 * pesoEconomicoNG;

  console.log(`    NG peso economico: ${(pesoEconomicoNG * 100).toFixed(2)}%, variacion IGU: ${variacion.toFixed(4)}%`);
  assert.ok(Math.abs(variacion - variacionEsperada) < 0.01,
    `esperado ${variacionEsperada.toFixed(4)}%, got ${variacion.toFixed(4)}%`);
});

test('VP no domina el IGU (precio en USD/kg, no USD/cabeza)', () => {
  // VP debe pesar economicamente cerca de su ponderacion nominal (3%)
  const totalEconomico = Object.keys(PONDERACIONES).reduce((s, c) =>
    s + PRECIOS_BASE[c] * PONDERACIONES[c], 0);
  const pesoVP = (PRECIOS_BASE.VP * PONDERACIONES.VP) / totalEconomico;

  console.log(`    VP peso economico real: ${(pesoVP * 100).toFixed(2)}%, nominal: 3%`);
  assert.ok(pesoVP < 0.05, `VP no debe pesar mas de 5% economico, got ${(pesoVP*100).toFixed(2)}%`);
  assert.ok(pesoVP > 0.01, `VP debe pesar al menos 1% economico, got ${(pesoVP*100).toFixed(2)}%`);
});

test('+20% en VP (3%) produce cambio chico en IGU', () => {
  const preciosHoy = { ...PRECIOS_BASE, VP: PRECIOS_BASE.VP * 1.20 };
  const igu = calcularIGU(preciosHoy, PRECIOS_BASE, PONDERACIONES);
  const variacion = (igu - 1.0) * 100;

  // VP tiene peso economico ~1.8% del total (precio chico × pond chica)
  // Entonces +20% * 1.8% ≈ +0.36%
  console.log(`    VP +20%: IGU variacion = ${variacion.toFixed(4)}%`);
  assert.ok(variacion > 0 && variacion < 1.0, `variacion debe ser < 1%, got ${variacion.toFixed(4)}%`);
});

test('Movimiento simultaneo de varias categorias', () => {
  // Escenario: NG +5%, TE +10%, VP +15%
  const preciosHoy = {
    ...PRECIOS_BASE,
    NG: PRECIOS_BASE.NG * 1.05,
    TE: PRECIOS_BASE.TE * 1.10,
    VP: PRECIOS_BASE.VP * 1.15
  };
  const igu = calcularIGU(preciosHoy, PRECIOS_BASE, PONDERACIONES);
  const variacion = (igu - 1.0) * 100;

  console.log(`    Escenario mixto: IGU = ${igu.toFixed(4)} (${variacion.toFixed(4)}%)`);
  assert.ok(variacion > 0, 'variacion debe ser positiva');
  assert.ok(variacion < 10, 'variacion no puede ser absurda');
});

test('Sin VP esta semana: IGU calcula igual con las demas', () => {
  // Si VP no tiene datos, debe calcularse con las otras 5 categorias
  const preciosHoy = { ...PRECIOS_BASE };
  delete preciosHoy.VP;

  const igu = calcularIGU(preciosHoy, PRECIOS_BASE, PONDERACIONES);
  assert.ok(Math.abs(igu - 1.0) < 0.0001, `sin VP tambien debe ser 1.0 con precios base, got ${igu}`);
});
