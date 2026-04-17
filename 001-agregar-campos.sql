-- IGU - Migración 001
-- Agregar soporte para detección de outliers, interpolación y logs de calidad
-- Ejecutar sobre /data/igu.db en Railway
-- 
-- Uso: sqlite3 /data/igu.db < 001-agregar-campos.sql

-- ============================================================================
-- 1. Agregar campos a precios_raw (datos crudos de scrapers)
-- ============================================================================

-- Flag: ¿este dato pasó validación de outlier?
ALTER TABLE precios_raw ADD COLUMN es_outlier INTEGER DEFAULT 0;

-- Flag: ¿este dato fue interpolado porque el original era outlier?
ALTER TABLE precios_raw ADD COLUMN es_interpolado INTEGER DEFAULT 0;

-- Si fue interpolado, qué categoría se usó como referencia
ALTER TABLE precios_raw ADD COLUMN interpolado_desde TEXT;

-- Razón de descarte/interpolación (para auditoría)
ALTER TABLE precios_raw ADD COLUMN razon_descarte TEXT;

-- Precio original antes de interpolación (si aplica)
ALTER TABLE precios_raw ADD COLUMN precio_original REAL;


-- ============================================================================
-- 2. Tabla de log de decisiones metodológicas (auditoría pública)
-- ============================================================================

CREATE TABLE IF NOT EXISTS log_decisiones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  fecha_publicacion TEXT NOT NULL,
  categoria_codigo TEXT NOT NULL,
  tipo_decision TEXT NOT NULL,  -- 'outlier_descartado', 'interpolacion_aplicada', 'alta_volatilidad_aceptada', 'volumen_bajo_alerta'
  detalle TEXT NOT NULL,         -- JSON con info del caso
  precio_original REAL,
  precio_final REAL,
  volumen INTEGER,
  desvios_sigma REAL,
  categoria_referencia TEXT,
  publicado INTEGER DEFAULT 0    -- si la decisión está publicada en dashboard
);

CREATE INDEX IF NOT EXISTS idx_log_decisiones_fecha 
  ON log_decisiones(fecha_publicacion);

CREATE INDEX IF NOT EXISTS idx_log_decisiones_categoria 
  ON log_decisiones(categoria_codigo);


-- ============================================================================
-- 3. Tabla de matriz de correlaciones (recalculada periódicamente)
-- ============================================================================

CREATE TABLE IF NOT EXISTS correlaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fecha_calculo DATETIME DEFAULT CURRENT_TIMESTAMP,
  categoria_a TEXT NOT NULL,
  categoria_b TEXT NOT NULL,
  coef_correlacion REAL NOT NULL,
  coef_regresion REAL NOT NULL,   -- pendiente para interpolación
  intercepto REAL NOT NULL,        -- ordenada al origen
  n_observaciones INTEGER NOT NULL,
  ventana_semanas INTEGER NOT NULL,
  activo INTEGER DEFAULT 1,        -- 1 = matriz vigente, 0 = histórica
  UNIQUE(categoria_a, categoria_b, fecha_calculo)
);

CREATE INDEX IF NOT EXISTS idx_correlaciones_activo 
  ON correlaciones(activo, categoria_a, categoria_b);


-- ============================================================================
-- 4. Tabla de alertas enviadas (para no duplicar)
-- ============================================================================

CREATE TABLE IF NOT EXISTS alertas_enviadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
  tipo TEXT NOT NULL,              -- 'scraper_fallido', 'outlier_detectado', 'interpolacion', 'alta_volatilidad', 'volumen_bajo'
  fuente TEXT,                     -- inac, plaza_rural, pantalla_uruguay, sistema
  categoria_codigo TEXT,
  asunto TEXT NOT NULL,
  cuerpo TEXT NOT NULL,
  enviado INTEGER DEFAULT 0,       -- 0 = pendiente, 1 = enviado, -1 = error
  error_msg TEXT,
  intentos INTEGER DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_alertas_pendientes 
  ON alertas_enviadas(enviado, timestamp);


-- ============================================================================
-- 5. Agregar volumen_semanal_promedio a categorías (cache para velocidad)
-- ============================================================================

CREATE TABLE IF NOT EXISTS volumen_promedio (
  categoria_codigo TEXT PRIMARY KEY,
  fuente TEXT NOT NULL,
  volumen_4sem_promedio REAL,
  ultima_actualizacion DATETIME DEFAULT CURRENT_TIMESTAMP
);


-- ============================================================================
-- Verificación final
-- ============================================================================

-- Verificar que todo se creó OK
SELECT 'Migración 001 completada' AS resultado;
SELECT name FROM sqlite_master WHERE type='table' AND name IN (
  'log_decisiones', 'correlaciones', 'alertas_enviadas', 'volumen_promedio'
);
