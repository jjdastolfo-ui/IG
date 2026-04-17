// admin-init.js
// Endpoints de administracion del IGU
// CORREGIDO: El Excel INAC tiene hojas separadas por categoria (NOVILLO, VACA, VAQUILLONA)

const axios = require('axios');
const XLSX = require('xlsx');

const SECRET = 'IGU_INIT_2026';
const INAC_XLSX_URL = 'https://www.inac.uy/innovaportal/file/10952/1/webinac---serie-semanal-precios-de-hacienda.xlsx';

// Ponderaciones V2
const PONDERACIONES_V2 = {
  NG: { ponderacion: 0.40, nombre: 'Novillo Gordo',     descripcion: 'Novillo terminado apto frigorifico 480-520 kg' },
  VG: { ponderacion: 0.25, nombre: 'Vaca Gorda',        descripcion: 'Vaca terminada apta frigorifico' },
  TE: { ponderacion: 0.15, nombre: 'Ternero',           descripcion: 'Ternero de destete 140-180 kg' },
  VQ: { ponderacion: 0.12, nombre: 'Vaquillona',        descripcion: 'Vaquillona de reposicion 220-280 kg' },
  VI: { ponderacion: 0.08, nombre: 'Vaca de Invernada', descripcion: 'Vaca para recria/invernada' }
};

// Mapeo hoja del Excel → codigo IGU
const MAPEO_HOJAS = {
  'NOVILLO': 'NG',
  'VACA': 'VG',
  'VAQUILLONA': 'VQ'
};

const FECHA_BASE = '2026-01-02';
const FECHA_DESDE_HISTORICO = '2026-01-01';

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

      const insertCat = db.prepare(`
        INSERT OR REPLACE INTO categorias (codigo, nombre, descripcion, ponderacion, unidad)
        VALUES (?, ?, ?, ?, ?)
      `);
      Object.entries(PONDERACIONES_V2).forEach(([codigo, info]) => {
        insertCat.run(codigo, info.nombre, info.descripcion, info.ponderacion, 'USD/kg');
      });
      resultados.push(`${Object.keys(PONDERACIONES_V2).length} categorias cargadas`);

      res.json({ success: true, mensaje: 'BD inicializada', pasos: resultados });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ==========================================================================
  // ENDPOINT: Actualizar ponderaciones
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
  // NUEVO: Endpoint de DEBUG para inspeccionar la estructura del Excel INAC
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

      // Inspeccionar solo NOVILLO, VACA, VAQUILLONA
      ['NOVILLO', 'VACA', 'VAQUILLONA'].forEach(nombreHoja => {
        const sheet = workbook.Sheets[nombreHoja];
        if (!sheet) {
          debug.hojas[nombreHoja] = 'NO EXISTE';
          return;
        }

        const data = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: null });

        // Mostrar las primeras 10 filas no vacias
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

        // Mostrar las ultimas 5 filas no vacias
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
  // ENDPOINT: Importar historico INAC (CORREGIDO para hojas separadas)
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

      // Datos a consolidar: { fecha → { codigo → precio } }
      const datosPorFecha = {};

      // Procesar cada hoja de categoria
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

        log.push(`  ✓ ${resultado.filas.length} registros extraidos (col usada: "${resultado.columnaUsada}")`);

        // Consolidar en datosPorFecha
        resultado.filas.forEach(fila => {
          if (!datosPorFecha[fila.fecha]) datosPorFecha[fila.fecha] = {};
          datosPorFecha[fila.fecha][codigoIGU] = fila.precio;
        });
      }

      // Filtrar fechas desde enero 2026
      const fechasOrdenadas = Object.keys(datosPorFecha)
        .filter(f => f >= FECHA_DESDE_HISTORICO)
        .sort();

      log.push(`\n${fechasOrdenadas.length} fechas unicas desde ${FECHA_DESDE_HISTORICO}`);

      if (fechasOrdenadas.length === 0) {
        return res.status(500).json({
          error: 'No se extrajeron datos desde enero 2026',
          log,
          fechas_totales: Object.keys(datosPorFecha).length,
          primeras_fechas: Object.keys(datosPorFecha).sort().slice(0, 5),
          ultimas_fechas: Object.keys(datosPorFecha).sort().slice(-5)
        });
      }

      // Buscar semana base (primer viernes habil enero 2026 o lo mas cercano)
      let fechaBaseUsada = FECHA_BASE;
      if (!datosPorFecha[FECHA_BASE]) {
        // Buscar la fecha mas cercana al 2/1/2026
        fechaBaseUsada = fechasOrdenadas[0];
        log.push(`Fecha ${FECHA_BASE} no encontrada, usando ${fechaBaseUsada} como base`);
      }

      const preciosBase = datosPorFecha[fechaBaseUsada];
      log.push(`Base: ${fechaBaseUsada}`);
      log.push(`Precios base INAC: ${JSON.stringify(preciosBase)}`);

      // Guardar precios base en tabla base_index
      const insertBase = db.prepare(`
        INSERT OR REPLACE INTO base_index (categoria_codigo, fecha_base, precio_base, cantidad_base, notas)
        VALUES (?, ?, ?, ?, ?)
      `);

      Object.entries(preciosBase).forEach(([codigo, precio]) => {
        insertBase.run(codigo, fechaBaseUsada, precio, 1, `Base enero 2026 INAC`);
      });

      // Para TE y VI (INAC no publica), usar referencias de enero 2026 de pantallas
      const basesPantallas = { TE: 3.80, VI: 2.20 };
      Object.entries(basesPantallas).forEach(([codigo, precio]) => {
        if (!preciosBase[codigo]) {
          insertBase.run(codigo, fechaBaseUsada, precio, 1, `Base enero 2026 - referencia pantallas`);
          log.push(`Base ${codigo} = ${precio} USD/kg (pantallas, INAC no publica)`);
        }
      });

      // Limpiar registros INAC previos
      db.prepare(`DELETE FROM precios_raw WHERE fuente = 'inac' AND fecha >= ?`).run(FECHA_DESDE_HISTORICO);

      // Insertar todos los registros en precios_raw
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

      // Recalcular IGU para cada viernes
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
      const categorias = db.prepare(`SELECT codigo, nombre, ponderacion FROM categorias`).all();
      const bases = db.prepare(`SELECT * FROM base_index`).all();
      const numRaw = db.prepare(`SELECT COUNT(*) as n FROM precios_raw`).get().n;
      const numIndice = db.prepare(`SELECT COUNT(*) as n FROM indice`).get().n;
      const ultimoIndice = db.prepare(`SELECT * FROM indice ORDER BY fecha DESC LIMIT 1`).get();

      res.json({
        tablas, categorias, bases,
        total_precios_raw: numRaw,
        total_indices: numIndice,
        ultimo_indice: ultimoIndice
      });
    } catch (err) {
      res.json({ error: err.message });
    }
  });

  console.log('Admin endpoints: /init-db, /actualizar-ponderaciones, /importar-historico, /debug-excel, /recalcular-todo, /status');
};


// ============================================================================
// FUNCION: Extraer precios de una hoja de categoria (NOVILLO / VACA / VAQUILLONA)
// ============================================================================

function extraerPreciosHojaCategoria(data, nombreHoja, log) {
  const resultado = { filas: [], columnaUsada: null };

  // Buscar la fila con headers. Puede estar en las primeras 15 filas.
  // Los headers esperados tienen palabras como "Fecha", "4ta bza", "4ta balanza", "en pie"
  let headerRowIdx = -1;
  let headers = null;

  for (let i = 0; i < Math.min(15, data.length); i++) {
    const row = data[i];
    if (!row) continue;

    const rowText = row.map(c => (c || '').toString().toLowerCase()).join(' | ');

    // Una fila de headers probablemente tiene "fecha" o "4ta" o "balanza" o "bza"
    if (rowText.includes('4ta') || rowText.includes('balanza') ||
        (rowText.includes('fecha') && rowText.includes('usd'))) {
      headerRowIdx = i;
      headers = row.map(h => (h || '').toString().trim());
      log.push(`  Headers en fila ${i}: ${headers.slice(0, 8).join(' | ')}`);
      break;
    }
  }

  if (headerRowIdx === -1) {
    log.push(`  ⚠ No se encontro fila de headers en "${nombreHoja}"`);
    return resultado;
  }

  // Buscar la columna de 4ta balanza (preferir la que NO sea "Campo")
  let idxColumna = -1;
  let nombreColumna = '';

  // Prioridad 1: "en 4ta bza" o "4ta bza" sin "Campo"
  headers.forEach((h, idx) => {
    const hNorm = h.toLowerCase().replace(/\s+/g, ' ').trim();
    const es4ta = hNorm.includes('4ta') || hNorm.includes('cuarta') || hNorm.includes('4°');
    const tieneBza = hNorm.includes('bza') || hNorm.includes('balanza');
    const esCampo = hNorm.includes('campo');

    if (es4ta && tieneBza && !esCampo && idxColumna === -1) {
      idxColumna = idx;
      nombreColumna = h;
    }
  });

  // Prioridad 2: si no hay una sin "Campo", aceptar con Campo
  if (idxColumna === -1) {
    headers.forEach((h, idx) => {
      const hNorm = h.toLowerCase();
      if ((hNorm.includes('4ta') || hNorm.includes('cuarta')) && (hNorm.includes('bza') || hNorm.includes('balanza'))) {
        if (idxColumna === -1) {
          idxColumna = idx;
          nombreColumna = h;
        }
      }
    });
  }

  if (idxColumna === -1) {
    log.push(`  ⚠ No se encontro columna de 4ta balanza en "${nombreHoja}"`);
    log.push(`  Headers disponibles: ${headers.join(' | ')}`);
    return resultado;
  }

  resultado.columnaUsada = nombreColumna;
  log.push(`  Columna seleccionada: col ${idxColumna} "${nombreColumna}"`);

  // Identificar columna de fecha (generalmente la primera con una fecha valida)
  let idxFecha = -1;
  for (let j = 0; j < Math.min(3, headers.length); j++) {
    // Probar con la primera fila de datos
    for (let i = headerRowIdx + 1; i < Math.min(headerRowIdx + 20, data.length); i++) {
      if (data[i] && data[i][j]) {
        const f = parsearFecha(data[i][j]);
        if (f && f.getFullYear() >= 2000 && f.getFullYear() < 2100) {
          idxFecha = j;
          break;
        }
      }
    }
    if (idxFecha !== -1) break;
  }

  if (idxFecha === -1) {
    log.push(`  ⚠ No se encontro columna de fecha`);
    return resultado;
  }

  log.push(`  Columna de fecha: col ${idxFecha}`);

  // Extraer filas
  for (let i = headerRowIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 2) continue;

    const fecha = parsearFecha(row[idxFecha]);
    if (!fecha) continue;

    const precio = parseFloat(row[idxColumna]);
    if (isNaN(precio) || precio <= 0 || precio > 20) continue;

    resultado.filas.push({
      fecha: fecha.toISOString().split('T')[0],
      precio
    });
  }

  return resultado;
}

function parsearFecha(valor) {
  if (!valor) return null;

  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }

  if (typeof valor === 'string') {
    const m1 = valor.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m1) {
      let [_, d, mes, y] = m1;
      if (y.length === 2) y = '20' + y;
      const fecha = new Date(parseInt(y), parseInt(mes) - 1, parseInt(d));
      if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000) return fecha;
    }

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

  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    const excelEpoch = new Date(1900, 0, 1);
    return new Date(excelEpoch.getTime() + (valor - 2) * 86400000);
  }

  return null;
}
