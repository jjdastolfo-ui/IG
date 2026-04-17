# IGU v2 — Sistema Anti-Manipulación

Módulos nuevos y modificaciones para el repo `jjdastolfo-ui/ig`.

## 📋 Resumen de cambios

| # | Tipo | Archivo | Descripción |
|---|------|---------|-------------|
| 1 | 🆕 | `migraciones/001-agregar-campos.sql` | Nuevos campos en DB |
| 2 | 🔄 | `scraper-pantalla.js` | Agrega extracción de volumen |
| 3 | 🆕 | `modulos/outlier-detector.js` | Detección de outliers 3σ |
| 4 | 🆕 | `modulos/interpolator.js` | Interpolación por correlación |
| 5 | 🆕 | `modulos/calcular-correlaciones.js` | Matriz de correlaciones |
| 6 | 🆕 | `modulos/alertas.js` | Sistema de alertas por email |
| 7 | 🆕 | `modulos/pipeline-validacion.js` | Orquestador del flujo |
| 8 | 🆕 | `tests/test-outlier-standalone.js` | Tests unitarios |

## 🔧 Instalación

### 1. Copiar archivos al repo

```bash
# Desde el repo jjdastolfo-ui/ig
cp scraper-pantalla.js ./                 # REEMPLAZA el existente
cp -r modulos ./                           # nuevo directorio
cp -r migraciones ./                       # nuevo directorio
cp -r tests ./                             # nuevo directorio
```

### 2. Agregar dependencia

```bash
npm install nodemailer --save
```

### 3. Ejecutar migración de DB

**En Railway (production):**

Entrar por consola a Railway y correr:
```bash
sqlite3 /data/igu.db < migraciones/001-agregar-campos.sql
```

O bien agregar un endpoint admin temporal (ver sección server.js abajo).

**En desarrollo local:**
```bash
sqlite3 ./igu.db < migraciones/001-agregar-campos.sql
```

### 4. Variables de entorno nuevas (Railway → Variables)

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=igu.alertas@gmail.com
SMTP_PASS=<app-password-de-gmail>
SMTP_FROM=IGU Alertas <igu.alertas@gmail.com>
ALERT_TO=jjdastolfo@gmail.com
ALERT_ENABLED=true
```

**Obtener App Password de Gmail:**
https://myaccount.google.com/apppasswords (requiere 2FA activado)

### 5. Calcular correlaciones iniciales (una vez)

```bash
# Local
DB_PATH=./igu.db node modulos/calcular-correlaciones.js

# Railway (via consola)
node modulos/calcular-correlaciones.js
```

Esto pobla la tabla `correlaciones` con la matriz vigente para la interpolación.

## 🧪 Testing

```bash
node --test tests/test-outlier-standalone.js
```

Debería mostrar `# pass 12 / # fail 0`.

## 🔌 Integración con server.js (cambios a aplicar)

En el `server.js` actual, reemplazar la lógica de scrapeo + guardado directo por:

```js
const { scrapearYValidar } = require('./modulos/pipeline-validacion');

// Antes:
// const datos = await scrapePlazaRural(db);
// datos.forEach(d => db.prepare('INSERT ...').run(...));

// Ahora:
await scrapearYValidar(scrapePlazaRural, db, 'plaza_rural');
await scrapearYValidar(scrapePantallaUruguay, db, 'pantalla_uruguay');
await scrapearYValidar(scrapeINAC, db, 'inac');
```

El pipeline se encarga de:
1. Scrapear
2. Validar outliers
3. Interpolar si corresponde
4. Enviar alertas
5. Guardar con flags de transparencia

## 📊 Nuevos endpoints sugeridos para admin

Ver archivo `modulos/admin-endpoints-sugeridos.js` (pendiente de crear junto con vos).

## 🔐 Reglas aplicadas

| Regla | Valor |
|---|---|
| Umbral outlier | 3σ |
| Ventana σ | 26 semanas |
| Volumen bajo | <25% promedio 4 semanas |
| Correlación mínima para interpolar | 0.70 |
| Fuentes sin outlier check | `inac` |
| Carga manual | **NO permitida** |

## 📝 Próximos pasos (pendientes)

1. Adjuntar `server.js` actual para integrar el pipeline sin romper nada
2. Adjuntar `admin-init.js` para sumar endpoints de outliers/alertas
3. Sección "Transparencia" en `public/index.html` con log de decisiones
4. Setup de cron mensual para recalcular correlaciones
5. Alerta "publicación pendiente" los domingos 18:00
