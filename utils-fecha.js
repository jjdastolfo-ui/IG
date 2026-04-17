// utils-fecha.js
// Utilidades de fecha compartidas por los scrapers del IGU

/**
 * Devuelve el último viernes hábil en formato YYYY-MM-DD
 * - Si hoy es viernes: devuelve hoy
 * - Si hoy es sábado o domingo: devuelve el viernes de esta semana
 * - Si hoy es lunes a jueves: devuelve el viernes de la semana pasada
 */
function ultimoViernesHabil(fechaRef) {
  const hoy = fechaRef ? new Date(fechaRef) : new Date();
  const dia = hoy.getDay();

  let diasARestar;
  if (dia === 5) {
    diasARestar = 0;
  } else if (dia === 6) {
    diasARestar = 1;
  } else if (dia === 0) {
    diasARestar = 2;
  } else {
    diasARestar = dia + 2;
  }

  const viernes = new Date(hoy);
  viernes.setDate(viernes.getDate() - diasARestar);

  return viernes.toISOString().split('T')[0];
}

/**
 * Devuelve la semana ISO a la que pertenece una fecha en formato "YYYY-WXX"
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
  semanaDeFecha
};
