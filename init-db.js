// init-db.js
// Inicialización de la base de datos SQLite para el Índice Ganadero Uruguayo (IGU)

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'igu.db');
const db = new Database(DB_PATH);

db.pragma('journal_mode = WAL');

// ============================================================================
// TABLA: categorias
// Define las 5 categorías ganaderas del índice con sus ponderaciones
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
`);

// ============================================================================
// TABLA: precios_raw
// Almacena cada observación de precio de cada fuente
// ============================================================================
db.exec(`
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
`);

// ============================================================================
// TABLA: precios_promedio_diario
// Precio promedio ponderado por volumen de cada categoría por día
// ============================================================================
db.exec(`
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
`);

// ============================================================================
// TABLA: indice
// Valor diario del IGU y sub-índices
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS indice (
    fecha TEXT PRIMARY KEY,
    igu_general REAL NOT NULL,
    sub_carne REAL,
    sub_reposicion REAL,
    sub_cria REAL,
    variacion_diaria REAL,
    variacion_mensual REAL,
    variacion_anual REAL,
    metodologia_version TEXT DEFAULT '1.0',
    calculado_at TEXT DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_indice_fecha ON indice(fecha);
`);

// ============================================================================
// TABLA: base_index
// Almacena los precios base para el cálculo tipo Laspeyres
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS base_index (
    categoria_codigo TEXT PRIMARY KEY,
    fecha_base TEXT NOT NULL,
    precio_base REAL NOT NULL,
    cantidad_base REAL NOT NULL,
    notas TEXT,
    FOREIGN KEY (categoria_codigo) REFERENCES categorias(codigo)
  );
`);

// ============================================================================
// TABLA: scraping_log
// Auditoría de ejecuciones de scraping
// ============================================================================
db.exec(`
  CREATE TABLE IF NOT EXISTS scraping_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fuente TEXT NOT NULL,
    fecha_ejecucion TEXT DEFAULT CURRENT_TIMESTAMP,
    status TEXT NOT NULL,
    registros_obtenidos INTEGER DEFAULT 0,
    error_msg TEXT,
    duracion_ms INTEGER
  );
`);

// ============================================================================
// SEED: Categorías iniciales con ponderaciones
// Ponderaciones derivadas de participación en faena INAC y mercado de haciendas
// ============================================================================
const insertCategoria = db.prepare(`
  INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
  VALUES (?, ?, ?, ?, ?)
`);

const categorias = [
  {
    codigo: 'NG',
    nombre: 'Novillo Gordo',
    descripcion: 'Novillo terminado apto frigorífico, 480-520 kg',
    ponderacion: 0.40,
    unidad: 'USD/kg'
  },
  {
    codigo: 'VG',
    nombre: 'Vaca Gorda',
    descripcion: 'Vaca terminada apta frigorífico',
    ponderacion: 0.20,
    unidad: 'USD/kg'
  },
  {
    codigo: 'TE',
    nombre: 'Ternero',
    descripcion: 'Ternero de destete, 140-180 kg',
    ponderacion: 0.20,
    unidad: 'USD/kg'
  },
  {
    codigo: 'VQ',
    nombre: 'Vaquillona',
    descripcion: 'Vaquillona de reposición, 220-280 kg',
    ponderacion: 0.10,
    unidad: 'USD/kg'
  },
  {
    codigo: 'VI',
    nombre: 'Vaca de Invernada',
    descripcion: 'Vaca para recría/invernada',
    ponderacion: 0.10,
    unidad: 'USD/kg'
  }
];

categorias.forEach(cat => {
  insertCategoria.run(cat.codigo, cat.nombre, cat.descripcion, cat.ponderacion, cat.unidad);
});

// ============================================================================
// SEED: Precios base (período base = promedio 2024)
// Estos son placeholders iniciales - deberán ajustarse con datos reales
// ============================================================================
const insertBase = db.prepare(`
  INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
  VALUES (?, ?, ?, ?, ?)
`);

const basesIniciales = [
  { codigo: 'NG', precio: 4.20, cantidad: 1, notas: 'Promedio anual 2024 - base placeholder' },
  { codigo: 'VG', precio: 3.50, cantidad: 1, notas: 'Promedio anual 2024 - base placeholder' },
  { codigo: 'TE', precio: 3.80, cantidad: 1, notas: 'Promedio anual 2024 - base placeholder' },
  { codigo: 'VQ', precio: 3.20, cantidad: 1, notas: 'Promedio anual 2024 - base placeholder' },
  { codigo: 'VI', precio: 2.80, cantidad: 1, notas: 'Promedio anual 2024 - base placeholder' }
];

basesIniciales.forEach(b => {
  insertBase.run(b.codigo, '2024-01-01', b.precio, b.cantidad, b.notas);
});

console.log('✓ Base de datos IGU inicializada correctamente');
console.log(`✓ ${categorias.length} categorías creadas`);
console.log(`✓ ${basesIniciales.length} precios base cargados`);
console.log(`✓ Path: ${DB_PATH}`);

db.close();
