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

      // Limpiar TODOS los registros INAC previos y los indices calculados
      // (para borrar los datos incorrectos de importaciones previas)
      db.prepare(`DELETE FROM precios_raw WHERE fuente = 'inac'`).run();
      db.prepare(`DELETE FROM indice`).run();
      db.prepare(`DELETE FROM precios_promedio_diario`).run();
      log.push(`Datos previos de INAC eliminados`);

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
// ESTRUCTURA REAL DEL EXCEL INAC (verificada via /admin/debug-excel):
//   Filas 0-8: notas al pie y titulos
//   Filas 9-11: headers multi-linea ("VALORES CONTADO | EN PIE | EN CUARTA BALANZA | ...")
//   Filas 12+: datos con estructura fija:
//     col 0: fecha inicio semana (M/D/YY formato, ej "1/2/26")
//     col 1: fecha fin semana
//     col 2: año
//     col 3: mes
//     col 4: semana del año
//     col 5: EN PIE USD/kg
//     col 9: EN CUARTA BALANZA USD/kg (b) ← lo que queremos
// ============================================================================

// Columnas FIJAS segun estructura Excel INAC
const COL_FECHA_INICIO = 0;
const COL_FECHA_FIN = 1;
const COL_4TA_BALANZA = 9;
const FILA_DATOS_DESDE = 12;  // primera fila con datos reales

function extraerPreciosHojaCategoria(data, nombreHoja, log) {
  const resultado = { filas: [], columnaUsada: `col ${COL_4TA_BALANZA} (EN CUARTA BALANZA USD/kg)` };

  log.push(`  Usando estructura fija INAC: fecha=col ${COL_FECHA_INICIO}, precio 4ta bza=col ${COL_4TA_BALANZA}, desde fila ${FILA_DATOS_DESDE}`);

  let filasSalteadasSinFecha = 0;
  let filasSalteadasSinPrecio = 0;

  for (let i = FILA_DATOS_DESDE; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length < 10) continue;

    // La fecha viene en formato "M/D/YY" (ej "1/2/26", "12/29/25")
    // Tomamos la fecha de FIN de semana (col 1) porque esa es la que INAC reporta
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

/**
 * Parsea fechas del Excel INAC en formato M/D/YY
 * Ejemplos: "1/2/26" → 2026-01-02, "12/29/25" → 2025-12-29
 */
function parsearFechaINAC(valor) {
  if (!valor) return null;

  // Si ya es Date
  if (valor instanceof Date && !isNaN(valor.getTime())) {
    if (valor.getFullYear() > 2000 && valor.getFullYear() < 2100) return valor;
  }

  // Si es string en formato M/D/YY o M/D/YYYY
  if (typeof valor === 'string') {
    const m = valor.trim().match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
    if (m) {
      let [_, mes, dia, anio] = m;
      mes = parseInt(mes);
      dia = parseInt(dia);
      anio = parseInt(anio);

      // Si el año viene en 2 digitos, asumir 20XX (INAC publica desde 2005)
      if (anio < 100) {
        anio = anio < 50 ? 2000 + anio : 1900 + anio;
      }

      if (anio < 2000 || anio > 2100) return null;
      if (mes < 1 || mes > 12) return null;
      if (dia < 1 || dia > 31) return null;

      const fecha = new Date(anio, mes - 1, dia);
      if (!isNaN(fecha.getTime())) return fecha;
    }

    // Tambien probar ISO YYYY-MM-DD
    const m2 = valor.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m2) {
      const fecha = new Date(valor);
      if (!isNaN(fecha.getTime()) && fecha.getFullYear() > 2000) return fecha;
    }
  }

  // Serial date Excel
  if (typeof valor === 'number' && valor > 40000 && valor < 60000) {
    const excelEpoch = new Date(1900, 0, 1);
    const fecha = new Date(excelEpoch.getTime() + (valor - 2) * 86400000);
    if (fecha.getFullYear() > 2000 && fecha.getFullYear() < 2100) return fecha;
  }

  return null;
}
