// admin-init.js
// Endpoint temporal para inicializar la base de datos desde el navegador
// Útil cuando no hay acceso a Shell en Railway
//
// USO:
// 1. Agregar este archivo al repo
// 2. En server.js, agregar al inicio: const adminInit = require('./admin-init');
// 3. En server.js, después de crear app, agregar: adminInit(app, db);
// 4. Deploy, abrir en navegador:
//    https://tu-url.up.railway.app/admin/init-db?secret=IGU_INIT_2026
// 5. Una vez inicializado, BORRAR este archivo por seguridad

const SECRET = 'IGU_INIT_2026';  // Cambiar por algo único tuyo

module.exports = function(app, db) {

  // Endpoint de inicialización
  app.get('/admin/init-db', (req, res) => {
    const { secret } = req.query;

    if (secret !== SECRET) {
      return res.status(403).json({
        error: 'No autorizado. Usar ?secret=XXX con el secret correcto.'
      });
    }

    try {
      const resultados = [];

      // Crear tabla categorias
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
      resultados.push('✓ Tabla categorias creada');

      // Crear tabla precios_raw
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
      resultados.push('✓ Tabla precios_raw creada');

      // Crear tabla precios_promedio_diario
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
      resultados.push('✓ Tabla precios_promedio_diario creada');

      // Crear tabla indice
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
      resultados.push('✓ Tabla indice creada');

      // Crear tabla base_index
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
      resultados.push('✓ Tabla base_index creada');

      // Crear tabla scraping_log
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
      resultados.push('✓ Tabla scraping_log creada');

      // Insertar categorías iniciales
      const insertCategoria = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);

      const categorias = [
        { codigo: 'NG', nombre: 'Novillo Gordo', descripcion: 'Novillo terminado apto frigorífico, 480-520 kg', ponderacion: 0.40, unidad: 'USD/kg' },
        { codigo: 'VG', nombre: 'Vaca Gorda', descripcion: 'Vaca terminada apta frigorífico', ponderacion: 0.20, unidad: 'USD/kg' },
        { codigo: 'TE', nombre: 'Ternero', descripcion: 'Ternero de destete, 140-180 kg', ponderacion: 0.20, unidad: 'USD/kg' },
        { codigo: 'VQ', nombre: 'Vaquillona', descripcion: 'Vaquillona de reposición, 220-280 kg', ponderacion: 0.10, unidad: 'USD/kg' },
        { codigo: 'VI', nombre: 'Vaca de Invernada', descripcion: 'Vaca para recría/invernada', ponderacion: 0.10, unidad: 'USD/kg' }
      ];

      categorias.forEach(cat => {
        insertCategoria.run(cat.codigo, cat.nombre, cat.descripcion, cat.ponderacion, cat.unidad);
      });
      resultados.push(`✓ ${categorias.length} categorías cargadas`);

      // Insertar precios base
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
      resultados.push(`✓ ${basesIniciales.length} precios base cargados`);

      // Verificar
      const numCats = db.prepare('SELECT COUNT(*) as n FROM categorias').get().n;
      const numBases = db.prepare('SELECT COUNT(*) as n FROM base_index').get().n;

      res.json({
        success: true,
        mensaje: '¡Base de datos inicializada correctamente!',
        pasos: resultados,
        verificacion: {
          categorias_en_db: numCats,
          bases_en_db: numBases
        },
        siguiente_paso: 'BORRAR admin-init.js del repo por seguridad y cargar los primeros precios desde el dashboard'
      });

    } catch (err) {
      res.status(500).json({
        error: 'Error al inicializar',
        detalle: err.message,
        stack: err.stack
      });
    }
  });

  // Endpoint de diagnóstico: verificar estado de la BD
  app.get('/admin/status', (req, res) => {
    const { secret } = req.query;
    if (secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

    try {
      const tablas = db.prepare(`
        SELECT name FROM sqlite_master WHERE type='table' ORDER BY name
      `).all();

      const numCategorias = db.prepare('SELECT COUNT(*) as n FROM categorias').get()?.n ?? 0;
      const numPrecios = db.prepare('SELECT COUNT(*) as n FROM precios_raw').get()?.n ?? 0;
      const numIndices = db.prepare('SELECT COUNT(*) as n FROM indice').get()?.n ?? 0;

      res.json({
        status: 'ok',
        tablas: tablas.map(t => t.name),
        conteos: {
          categorias: numCategorias,
          precios_raw: numPrecios,
          indice: numIndices
        }
      });
    } catch (err) {
      res.json({
        status: 'error',
        mensaje: 'La base de datos probablemente no está inicializada',
        error: err.message
      });
    }
  });

  console.log('⚠️  Endpoints de admin activos: /admin/init-db y /admin/status');
  console.log('⚠️  BORRAR admin-init.js después del init por seguridad');
};
