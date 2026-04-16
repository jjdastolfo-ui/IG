// admin-init.js
// Endpoint temporal para inicializar la base de datos desde el navegador
// BORRAR ESTE ARCHIVO DESPUÉS DEL INIT

const SECRET = 'IGU_INIT_2026';

module.exports = function(app, db) {

  app.get('/admin/init-db', (req, res) => {
    const { secret } = req.query;
    if (secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }

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
      `);
      resultados.push('Tabla categorias creada');

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
      resultados.push('Tabla precios_raw creada');

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
      resultados.push('Tabla precios_promedio_diario creada');

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
      resultados.push('Tabla indice creada');

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
      resultados.push('Tabla base_index creada');

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
      resultados.push('Tabla scraping_log creada');

      const insertCategoria = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);
      const categorias = [
        { codigo: 'NG', nombre: 'Novillo Gordo', descripcion: 'Novillo terminado apto frigorifico 480-520 kg', ponderacion: 0.40, unidad: 'USD/kg' },
        { codigo: 'VG', nombre: 'Vaca Gorda', descripcion: 'Vaca terminada apta frigorifico', ponderacion: 0.20, unidad: 'USD/kg' },
        { codigo: 'TE', nombre: 'Ternero', descripcion: 'Ternero de destete 140-180 kg', ponderacion: 0.20, unidad: 'USD/kg' },
        { codigo: 'VQ', nombre: 'Vaquillona', descripcion: 'Vaquillona de reposicion 220-280 kg', ponderacion: 0.10, unidad: 'USD/kg' },
        { codigo: 'VI', nombre: 'Vaca de Invernada', descripcion: 'Vaca para recria/invernada', ponderacion: 0.10, unidad: 'USD/kg' }
      ];
      categorias.forEach(cat => {
        insertCategoria.run(cat.codigo, cat.nombre, cat.descripcion, cat.ponderacion, cat.unidad);
      });
      resultados.push(categorias.length + ' categorias cargadas');

      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);
      const basesIniciales = [
        { codigo: 'NG', precio: 4.20, cantidad: 1, notas: 'Base 2024 placeholder' },
        { codigo: 'VG', precio: 3.50, cantidad: 1, notas: 'Base 2024 placeholder' },
        { codigo: 'TE', precio: 3.80, cantidad: 1, notas: 'Base 2024 placeholder' },
        { codigo: 'VQ', precio: 3.20, cantidad: 1, notas: 'Base 2024 placeholder' },
        { codigo: 'VI', precio: 2.80, cantidad: 1, notas: 'Base 2024 placeholder' }
      ];
      basesIniciales.forEach(b => {
        insertBase.run(b.codigo, '2024-01-01', b.precio, b.cantidad, b.notas);
      });
      resultados.push(basesIniciales.length + ' precios base cargados');

      const numCats = db.prepare('SELECT COUNT(*) as n FROM categorias').get().n;
      const numBases = db.prepare('SELECT COUNT(*) as n FROM base_index').get().n;

      res.json({
        success: true,
        mensaje: 'Base de datos inicializada correctamente',
        pasos: resultados,
        verificacion: { categorias_en_db: numCats, bases_en_db: numBases },
        siguiente_paso: 'BORRAR admin-init.js del repo y cargar precios desde el dashboard'
      });

    } catch (err) {
      res.status(500).json({ error: 'Error al inicializar', detalle: err.message });
    }
  });

  app.get('/admin/status', (req, res) => {
    const { secret } = req.query;
    if (secret !== SECRET) {
      return res.status(403).json({ error: 'No autorizado' });
    }
    try {
      const tablas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all();
      res.json({
        status: 'ok',
        tablas: tablas.map(t => t.name)
      });
    } catch (err) {
      res.json({ status: 'error', error: err.message });
    }
  });

  console.log('Endpoints de admin activos: /admin/init-db y /admin/status');
};
