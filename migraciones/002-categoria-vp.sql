-- IGU - Migracion 002
-- Agregar categoria VP (Vacas/Vaquillonas Preñadas) con conversion USD/kg
-- 
-- METODOLOGIA VP:
--   Los remates publican precio en USD/cabeza.
--   Para mantener homogeneidad del indice (todas las categorias en USD/kg),
--   se convierte dividiendo por peso estandar: VP_USDkg = VP_USDcabeza / 420
--   
--   Peso estandar: 420 kg (promedio ponderado vaca+vaquillona preñada,
--   basado en datos de remates Plaza Rural / Pantalla Uruguay 2026)
--
--   Precio base VP: USD 2.500/kg (derivado de USD 1.050/cabeza / 420 kg)
--
-- PONDERACIONES FINALES v2.2:
--   NG 38% | VG 25% | VQ 12% | TE 15% | VI 7% | VP 3%
--
-- SUB-INDICES:
--   sub_carne:      NG + VG + VQ = 75%
--   sub_reposicion: TE + VI = 22%
--   sub_cria:       VP = 3%
--
-- IMPORTANTE: Los scrapers deben aplicar la conversion ANTES de insertar.
--
-- Ejecutar: sqlite3 /data/igu.db < migraciones/002-categoria-vp.sql

-- ============================================================================
-- 1. Actualizar ponderaciones de categorias existentes
-- ============================================================================

UPDATE categorias SET ponderacion = 0.38 WHERE codigo = 'NG';
UPDATE categorias SET ponderacion = 0.25 WHERE codigo = 'VG';
UPDATE categorias SET ponderacion = 0.12 WHERE codigo = 'VQ';
UPDATE categorias SET ponderacion = 0.15 WHERE codigo = 'TE';
UPDATE categorias SET ponderacion = 0.07 WHERE codigo = 'VI';


-- ============================================================================
-- 2. Agregar nueva categoria VP (en USD/kg equivalente)
-- ============================================================================

INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad, activo)
VALUES (
  'VP',
  'Vacas/Vaquillonas Preñadas',
  'Hembras con diagnostico de preñez confirmado. Precio convertido de USD/cabeza a USD/kg dividiendo por peso estandar 420 kg (peso medio ponderado de vaca+vaquillona preñada).',
  0.03,
  'USD/kg',
  1
);


-- ============================================================================
-- 3. Agregar precio base para VP (convertido a USD/kg)
-- 
-- Base 2/1/2026: USD 1.050/cabeza ÷ 420 kg = USD 2.50/kg equivalente
-- ============================================================================

INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
VALUES (
  'VP',
  '2026-01-02',
  2.500,
  1,
  'Base 2/1/2026 - USD 1.050/cabeza convertido a USD/kg (÷420 kg peso estandar). VALIDAR con datos reales de enero 2026.'
);


-- ============================================================================
-- 4. Tabla de constantes metodologicas (para documentar el peso estandar)
-- ============================================================================

CREATE TABLE IF NOT EXISTS constantes_metodologicas (
  clave TEXT PRIMARY KEY,
  valor REAL NOT NULL,
  unidad TEXT,
  descripcion TEXT,
  fecha_definicion TEXT DEFAULT CURRENT_TIMESTAMP,
  fecha_revision TEXT,
  notas TEXT
);

INSERT OR REPLACE INTO constantes_metodologicas (clave, valor, unidad, descripcion, notas)
VALUES (
  'peso_estandar_vp',
  420.0,
  'kg',
  'Peso estandar vaca/vaquillona preñada para conversion USD/cabeza a USD/kg',
  'Decidido 17/4/2026. Basado en peso medio observado en remates Plaza Rural Uy 2026. Revisar anualmente (enero).'
);


-- ============================================================================
-- 5. Verificacion final
-- ============================================================================

SELECT 'Migracion 002 completada' AS resultado;

SELECT 
  'Suma ponderaciones:' AS check,
  ROUND(SUM(ponderacion), 4) AS total,
  CASE 
    WHEN ABS(SUM(ponderacion) - 1.0) < 0.001 THEN 'OK'
    ELSE 'ERROR - no suma 1.0'
  END AS estado
FROM categorias
WHERE activo = 1;

SELECT codigo, nombre, ponderacion, unidad
FROM categorias
WHERE activo = 1
ORDER BY ponderacion DESC;
