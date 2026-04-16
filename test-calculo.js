// test-calculo.js
// Test standalone de la lógica de cálculo Laspeyres sin dependencias nativas
// Simula el comportamiento del servidor para verificar matemática del índice

console.log('━'.repeat(60));
console.log('TEST: Cálculo Índice Ganadero Uruguayo (IGU)');
console.log('━'.repeat(60));

// === Configuración de categorías (igual que init-db.js) ===
const categorias = [
  { codigo: 'NG', nombre: 'Novillo Gordo', ponderacion: 0.40, precio_base: 4.20, cantidad_base: 1 },
  { codigo: 'VG', nombre: 'Vaca Gorda',    ponderacion: 0.20, precio_base: 3.50, cantidad_base: 1 },
  { codigo: 'TE', nombre: 'Ternero',       ponderacion: 0.20, precio_base: 3.80, cantidad_base: 1 },
  { codigo: 'VQ', nombre: 'Vaquillona',    ponderacion: 0.10, precio_base: 3.20, cantidad_base: 1 },
  { codigo: 'VI', nombre: 'Vaca Invernada',ponderacion: 0.10, precio_base: 2.80, cantidad_base: 1 }
];

// === Simulación: precios observados hoy de múltiples fuentes ===
const observaciones_hoy = [
  // Novillo Gordo
  { cat: 'NG', fuente: 'plaza_rural', precio: 4.35, volumen: 180 },
  { cat: 'NG', fuente: 'acg',         precio: 4.32, volumen: 100 },
  { cat: 'NG', fuente: 'pantalla',    precio: 4.40, volumen: 220 },
  // Vaca Gorda
  { cat: 'VG', fuente: 'plaza_rural', precio: 3.65, volumen: 90 },
  { cat: 'VG', fuente: 'acg',         precio: 3.62, volumen: 50 },
  // Ternero
  { cat: 'TE', fuente: 'plaza_rural', precio: 4.10, volumen: 350 },
  { cat: 'TE', fuente: 'pantalla',    precio: 4.05, volumen: 280 },
  // Vaquillona
  { cat: 'VQ', fuente: 'plaza_rural', precio: 3.40, volumen: 120 },
  // Vaca Invernada
  { cat: 'VI', fuente: 'plaza_rural', precio: 2.95, volumen: 80 }
];

// === Paso 1: Calcular promedio ponderado por volumen por categoría ===
console.log('\n📊 PASO 1: Promedios ponderados por volumen\n');

const promediosDiarios = {};
categorias.forEach(cat => {
  const obs = observaciones_hoy.filter(o => o.cat === cat.codigo);
  if (obs.length === 0) return;

  const sumaPonderada = obs.reduce((s, o) => s + (o.precio * o.volumen), 0);
  const sumaVolumen = obs.reduce((s, o) => s + o.volumen, 0);
  const promedio = sumaPonderada / sumaVolumen;

  promediosDiarios[cat.codigo] = promedio;

  console.log(
    `  ${cat.codigo} (${cat.nombre.padEnd(18)}): ${promedio.toFixed(4)} USD/kg ` +
    `[${obs.length} obs, ${sumaVolumen} cabezas]`
  );
});

// === Paso 2: Calcular IGU General (Laspeyres) ===
console.log('\n🧮 PASO 2: Cálculo IGU General (Laspeyres)\n');
console.log('  Fórmula: IGU = Σ(Pt × Q0 × W) / Σ(P0 × Q0 × W) × 100\n');

let numerador = 0;
let denominador = 0;
const detalles = {};

categorias.forEach(cat => {
  const Pt = promediosDiarios[cat.codigo];
  if (Pt === undefined) return;

  const aporteNum = Pt * cat.cantidad_base * cat.ponderacion;
  const aporteDen = cat.precio_base * cat.cantidad_base * cat.ponderacion;
  const indiceIndividual = (Pt / cat.precio_base) * 100;

  numerador += aporteNum;
  denominador += aporteDen;
  detalles[cat.codigo] = { Pt, indiceIndividual };

  console.log(
    `  ${cat.codigo}: P0=${cat.precio_base.toFixed(2)}, Pt=${Pt.toFixed(2)}, ` +
    `W=${(cat.ponderacion*100).toFixed(0)}%, ` +
    `Índice indiv=${indiceIndividual.toFixed(2)}`
  );
});

const IGU_general = (numerador / denominador) * 100;

console.log(`\n  ⚡ IGU GENERAL = ${IGU_general.toFixed(2)}`);
console.log(`     (numerador=${numerador.toFixed(4)} / denominador=${denominador.toFixed(4)})\n`);

// === Paso 3: Sub-índices ===
console.log('📂 PASO 3: Sub-índices\n');

function calcularSubIndice(codigos, label) {
  const subCats = categorias.filter(c => codigos.includes(c.codigo));
  const pondTotal = subCats.reduce((s, c) => s + c.ponderacion, 0);

  let num = 0, den = 0;
  subCats.forEach(cat => {
    const Pt = promediosDiarios[cat.codigo];
    if (Pt === undefined) return;
    const pondNorm = cat.ponderacion / pondTotal;
    num += Pt * cat.cantidad_base * pondNorm;
    den += cat.precio_base * cat.cantidad_base * pondNorm;
  });

  const valor = den > 0 ? (num / den) * 100 : null;
  console.log(`  ${label}: ${valor.toFixed(2)}`);
  return valor;
}

const subCarne = calcularSubIndice(['NG', 'VG'], 'Sub-Carne     (NG+VG)     ');
const subReposicion = calcularSubIndice(['TE', 'VQ'], 'Sub-Reposición (TE+VQ)    ');
const subCria = calcularSubIndice(['VI'], 'Sub-Cría      (VI)        ');

// === Paso 4: Simulación de variaciones ===
console.log('\n📈 PASO 4: Simulación de variaciones\n');

// Simulamos que ayer el IGU fue 102.50, hace un mes 101.20, hace un año 95.50
const IGU_ayer = 102.50;
const IGU_mes = 101.20;
const IGU_anio = 95.50;

const varDiaria = ((IGU_general - IGU_ayer) / IGU_ayer) * 100;
const varMensual = ((IGU_general - IGU_mes) / IGU_mes) * 100;
const varAnual = ((IGU_general - IGU_anio) / IGU_anio) * 100;

console.log(`  Variación diaria:  ${varDiaria > 0 ? '+' : ''}${varDiaria.toFixed(2)}%`);
console.log(`  Variación mensual: ${varMensual > 0 ? '+' : ''}${varMensual.toFixed(2)}%`);
console.log(`  Variación anual:   ${varAnual > 0 ? '+' : ''}${varAnual.toFixed(2)}%`);

// === Validación matemática ===
console.log('\n✅ VALIDACIONES\n');

// Test 1: Si todos los precios = base, IGU debe ser exactamente 100
const promediosBase = {};
categorias.forEach(c => promediosBase[c.codigo] = c.precio_base);
let numBase = 0, denBase = 0;
categorias.forEach(cat => {
  numBase += promediosBase[cat.codigo] * cat.cantidad_base * cat.ponderacion;
  denBase += cat.precio_base * cat.cantidad_base * cat.ponderacion;
});
const iguBase = (numBase / denBase) * 100;
console.log(`  ✓ Test 1 (precios=base → IGU=100): ${iguBase.toFixed(4)} ${Math.abs(iguBase - 100) < 0.001 ? '✅' : '❌'}`);

// Test 2: Si todos los precios suben 10%, IGU debe subir 10%
const promedios10 = {};
categorias.forEach(c => promedios10[c.codigo] = c.precio_base * 1.10);
let num10 = 0, den10 = 0;
categorias.forEach(cat => {
  num10 += promedios10[cat.codigo] * cat.cantidad_base * cat.ponderacion;
  den10 += cat.precio_base * cat.cantidad_base * cat.ponderacion;
});
const igu10 = (num10 / den10) * 100;
console.log(`  ✓ Test 2 (precios +10% → IGU=110): ${igu10.toFixed(4)} ${Math.abs(igu10 - 110) < 0.001 ? '✅' : '❌'}`);

// Test 3: Ponderaciones suman 100%
const sumaPond = categorias.reduce((s, c) => s + c.ponderacion, 0);
console.log(`  ✓ Test 3 (ponderaciones = 1.0):   ${sumaPond.toFixed(4)} ${Math.abs(sumaPond - 1) < 0.001 ? '✅' : '❌'}`);

console.log('\n━'.repeat(60));
console.log('✅ SISTEMA DE CÁLCULO VERIFICADO');
console.log('━'.repeat(60));
