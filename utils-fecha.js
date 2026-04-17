// utils-fecha.js
// Utilidades de fecha compartidas por los scrapers del IGU
//
// Logica de referencia: el IGU usa "ultimo viernes habil" como fecha comun
// para todas las fuentes. Esto alinea con la publicacion semanal de INAC y
// permite que los precios de Plaza Rural, Pantalla Uruguay e INAC converjan
// en un unico valor semanal del indice.

/**
 * Devuelve el ultimo viernes habil en formato YYYY-MM-DD
 * - Si hoy es viernes: devuelve hoy
 * - Si hoy es sabado o domingo: devuelve el viernes de esta semana
 * - Si hoy es lunes a jueves: devuelve el viernes de la semana pasada
 *
 * @param {Date} [fechaRef=new Date()] Fecha de referencia (default: hoy)
 * @returns {string} Fecha en formato YYYY-MM-DD
 */
function ultimoViernesHabil(fechaRef) {
  const hoy = fechaRef ? new Date(fechaRef) : new Date();
  const dia = hoy.getDay();  // 0=domingo, 1=lunes, ..., 5=viernes, 6=sabado

  let diasARestar;
  if (dia === 5) {
    diasARestar = 0;        // hoy es viernes → hoy
  } else if (dia === 6) {
    diasARestar = 1;        // sabado → viernes anterior (1 dia)
  } else if (dia === 0) {
    diasARestar = 2;        // domingo → viernes anterior (2 dias)
  } else {
    diasARestar = dia + 2;  // lunes(1)→viernes pasado(3), martes(2)→4, etc.
  }

  const viernes = new Date(hoy);
  viernes.setDate(viernes.getDate() - diasARestar);

  return viernes.toISOString().split('T')[0];
}

/**
 * Devuelve el viernes previo a una fecha dada
 * @param {string} fechaStr Fecha en formato YYYY-MM-DD
 * @returns {string} Viernes anterior en formato YYYY-MM-DD
 */
function viernesAnterior(fechaStr) {
  const f = new Date(fechaStr);
  f.setDate(f.getDate() - 7);
  return ultimoViernesHabil(f);
}

/**
 * Devuelve la fecha de referencia correcta para guardar los scrapes de
 * Plaza Rural y Pantalla Uruguay.
 *
 * Logica:
 * - Si INAC ya publico los datos del viernes actual → usar viernes actual
 * - Si INAC todavia no publico → usar el viernes anterior (ultimo con datos INAC)
 *
 * Esto asegura que TE y VI se alineen con la ventana de 14 dias del IGU
 * que se calcula sobre datos INAC disponibles.
 *
 * @param {Database} db Instancia de SQLite
 * @returns {string} Fecha en formato YYYY-MM-DD
 */
function viernesReferenciaParaScrape(db) {
  const viernesActual = ultimoViernesHabil();

  try {
    // Verificar si INAC ya publico datos para el viernes actual
    const tieneINAC = db.prepare(`
      SELECT COUNT(*) as n FROM precios_raw
      WHERE fuente = 'inac' AND fecha = ?
    `).get(viernesActual);

    if (tieneINAC && tieneINAC.n > 0) {
      console.log(`  Fecha referencia: ${viernesActual} (INAC ya publico)`);
      return viernesActual;
    }

    // INAC aun no publico. Buscar el ultimo viernes con datos INAC
    const ultimoINAC = db.prepare(`
      SELECT MAX(fecha) as f FROM precios_raw
      WHERE fuente = 'inac' AND fecha <= ?
    `).get(viernesActual);

    if (ultimoINAC && ultimoINAC.f) {
      console.log(`  Fecha referencia: ${ultimoINAC.f} (INAC aun no publico ${viernesActual})`);
      return ultimoINAC.f;
    }

    // No hay datos INAC en la BD. Usar viernes actual igual
    console.log(`  Fecha referencia: ${viernesActual} (sin datos INAC en BD)`);
    return viernesActual;

  } catch (err) {
    // Si falla la consulta (por ej BD no inicializada), caer a viernes actual
    console.log(`  Fecha referencia: ${viernesActual} (fallback por error: ${err.message})`);
    return viernesActual;
  }
}

/**
 * Devuelve la semana ISO a la que pertenece una fecha en formato "YYYY-WXX"
 * Util para agrupar registros por semana de mercado
 */
function semanaDeFecha(fecha) {
  const d = new Date(fecha);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 3 - (d.getDay() + 6) % 7);
  const week1 = new Date(d.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((d.getTime() - week1.getTime()) / 86400000 - 3 + (week1.getDay() + 6) % 7) / 7);
  return `${d.getFullYear()}-W${weekNum.toString().padStart(2, '0')}`;
}

module.exports = {
  ultimoViernesHabil,
  viernesAnterior,
  viernesReferenciaParaScrape,
  semanaDeFecha
};
