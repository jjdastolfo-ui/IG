// admin-init.js
// Endpoints de administracion del IGU
// Incluye: init-db, status, actualizar-ponderaciones, importar-historico, recalcular-todo

const axios = require('axios');
const XLSX = require('xlsx');

const SECRET = 'IGU_INIT_2026';

const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';

// Ponderaciones V2 - basadas en valor economico comercializado 2020-2024
const PONDERACIONES_V2 = {
  NG: { ponderacion: 0.40, nombre: 'Novillo Gordo',     descripcion: 'Novillo terminado apto frigorifico 480-520 kg' },
  VG: { ponderacion: 0.25, nombre: 'Vaca Gorda',        descripcion: 'Vaca terminada apta frigorifico' },
  TE: { ponderacion: 0.15, nombre: 'Ternero',           descripcion: 'Ternero de destete 140-180 kg' },
  VQ: { ponderacion: 0.12, nombre: 'Vaquillona',        descripcion: 'Vaquillona de reposicion 220-280 kg' },
  VI: { ponderacion: 0.08, nombre: 'Vaca de Invernada', descripcion: 'Vaca para recria/invernada' }
};

// Fecha base del IGU = primer viernes habil de enero 2026
const FECHA_BASE = '2026-01-02';
const FECHA_DESDE_HISTORICO = '2026-01-01';

module.exports = function(app, db, calcularIGUVentana) {

  // ==========================================================================
  // ENDPOINT 1: Init de base de datos (primera vez)
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
          metodologia_version TEXT DEFAULT '2.0',
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

      // Cargar categorias V2
      const insertCat = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);
      Object.entries(PONDERACIONES_V2).forEach(([codigo, info]) => {
        insertCat.run(codigo, info.nombre, info.descripcion, info.ponderacion, 'USD/kg');
      });
      resultados.push(`${Object.keys(PONDERACIONES_V2).length} categorias cargadas (V2)`);

      res.json({
        success: true,
        mensaje: 'Base de datos inicializada',
        pasos: resultados,
        siguiente_paso: 'Abrir /admin/importar-historico?secret=XXX para cargar datos INAC'
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT 2: Actualizar ponderaciones a V2
  // ==========================================================================
  app.get('/admin/actualizar-ponderaciones', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      const cambios = [];
      const update = db.prepare(`UPDATE categorias SET ponderacion = ? WHERE codigo = ?`);

      Object.entries(PONDERACIONES_V2).forEach(([codigo, info]) => {
        const antes = db.prepare(`SELECT ponderacion FROM categorias WHERE codigo = ?`).get(codigo);
        update.run(info.ponderacion, codigo);
        cambios.push({
          codigo,
          antes: antes ? antes.ponderacion : 'nuevo',
          ahora: info.ponderacion
        });
      });

      res.json({ success: true, mensaje: 'Ponderaciones V2 aplicadas', cambios });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT 3: Importar historico INAC y fijar base enero 2026
  // ==========================================================================
  app.get('/admin/importar-historico', async (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    const log = [];
    log.push(`Importando historico INAC desde ${FECHA_DESDE_HISTORICO}`);
    log.push(`Fecha base del IGU: ${FECHA_BASE}`);

    try {
      // 1. Descargar Excel
      log.push('Descargando Excel INAC...');
      const response = await axios.get(INAC_XLSX_URL, {
        timeout: 60000,
        responseType: 'arraybuffer',
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; IGU-Importador/1.0)' }
      });
      log.push(`Excel descargado: ${(response.data.byteLength / 1024).toFixed(1)} KB`);

      const workbook = XLSX.read(response.data, { type: 'buffer', cellDates: true });
      log.push(`Hojas: ${workbook.SheetNames.join(', ')}`);

      // 2. Parsear cada hoja y quedarse con la que tiene mas datos
      let mejorResultado = { semanas: [], debug: {} };

      for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

        log.push(`Procesando hoja "${sheetName}" (${data.length} filas)`);
        const resultado = parsearExcelINAC(data);

        log.push(`  Debug: headers en fila ${resultado.debug.headerRowIdx}, ${resultado.debug.columnas} columnas mapeadas`);
        if (resultado.debug.headers) {
          log.push(`  Headers detectados: ${resultado.debug.headers.slice(0, 6).join(' | ')}`);
        }

        if (resultado.semanas.length > mejorResultado.semanas.length) {
          mejorResultado = resultado;
          mejorResultado.hojaUsada = sheetName;
        }
      }

      if (mejorResultado.semanas.length === 0) {
        return res.status(500).json({
          error: 'No se pudieron extraer datos del Excel INAC',
          log,
          debug: mejorResultado.debug
        });
      }

      log.push(`Usando hoja "${mejorResultado.hojaUsada}" con ${mejorResultado.semanas.length} semanas`);

      // 3. Filtrar solo semanas desde enero 2026
      const semanasFiltradas = mejorResultado.semanas.filter(s => s.fecha >= FECHA_DESDE_HISTORICO);
      log.push(`Semanas desde ${FECHA_DESDE_HISTORICO}: ${semanasFiltradas.length}`);

      // 4. Fijar precio base = primer viernes habil enero 2026
      const semanaBase = semanasFiltradas.find(s => s.fecha === FECHA_BASE)
                       || semanasFiltradas.find(s => s.fecha <= FECHA_BASE && s.fecha >= '2026-01-02')
                       || semanasFiltradas[0];

      if (!semanaBase) {
        return res.status(500).json({ error: 'No se encontro semana base enero 2026', log });
      }

      log.push(`Semana base encontrada: ${semanaBase.fecha}`);
      log.push(`Precios base: ${JSON.stringify(semanaBase.precios)}`);

      // 5. Guardar precios base en tabla base_index
      // OJO: TE (Ternero) no viene de INAC. Usamos el primer dato disponible de pantallas
      // Para los datos INAC extraidos: NG, VG, VQ
      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(semanaBase.precios).forEach(([codigo, precio]) => {
        insertBase.run(codigo, FECHA_BASE, precio, 1, `Base enero 2026 - INAC ${FECHA_BASE}`);
        log.push(`  Base ${codigo} = ${precio} USD/kg`);
      });

      // Para TE y VI (que INAC no publica), usar valores de referencia enero 2026
      // Basados en reportes publicos de Plaza Rural / Pantalla Uruguay
      const basesPantallas = {
        TE: 3.80,   // Ternero 140-180 kg - referencia enero 2026
        VI: 2.20    // Vaca de invernada - referencia enero 2026
      };

      Object.entries(basesPantallas).forEach(([codigo, precio]) => {
        if (!semanaBase.precios[codigo]) {
          insertBase.run(codigo, FECHA_BASE, precio, 1, `Base enero 2026 - referencia pantallas`);
          log.push(`  Base ${codigo} = ${precio} USD/kg (referencia pantallas, INAC no publica)`);
        }
      });

      // 6. Cargar todas las semanas historicas en precios_raw
      const insertPrecio = db.prepare(`
        INSERT INTO precios_raw (fecha, categoria_codigo, fuente, precio, unidad, observaciones)
        VALUES (?, ?, ?, ?, 'USD/kg', ?)
      `);

      // Limpiar precios previos de INAC en el rango (para evitar duplicados si se corre de nuevo)
      db.prepare(`DELETE FROM precios_raw WHERE fuente = 'inac' AND fecha >= ?`).run(FECHA_DESDE_HISTORICO);

      const transaction = db.transaction((semanas) => {
        semanas.forEach(semana => {
          Object.entries(semana.precios).forEach(([codigo, precio]) => {
            insertPrecio.run(semana.fecha, codigo, 'inac', precio, `INAC serie semanal - ${semana.fecha}`);
          });
        });
      });

      transaction(semanasFiltradas);
      log.push(`${semanasFiltradas.length} semanas cargadas en precios_raw`);

      // 7. Recalcular IGU para cada viernes
      let iguCalculados = 0;
      const valoresIGU = [];
      if (calcularIGUVentana) {
        for (const semana of semanasFiltradas) {
          try {
            const r = calcularIGUVentana(semana.fecha);
            if (r && r.igu_general !== null && !r.error) {
              iguCalculados++;
              valoresIGU.push({ fecha: semana.fecha, igu: r.igu_general });
            }
          } catch (e) {
            log.push(`Error calculando ${semana.fecha}: ${e.message}`);
          }
        }
      }
      log.push(`${iguCalculados} valores de IGU calculados`);

      res.json({
        success: true,
        mensaje: 'Historico importado correctamente',
        duracion_ms: Date.now() - Date.now(),
        fecha_base: FECHA_BASE,
        semanas_importadas: semanasFiltradas.length,
        igus_calculados: iguCalculados,
        valores_igu: valoresIGU,
        precios_base: semanaBase.precios,
        log
      });

    } catch (err) {
      res.status(500).json({ error: err.message, stack: err.stack, log });
    }
  });

  // ==========================================================================
  // ENDPOINT 4: Recalcular todo el IGU
  // ==========================================================================
  app.get('/admin/recalcular-todo', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });

    try {
      // Obtener todas las fechas con datos en precios_raw
      const fechas = db.prepare(`
        SELECT DISTINCT fecha FROM precios_raw ORDER BY fecha ASC
      `).all().map(r => r.fecha);

      // Limpiar tabla indice
      db.prepare(`DELETE FROM indice`).run();

      const resultados = [];
      fechas.forEach(fecha => {
        try {
          const r = calcularIGUVentana(fecha);
          if (r && r.igu_general !== null && !r.error) {
            resultados.push({ fecha, igu: r.igu_general });
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
  // ENDPOINT 5: Status
  // ==========================================================================
  app.get('/admin/status', (req, res) => {
    if (req.query.secret !== SECRET) return res.status(403).json({ error: 'No autorizado' });
    try {
      const tablas = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all().map(t => t.name);
      const categorias = db.prepare(`SELECT codigo, nombre, ponderacion FROM categorias`).all();
      const bases = db.prepare(`SELECT * FROM base_index`).all();
      const numRaw = db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n;
      const numIndice = db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n;
      const ultimoIndice = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();

      res.json({
        tablas,
        categorias,
        bases,
        total_precios_raw: numRaw,
        total_indices: numIndice,
        ultimo_indice: ultimoIndice
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  console.log('Endpoints admin activos: /admin/init-db, /admin/actualizar-ponderaciones, /admin/importar-historico, /admin/recalcular-todo, /admin/status');
};


// ============================================================================
// FUNCION: Parsear Excel INAC
// ============================================================================

function parsearExcelINAC(data) {
  const resultado = { semanas: [], debug: {} };

  // 1. Buscar fila de headers
  let headerRowIdx = -1;
  let headers = null;

  for (let i = 0; i < Math.min(20, data.length); i++) {
    const row = data[i];
    if (!row) continue;
    const rowText = row.map(c => (c || '').toString().toLowerCase()).join(' | ');

    if (rowText.includes('novillo') && (rowText.includes('vaca') || rowText.includes('vaquillona'))
        && (rowText.includes('bza') || rowText.includes('balanza'))) {
      headerRowIdx = i;
      headers = row.map(h => (h || '').toString().trim());
      break;
    }
  }

  resultado.debug.headerRowIdx = headerRowIdx;
  resultado.debug.headers = headers;

  if (headerRowIdx === -1) return resultado;

  // 2. Mapear columnas (preferir 4ta balanza, no Campo)
  const mapeo = {};

  headers.forEach((header, idx) => {
    const h = header.toLowerCase().replace(/\s+/g, ' ').trim();
    const es4ta = h.includes('4ta') || h.includes('4°') || h.includes('cuarta');
    const tieneBza = h.includes('bza') || h.includes('balanza');
    if (!es4ta || !tieneBza) return;

    const esCampo = h.includes('campo');

    if (h.includes('novillo')) {
      if (!mapeo.NG || (mapeo.NG.esCampo && !esCampo)) {
        mapeo.NG = { idx, header, esCampo };
      }
    } else if (h.includes('vaquillona')) {
      if (!mapeo.VQ || (mapeo.VQ.esCampo && !esCampo)) {
        mapeo.VQ = { idx, header, esCampo };
      }
    } else if (h.includes('vaca')) {
      if (!mapeo.VG || (mapeo.VG.esCampo && !esCampo)) {
        mapeo.VG = { idx, header, esCampo };
      }
    }
  });

  resultado.debug.columnas = Object.keys(mapeo).length;
  resultado.debug.mapeo = mapeo;

  if (Object.keys(mapeo).length === 0) return resultado;

  // 3. Extraer TODAS las filas con datos validos
  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;

    // Detectar fecha en las primeras 3 columnas
    let fecha = null;
    for (let j = 0; j < Math.min(3, row.length); j++) {
      const f = parsearFecha(row[j]);
      if (f) {
        fecha = f.toISOString().split('T')[0];
        break;
      }
    }

    if (!fecha) continue;

    // Extraer precios para cada categoria mapeada
    const precios = {};
    Object.entries(mapeo).forEach(([codigo, info]) => {
      const val = parseFloat(row[info.idx]);
      if (!isNaN(val) && val > 0 && val < 20) {
        precios[codigo] = val;
      }
    });

    if (Object.keys(precios).length > 0) {
      resultado.semanas.push({ fecha, precios });
    }
  }

  return resultado;
}

function parsearFecha(valor) {
  if (!valor) return null;

  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }

  if (typeof valor === 'string') {
    // DD/MM/YYYY o DD-MM-YYYY
    const m1 = valor.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m1) {
      let [_, d, mes, y] = m1;
      if (y.length === 2) y = '20' + y;
      const fecha = new Date(parseInt(y), parseInt(mes) - 1, parseInt(d));
      if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000) return fecha;
    }

    // YYYY-MM-DD
    const m2 = valor.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const fecha = new Date(valor);
      if (!isNaN(fecha.getTime())) return fecha;
    }

    const fecha = new Date(valor);
    if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000 && fecha.getFullYear() < 2100) {
      return fecha;
    }
  }

  // Serial date Excel
  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    const excelEpoch = new Date(1900, 0, 1);
    return new Date(excelEpoch.getTime() + (valor - 2) * 86400000);
  }

  return null;
}
