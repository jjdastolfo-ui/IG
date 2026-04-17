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
 * Devuelve la fecha de referencia para guardar los scrapes de pantallas.
 *
 * MODELO DE PUBLICACION LUNES 09:00 UY:
 * El IGU se publica los lunes con datos del viernes anterior (semana cerrada).
 * Para ese momento ya se tiene:
 *   - INAC: datos del miercoles anterior con la semana cerrada el viernes
 *   - Plaza Rural / Pantalla: remates de jueves-viernes disponibles
 *
 * Logica: siempre usar el viernes anterior al dia de ejecucion.
 *   - Si corre lunes 20/4 → fecha ref = viernes 17/4
 *   - Si corre martes 21/4 → fecha ref = viernes 17/4
 *   - Si corre viernes 17/4 (manual, antes de las 09) → fecha ref = viernes 10/4
 *
 * @param {Database} [db] No se usa, se mantiene por compatibilidad con llamadas previas
 * @returns {string} Fecha del viernes anterior en formato YYYY-MM-DD
 */
function viernesReferenciaParaScrape(db) {
  const hoy = new Date();
  const dia = hoy.getDay();

  // Si hoy es viernes, usar el viernes anterior (no hoy)
  // Cualquier otro dia: usar el ultimo viernes (que ya paso)
  let diasARestar;
  if (dia === 5) {
    diasARestar = 7;        // viernes → viernes anterior
  } else if (dia === 6) {
    diasARestar = 1;        // sabado → viernes (ayer)
  } else if (dia === 0) {
    diasARestar = 2;        // domingo → viernes (2 dias atras)
  } else {
    diasARestar = dia + 2;  // lunes(1)→3, martes(2)→4, miercoles(3)→5, jueves(4)→6
  }

  const viernes = new Date(hoy);
  viernes.setDate(viernes.getDate() - diasARestar);

  const fechaStr = viernes.toISOString().split('T')[0];
  console.log(`  Fecha referencia IGU: ${fechaStr} (viernes anterior)`);
  return fechaStr;
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
