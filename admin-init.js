// admin-init.js v2.2
// Endpoints de administracion del IGU
//
// CAMBIOS v2.2 (17/4/2026):
// - PONDERACIONES V3: NG 38% | VG 25% | VQ 12% | TE 15% | VI 7% | VP 3% (nueva)
// - Nuevo endpoint /admin/migrar-v22: aplica la migracion completa v2.2 via HTTP
// - Nuevo endpoint /admin/ejecutar-sql: corre archivos SQL arbitrarios (futuro)
// - Soporte completo para VP (peso estandar 420 kg)

const axios = require('axios');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const SECRET = 'IGU_INIT_2026';
const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';

// Ponderaciones V3 (v2.2 con VP)
const PONDERACIONES_V3 = {
  NG: { ponderacion: 0.38, nombre: 'Novillo Gordo',                descripcion: 'Novillo terminado apto frigorifico 4ta balanza', unidad: 'USD/kg' },
  VG: { ponderacion: 0.25, nombre: 'Vaca Gorda',                   descripcion: 'Vaca terminada apta frigorifico 4ta balanza',    unidad: 'USD/kg' },
  VQ: { ponderacion: 0.12, nombre: 'Vaquillona Gorda',             descripcion: 'Vaquillona terminada apta frigorifico 4ta balanza', unidad: 'USD/kg' },
  TE: { ponderacion: 0.15, nombre: 'Ternero',                      descripcion: 'Ternero de destete 140-180 kg peso vivo',        unidad: 'USD/kg' },
  VI: { ponderacion: 0.07, nombre: 'Vaca de Invernada',            descripcion: 'Vaca para recria/invernada peso vivo',           unidad: 'USD/kg' },
  VP: { ponderacion: 0.03, nombre: 'Vacas/Vaquillonas Preñadas',   descripcion: 'Hembras con diagnostico de preñez confirmado. Precio convertido USD/cabeza a USD/kg con peso estandar 420 kg.', unidad: 'USD/kg' }
};

// Mapeo hoja del Excel -> codigo IGU
const MAPEO_HOJAS = {
  'NOVILLO': 'NG',
  'VACA': 'VG',
  'VAQUILLONA': 'VQ'
};

const FECHA_BASE = '2026-01-02';
const FECHA_DESDE_HISTORICO = '2026-01-01';

// Precios base reales v2.2 (2/1/2026)
const PRECIOS_BASE_V22 = {
  NG: { precio: 5.282, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  VG: { precio: 4.754, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  VQ: { precio: 5.128, notas: 'INAC 4ta balanza - viernes 2/1/2026' },
  TE: { precio: 3.80,  notas: 'Plaza Rural + Pantalla Uruguay peso vivo - 2/1/2026' },
  VI: { precio: 2.20,  notas: 'Plaza Rural + Pantalla Uruguay peso vivo - 2/1/2026' },
  VP: { precio: 2.500, notas: 'USD 1.050/cabeza / 420 kg peso estandar - 2/1/2026' }
};

module.exports = function(app, db, calcularIGUVentana) {

  // ==========================================================================
  // ENDPOINT 1: Init de base de datos
  // ==========================================================================
  app.get('/admin/init-db', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const resultados = [];

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
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_precios_fecha ON precios_raw(fecha);
        CREATE INDEX IF NOT EXISTS idx_precios_categoria ON precios_raw(categoria_codigo);
        CREATE TABLE IF NOT EXISTS precios_promedio_diario (
          fecha TEXT NOT NULL,
          categoria_codigo TEXT NOT NULL,
          precio_promedio REAL NOT NULL,
          num_observaciones INTEGER NOT NULL,
          volumen_total INTEGER,
          fuentes TEXT,
          PRIMARY KEY (fecha, categoria_codigo)
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
        CREATE TABLE IF NOT EXISTS base_index (
          categoria_codigo TEXT PRIMARY KEY,
          fecha_base TEXT NOT NULL,
          precio_base REAL NOT NULL,
          cantidad_base REAL NOT NULL,
          notas TEXT
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
      `);
      resultados.push('Tablas creadas');

      const insertCat = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);
      Object.entries(PONDERACIONES_V3).forEach(([codigo, info]) => {
        insertCat.run(codigo, info.nombre, info.descripcion, info.ponderacion, info.unidad);
      });
      resultados.push(`${Object.keys(PONDERACIONES_V3).length} categorias cargadas (V3 con VP)`);

      res.json({ success: true, mensaje: 'BD inicializada v2.2', pasos: resultados });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT: Actualizar ponderaciones a V3 (v2.2 con VP)
  // ==========================================================================
  app.get('/admin/actualizar-ponderaciones', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const cambios = [];
      const update = db.prepare(`UPDATE categorias SET ponderacion = ? WHERE codigo = ?`);
      const insertCat = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(PONDERACIONES_V3).forEach(([codigo, info]) => {
        const antes = db.prepare(`SELECT ponderacion FROM categorias WHERE codigo = ?`).get(codigo);
        if (antes) {
          update.run(info.ponderacion, codigo);
        } else {
          // Si la categoria no existe (caso VP nueva), insertarla
          insertCat.run(codigo, info.nombre, info.descripcion, info.ponderacion, info.unidad);
        }
        cambios.push({
          codigo,
          antes: antes ? antes.ponderacion : 'nueva',
          ahora: info.ponderacion
        });
      });

      // Verificar suma
      const suma = db.prepare(`SELECT ROUND(SUM(ponderacion), 4) AS s FROM categorias WHERE activo = 1`).get();

      res.json({
        success: true,
        mensaje: 'Ponderaciones V3 (v2.2) aplicadas',
        cambios,
        suma_ponderaciones: suma.s,
        verificacion: Math.abs(suma.s - 1.0) < 0.001 ? 'OK' : 'ERROR - no suma 1.0'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT NUEVO: Migracion v2.2 completa (equivalente al SQL de migraciones/002)
  // 
  // Hace TODO lo que hace migraciones/002-categoria-vp.sql pero via HTTP,
  // sin necesidad de abrir Railway Shell.
  //
  // Uso:
  //   curl "https://www.igu.com.uy/admin/migrar-v22?secret=IGU_INIT_2026"
  // ==========================================================================
  app.get('/admin/migrar-v22', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    const log = [];
    const startTime = Date.now();

    try {
      log.push('═'.repeat(60));
      log.push('Migracion v2.2 - Nueva categoria VP + reorganizacion');
      log.push('═'.repeat(60));

      // 1. Actualizar ponderaciones + insertar VP
      log.push('\n[1] Actualizando categorias y ponderaciones V3...');
      const insertCat = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad, activo)
        VALUES (?, ?, ?, ?, ?, 1)
      `);

      Object.entries(PONDERACIONES_V3).forEach(([codigo, info]) => {
        insertCat.run(codigo, info.nombre, info.descripcion, info.ponderacion, info.unidad);
        log.push(`  ✓ ${codigo} (${info.nombre}): ponderacion ${info.ponderacion}`);
      });

      // 2. Precios base reales
      log.push('\n[2] Actualizando precios base (2/1/2026)...');
      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(PRECIOS_BASE_V22).forEach(([codigo, info]) => {
        insertBase.run(codigo, FECHA_BASE, info.precio, 1, info.notas);
        log.push(`  ✓ ${codigo}: base ${info.precio} - ${info.notas}`);
      });

      // 3. Crear tabla de constantes metodologicas
      log.push('\n[3] Creando tabla constantes_metodologicas...');
      db.exec(`
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

      db.prepare(`
        INSERT OR REPLACE INTO constantes_metodologicas (clave, valor, unidad, descripcion, notas)
        VALUES (?, ?, ?, ?, ?)
      `).run(
        'peso_estandar_vp', 420.0, 'kg',
        'Peso estandar vaca/vaquillona preñada para conversion USD/cabeza a USD/kg',
        'Decidido 17/4/2026. Revisar anualmente.'
      );
      log.push('  ✓ Constante peso_estandar_vp = 420 kg registrada');

      // 4. Verificacion
      log.push('\n[4] Verificacion final:');
      const suma = db.prepare(`SELECT ROUND(SUM(ponderacion), 4) AS s FROM categorias WHERE activo = 1`).get();
      const categoriasFinal = db.prepare(`SELECT codigo, nombre, ponderacion, unidad FROM categorias WHERE activo = 1 ORDER BY ponderacion DESC`).all();
      const basesFinal = db.prepare(`SELECT categoria_codigo, precio_base, fecha_base FROM base_index ORDER BY categoria_codigo`).all();

      log.push(`  Suma ponderaciones: ${suma.s} ${Math.abs(suma.s - 1.0) < 0.001 ? '✓' : '✗ ERROR'}`);
      log.push(`  Total categorias: ${categoriasFinal.length}`);
      log.push(`  Total bases: ${basesFinal.length}`);
      log.push(`  Duracion: ${Date.now() - startTime}ms`);

      res.json({
        success: true,
        mensaje: 'Migracion v2.2 aplicada correctamente',
        duracion_ms: Date.now() - startTime,
        suma_ponderaciones: suma.s,
        verificacion: Math.abs(suma.s - 1.0) < 0.001 ? 'OK' : 'ERROR',
        categorias: categoriasFinal,
        bases: basesFinal,
        log
      });

    } catch (err) {
      log.push(`\n✗ ERROR: ${err.message}`);
      res.status(500).json({
        error: err.message,
        stack: err.stack,
        log
      });
    }
  });

  // ==========================================================================
  // ENDPOINT NUEVO: Ejecutar archivo SQL de migraciones/
  // Para correr migraciones futuras sin Railway Shell
  //
  // Uso:
  //   curl "https://www.igu.com.uy/admin/ejecutar-sql?archivo=002-categoria-vp.sql&secret=IGU_INIT_2026"
  // ==========================================================================
  app.get('/admin/ejecutar-sql', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    const archivo = req.query.archivo;
    if (!archivo) return res.status(400).json({ error: 'Falta parametro ?archivo=nombre.sql' });

    // Validacion de seguridad: solo archivos .sql en carpeta migraciones/
    if (!archivo.match(/^[a-zA-Z0-9_-]+\.sql$/)) {
      return res.status(400).json({ error: 'Nombre de archivo invalido. Solo [a-z0-9_-].sql permitido.' });
    }

    try {
      const rutaArchivo = path.join(__dirname, 'migraciones', archivo);
      if (!fs.existsSync(rutaArchivo)) {
        return res.status(404).json({
          error: `Archivo no encontrado: migraciones/${archivo}`,
          hint: 'Verificar que el archivo este en la carpeta migraciones/ del repo.'
        });
      }

      const sql = fs.readFileSync(rutaArchivo, 'utf8');
      const startTime = Date.now();

      // Ejecutar el SQL completo
      db.exec(sql);

      const duracion = Date.now() - startTime;

      res.json({
        success: true,
        mensaje: `Migracion ${archivo} ejecutada correctamente`,
        duracion_ms: duracion,
        sql_size_bytes: sql.length,
        lineas: sql.split('\n').length
      });

    } catch (err) {
      res.status(500).json({
        error: err.message,
        archivo,
        hint: 'Algunos SQL con SELECT al final fallan via db.exec(). Usar /admin/migrar-v22 para la v2.2.'
      });
    }
  });

  // ==========================================================================
  // ENDPOINT: Actualizar precios base a v2.2 (precios reales 2/1/2026)
  // Util si ya se corrio init-db antes pero con precios viejos
  // ==========================================================================
  app.get('/admin/actualizar-bases-v22', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const cambios = [];
      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(PRECIOS_BASE_V22).forEach(([codigo, info]) => {
        const antes = db.prepare(`SELECT precio_base FROM base_index WHERE categoria_codigo = ?`).get(codigo);
        insertBase.run(codigo, FECHA_BASE, info.precio, 1, info.notas);
        cambios.push({
          codigo,
          antes: antes ? antes.precio_base : 'nueva',
          ahora: info.precio,
          notas: info.notas
        });
      });

      res.json({
        success: true,
        mensaje: 'Precios base v2.2 aplicados (2/1/2026)',
        cambios
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT: Debug Excel INAC (sin cambios)
  // ==========================================================================
  app.get('/admin/debug-excel', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const response = await axios.get(INAC_XLSX_URL, {
        timeout: 60000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Debug/1.0)' }
      });

      const workbook = XLSX.read(response.data, { type: 'buffer', cellDates: true });
      const debug = { hojas: {}, tamaño_kb: (response.data.byteLength / 1024).toFixed(1) };

      ['NOVILLO', 'VACA', 'VAQUILLONA'].forEach(nombreHoja => {
        const sheet = workbook.Sheets[nombreHoja];
        if (!sheet) {
          debug.hojas[nombreHoja] = 'NO EXISTE';
          return;
        }

        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

        const primerasFilas = [];
        let contador = 0;
        for (let i = 0; i < data.length && contador < 10; i++) {
          const row = data[i];
          if (row && row.some(c => c !== null && c !== '')) {
            primerasFilas.push({
              fila: i,
              contenido: row.slice(0, 15).map(c => c === null ? '-' : c.toString().substring(0, 30))
            });
            contador++;
          }
        }

        const ultimasFilas = [];
        contador = 0;
        for (let i = data.length - 1; i >= 0 && contador < 5; i--) {
          const row = data[i];
          if (row && row.some(c => c !== null && c !== '')) {
            ultimasFilas.push({
              fila: i,
              contenido: row.slice(0, 15).map(c => c === null ? '-' : c.toString().substring(0, 30))
            });
            contador++;
          }
        }

        debug.hojas[nombreHoja] = {
          total_filas: data.length,
          primeras_filas: primerasFilas,
          ultimas_filas: ultimasFilas.reverse()
        };
      });

      res.json(debug);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT: Importar historico INAC (sin cambios)
  // ==========================================================================
  app.get('/admin/importar-historico', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    const log = [];
    const startTime = Date.now();
    log.push(`Importando historico INAC desde ${FECHA_DESDE_HISTORICO}`);

    try {
      log.push('Descargando Excel INAC...');
      const response = await axios.get(INAC_XLSX_URL, {
        timeout: 60000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Importador/1.0)' }
      });
      log.push(`Excel descargado: ${(response.data.byteLength / 1024).toFixed(1)} KB`);

      const workbook = XLSX.read(response.data, { type: 'buffer', cellDates: true });
      log.push(`Hojas: ${workbook.SheetNames.join(', ')}`);

      const datosPorFecha = {};

      for (const [nombreHoja, codigoIGU] of Object.entries(MAPEO_HOJAS)) {
        log.push(`\nProcesando hoja "${nombreHoja}" (codigo IGU: ${codigoIGU})`);

        const sheet = workbook.Sheets[nombreHoja];
        if (!sheet) {
          log.push(`  ⚠ Hoja "${nombreHoja}" no existe, saltando`);
          continue;
        }

        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });
        log.push(`  ${data.length} filas totales`);

        const resultado = extraerPreciosHojaCategoria(data, nombreHoja, log);

        if (resultado.filas.length === 0) {
          log.push(`  ⚠ No se extrajeron datos de "${nombreHoja}"`);
          continue;
        }

        log.push(`  ✓ ${resultado.filas.length} registros extraidos`);

        resultado.filas.forEach(fila => {
          if (!datosPorFecha[fila.fecha]) datosPorFecha[fila.fecha] = {};
          datosPorFecha[fila.fecha][codigoIGU] = fila.precio;
        });
      }

      const fechasOrdenadas = Object.keys(datosPorFecha)
        .filter(f => f >= FECHA_DESDE_HISTORICO)
        .sort();

      log.push(`\n${fechasOrdenadas.length} fechas unicas desde ${FECHA_DESDE_HISTORICO}`);

      if (fechasOrdenadas.length === 0) {
        return res.status(500).json({
          error: 'No se extrajeron datos desde enero 2026',
          log
        });
      }

      let fechaBaseUsada = FECHA_BASE;
      if (!datosPorFecha[FECHA_BASE]) {
        fechaBaseUsada = fechasOrdenadas[0];
        log.push(`Fecha ${FECHA_BASE} no encontrada, usando ${fechaBaseUsada} como base`);
      }

      const preciosBase = datosPorFecha[fechaBaseUsada];
      log.push(`Base: ${fechaBaseUsada}`);

      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(preciosBase).forEach(([codigo, precio]) => {
        insertBase.run(codigo, fechaBaseUsada, precio, 1, `Base enero 2026 INAC`);
      });

      // Para TE, VI, VP (INAC no publica)
      const basesNoINAC = {
        TE: { precio: 3.80,  notas: 'Base enero 2026 - pantallas (peso vivo)' },
        VI: { precio: 2.20,  notas: 'Base enero 2026 - pantallas (peso vivo)' },
        VP: { precio: 2.500, notas: 'Base enero 2026 - USD 1050/cab / 420 kg' }
      };
      Object.entries(basesNoINAC).forEach(([codigo, info]) => {
        if (!preciosBase[codigo]) {
          insertBase.run(codigo, fechaBaseUsada, info.precio, 1, info.notas);
          log.push(`Base ${codigo} = ${info.precio} USD/kg (${info.notas})`);
        }
      });

      db.prepare(`DELETE FROM precios_raw WHERE fuente = 'inac'`).run();
      db.prepare(`DELETE FROM indice`).run();
      db.prepare(`DELETE FROM precios_promedio_diario`).run();
      log.push(`Datos previos de INAC eliminados`);

      const insertPrecio = db.prepare(`
        INSERT INTO precios_raw (fecha, categoria_codigo, fuente, precio, unidad, observaciones)
        VALUES (?, ?, ?, ?, 'USD/kg', ?)
      `);

      const transaction = db.transaction((fechas) => {
        fechas.forEach(fecha => {
          const precios = datosPorFecha[fecha];
          Object.entries(precios).forEach(([codigo, precio]) => {
            insertPrecio.run(fecha, codigo, 'inac', precio, `INAC serie semanal - ${fecha}`);
          });
        });
      });

      transaction(fechasOrdenadas);
      const totalInsertado = fechasOrdenadas.reduce((s, f) => s + Object.keys(datosPorFecha[f]).length, 0);
      log.push(`${totalInsertado} registros insertados en precios_raw`);

      const valoresIGU = [];
      if (calcularIGUVentana) {
        fechasOrdenadas.forEach(fecha => {
          try {
            const r = calcularIGUVentana(fecha);
            if (r && r.igu_general !== null && !r.error) {
              valoresIGU.push({
                fecha,
                igu: parseFloat(r.igu_general.toFixed(4)),
                sub_carne: r.sub_carne ? parseFloat(r.sub_carne.toFixed(4)) : null,
                sub_reposicion: r.sub_reposicion ? parseFloat(r.sub_reposicion.toFixed(4)) : null,
                sub_cria: r.sub_cria ? parseFloat(r.sub_cria.toFixed(4)) : null
              });
            }
          } catch (e) {
            log.push(`Error IGU ${fecha}: ${e.message}`);
          }
        });
      }

      res.json({
        success: true,
        mensaje: 'Historico INAC importado correctamente',
        duracion_ms: Date.now() - startTime,
        fecha_base: fechaBaseUsada,
        precios_base: preciosBase,
        fechas_importadas: fechasOrdenadas.length,
        registros_totales: totalInsertado,
        valores_igu: valoresIGU,
        primeras_5_fechas: fechasOrdenadas.slice(0, 5),
        ultimas_5_fechas: fechasOrdenadas.slice(-5),
        log
      });

    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack, log });
    }
  });

  // ==========================================================================
  // ENDPOINT: Recalcular todo
  // ==========================================================================
  app.get('/admin/recalcular-todo', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const fechas = db.prepare(`SELECT DISTINCT fecha FROM precios_raw ORDER BY fecha ASC`).all().map(r => r.fecha);
      db.prepare(`DELETE FROM indice`).run();

      const resultados = [];
      fechas.forEach(fecha => {
        try {
          const r = calcularIGUVentana(fecha);
          if (r && r.igu_general !== null && !r.error) {
            resultados.push({ fecha, igu: parseFloat(r.igu_general.toFixed(4)) });
          }
        } catch (e) {
          resultados.push({ fecha, error: e.message });
        }
      });

      res.json({
        success: true,
        total_fechas: fechas.length,
        calculados: resultados.filter(r => r.igu).length,
        valores: resultados
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT: Status
  // ==========================================================================
  app.get('/admin/status', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });
    try {
      const tablas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
      const categorias = db.prepare(`SELECT codigo, nombre, ponderacion, unidad FROM categorias ORDER BY ponderacion DESC`).all();
      const bases = db.prepare(`SELECT * FROM base_index`).all();
      const numRaw = db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n;
      const numIndice = db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n;
      const ultimoIndice = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();
      const sumaPond = db.prepare(`SELECT ROUND(SUM(ponderacion), 4) AS s FROM categorias WHERE activo = 1`).get();

      res.json({
        version: '2.2',
        tablas,
        categorias,
        bases,
        suma_ponderaciones: sumaPond.s,
        verificacion: Math.abs(sumaPond.s - 1.0) < 0.001 ? 'OK' : 'ERROR',
        total_precios_raw: numRaw,
        total_indices: numIndice,
        ultimo_indice: ultimoIndice
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  console.log('Admin endpoints v2.2: /init-db, /actualizar-ponderaciones, /actualizar-bases-v22, /migrar-v22, /ejecutar-sql, /importar-historico, /debug-excel, /recalcular-todo, /status');
};


// ============================================================================
// FUNCION: Extraer precios de una hoja de categoria (sin cambios)
// ============================================================================

const COL_FECHA_INICIO = 0;
const COL_FECHA_FIN = 1;
const COL_4TA_BALANZA = 9;
const FILA_DATOS_DESDE = 12;

function extraerPreciosHojaCategoria(data, nombreHoja, log) {
  const resultado = { filas: [], columnaUsada: `col ${COL_4TA_BALANZA} (EN CUARTA BALANZA USD/kg)` };

  log.push(`  Usando estructura fija INAC: fecha=col ${COL_FECHA_INICIO}, precio 4ta bza=col ${COL_4TA_BALANZA}, desde fila ${FILA_DATOS_DESDE}`);

  let filasSalteadasSinFecha = 0;
  let filasSalteadasSinPrecio = 0;

  for (let i = FILA_DATOS_DESDE; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 10) continue;

    const fecha = parsearFechaINAC(row[COL_FECHA_FIN]) || parsearFechaINAC(row[COL_FECHA_INICIO]);
    if (!fecha) {
      filasSalteadasSinFecha++;
      continue;
    }

    const precio = parseFloat(row[COL_4TA_BALANZA]);
    if (isNaN(precio) || precio <= 0 || precio > 20) {
      filasSalteadasSinPrecio++;
      continue;
    }

    resultado.filas.push({
      fecha: fecha.toISOString().split('T')[0],
      precio
    });
  }

  if (resultado.filas.length > 0) {
    const primera = resultado.filas[0];
    const ultima = resultado.filas[resultado.filas.length - 1];
    log.push(`  Rango: ${primera.fecha} (${primera.precio}) → ${ultima.fecha} (${ultima.precio})`);
  }
  log.push(`  Filas omitidas: ${filasSalteadasSinFecha} sin fecha, ${filasSalteadasSinPrecio} sin precio valido`);

  return resultado;
}

function parsearFechaINAC(valor) {
  if (!valor) return null;

  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }

  if (typeof valor === 'string') {
    const m = valor.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [_, mes, dia, anio] = m;
      mes = parseInt(mes);
      dia = parseInt(dia);
      anio = parseInt(anio);

      if (anio < 100) {
        anio = anio < 50 ? 2000 + anio : 1900 + anio;
      }

      if (anio < 2000 || anio > 2100) return null;
      if (mes < 1 || mes > 12) return null;
      if (dia < 1 || dia > 31) return null;

      const fecha = new Date(anio, mes - 1, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }

    const m2 = valor.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const fecha = new Date(valor);
      if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000) return fecha;
    }
  }

  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    const excelEpoch = new Date(1900, 0, 1);
    const fecha = new Date(excelEpoch.getTime() + (valor - 2) * 86400000);
    if (fecha.getFullYear() > 2000 && fecha.getFullYear() < 2100) return fecha;
  }

  return null;
}
