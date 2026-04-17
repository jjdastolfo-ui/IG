// init-db.js v2.2
// Inicializacion de la base de datos SQLite para el Indice Ganadero Uruguayo (IGU)
//
// CAMBIOS v2.2 (17/4/2026):
// - Ponderaciones validadas: NG 38% | VG 25% | VQ 12% | TE 15% | VI 7% | VP 3%
// - Precios base REALES del 2/1/2026
// - Nueva categoria VP (Vacas/Vaquillonas Preñadas) en USD/kg equivalente
// - Peso estandar VP: 420 kg (conversion USD/cabeza -> USD/kg)
// - Base: 1.0000 = viernes 2/1/2026

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ============================================================================
// Tablas core
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS categorias (
    codigo TEXT PRIMARY KEY,
    nombre TEXT NOT NULL,
    descripcion TEXT,
    ponderacion REAL NOT NULL,
    unidad TEXT NOT NULL DEFAULT 'USD/kg',
    activo INTEGER DEFAULT 1,
    fecha_alta TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS precios_raw (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fecha TEXT NOT NULL,
    categoria_codigo TEXT NOT NULL,
    fuente TEXT NOT NULL,
    precio REAL NOT NULL,
    unidad TEXT DEFAULT 'USD/kg',
    volumen INTEGER,
    observaciones TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (categoria_codigo) REFERENCES categorias(codigo)
  );

  CREATE INDEX IF NOT EXISTS idx_precios_fecha ON precios_raw(fecha);
  CREATE INDEX IF NOT EXISTS idx_precios_categoria ON precios_raw(categoria_codigo);
  CREATE INDEX IF NOT EXISTS idx_precios_fuente ON precios_raw(fuente);

  CREATE TABLE IF NOT EXISTS precios_promedio_diario (
    fecha TEXT NOT NULL,
    categoria_codigo TEXT NOT NULL,
    precio_promedio REAL NOT NULL,
    num_observaciones INTEGER NOT NULL,
    volumen_total INTEGER,
    fuentes TEXT,
    PRIMARY KEY (fecha, categoria_codigo),
    FOREIGN KEY (categoria_codigo) REFERENCES categorias(codigo)
  );

  CREATE TABLE IF NOT EXISTS indice (
    fecha TEXT PRIMARY KEY,
    igu_general REAL NOT NULL,
    sub_carne REAL,
    sub_reposicion REAL,
    sub_cria REAL,
    variacion_diaria REAL,
    variacion_mensual REAL,
    variacion_anual REAL,
    metodologia_version TEXT DEFAULT '2.2',
    calculado_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_indice_fecha ON indice(fecha);

  CREATE TABLE IF NOT EXISTS base_index (
    categoria_codigo TEXT PRIMARY KEY,
    fecha_base TEXT NOT NULL,
    precio_base REAL NOT NULL,
    cantidad_base REAL NOT NULL,
    notas TEXT,
    FOREIGN KEY (categoria_codigo) REFERENCES categorias(codigo)
  );

  CREATE TABLE IF NOT EXISTS scraping_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fuente TEXT NOT NULL,
    fecha_ejecucion TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    registros_obtenidos INTEGER DEFAULT 0,
    error_msg TEXT,
    duracion_ms INTEGER
  );

  CREATE TABLE IF NOT EXISTS constantes_metodologicas (
    clave TEXT PRIMARY KEY,
    valor REAL NOT NULL,
    unidad TEXT,
    descripcion TEXT,
    fecha_definicion TEXT DEFAULT CURRENT_TIMESTAMP,
    fecha_revision TEXT,
    notas TEXT
  );
`);

// ============================================================================
// SEED: Categorias con ponderaciones REALES validadas v2.2
// ============================================================================
const insertCategoria = db.prepare(`
  INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
  VALUES (?, ?, ?, ?, ?)
`);

const categorias = [
  { codigo: 'NG', nombre: 'Novillo Gordo',     ponderacion: 0.38, unidad: 'USD/kg',
    descripcion: 'Novillo terminado apto frigorifico, precio 4ta balanza (canal) - fuente INAC' },
  { codigo: 'VG', nombre: 'Vaca Gorda',         ponderacion: 0.25, unidad: 'USD/kg',
    descripcion: 'Vaca terminada apta frigorifico, precio 4ta balanza (canal) - fuente INAC' },
  { codigo: 'VQ', nombre: 'Vaquillona Gorda',   ponderacion: 0.12, unidad: 'USD/kg',
    descripcion: 'Vaquillona terminada apta frigorifico, precio 4ta balanza (canal) - fuente INAC' },
  { codigo: 'TE', nombre: 'Ternero',            ponderacion: 0.15, unidad: 'USD/kg',
    descripcion: 'Ternero de destete 140-180 kg, precio peso vivo - Plaza Rural + Pantalla Uruguay' },
  { codigo: 'VI', nombre: 'Vaca de Invernada',  ponderacion: 0.07, unidad: 'USD/kg',
    descripcion: 'Vaca para recria/invernada, precio peso vivo - Plaza Rural + Pantalla Uruguay' },
  { codigo: 'VP', nombre: 'Vacas/Vaquillonas Preñadas', ponderacion: 0.03, unidad: 'USD/kg',
    descripcion: 'Hembras con diagnostico de preñez confirmado. Precio convertido de USD/cabeza a USD/kg con peso estandar 420 kg.' }
];

categorias.forEach(cat => {
  insertCategoria.run(cat.codigo, cat.nombre, cat.descripcion, cat.ponderacion, cat.unidad);
});

// ============================================================================
// SEED: Precios base REALES (2/1/2026 = 1.0000)
// ============================================================================
const insertBase = db.prepare(`
  INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
  VALUES (?, ?, ?, ?, ?)
`);

const basesReales = [
  { codigo: 'NG', precio: 5.282, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  { codigo: 'VG', precio: 4.754, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  { codigo: 'VQ', precio: 5.128, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  { codigo: 'TE', precio: 3.80,  notas: 'Plaza Rural + Pantalla Uruguay peso vivo - 2/1/2026' },
  { codigo: 'VI', precio: 2.20,  notas: 'Plaza Rural + Pantalla Uruguay peso vivo - 2/1/2026' },
  { codigo: 'VP', precio: 2.500, notas: 'USD 1.050/cabeza convertido / 420 kg - 2/1/2026. Validar con datos reales.' }
];

basesReales.forEach(b => {
  insertBase.run(b.codigo, '2026-01-02', b.precio, 1, b.notas);
});

// ============================================================================
// SEED: Constantes metodologicas
// ============================================================================
db.prepare(`
  INSERT OR REPLACE INTO constantes_metodologicas (clave, valor, unidad, descripcion, notas)
  VALUES (?, ?, ?, ?, ?)
`).run(
  'peso_estandar_vp', 420.0, 'kg',
  'Peso estandar vaca/vaquillona preñada para conversion USD/cabeza a USD/kg',
  'Decidido 17/4/2026. Basado en datos observados Plaza Rural remates 2026. Revisar anualmente.'
);

// ============================================================================
// Verificacion
// ============================================================================
const sumaPond = db.prepare(`
  SELECT ROUND(SUM(ponderacion), 4) AS suma FROM categorias WHERE activo = 1
`).get();

console.log('─'.repeat(60));
console.log('IGU v2.2 - Base de datos inicializada');
console.log('─'.repeat(60));
console.log(`✓ ${categorias.length} categorias (incluye VP nueva)`);
console.log(`✓ ${basesReales.length} precios base reales cargados (2/1/2026)`);
console.log(`✓ Suma ponderaciones: ${sumaPond.suma} ${Math.abs(sumaPond.suma - 1.0) < 0.001 ? '✓' : '✗ ERROR'}`);
console.log(`✓ Peso estandar VP: 420 kg`);
console.log(`✓ Path: ${DB_PATH}`);
console.log('─'.repeat(60));

db.close();
