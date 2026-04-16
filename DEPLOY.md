# 🚀 Guía de Deploy · IGU

Pasos concretos para poner el sistema en producción desde cero.

---

## Prerequisitos

- Cuenta en GitHub (tenés: `jjdastolfo-ui`)
- Cuenta en Railway (la misma que usás para IMPROLUX)
- Node.js 18+ instalado localmente (opcional, solo si querés probar local)
- Railway CLI (opcional pero recomendado)

---

## 1️⃣ Crear repo en GitHub

```bash
# En GitHub, crear nuevo repo: indice-ganadero-uy
# Luego en tu computadora:

mkdir indice-ganadero-uy
cd indice-ganadero-uy

# Copiá todos los archivos del proyecto acá

git init
git add .
git commit -m "Initial commit: IGU v1.0"
git branch -M main
git remote add origin https://github.com/jjdastolfo-ui/indice-ganadero-uy.git
git push -u origin main
```

---

## 2️⃣ Nuevo proyecto en Railway

1. Ir a [railway.app](https://railway.app/new)
2. **Deploy from GitHub repo** → seleccionar `indice-ganadero-uy`
3. Railway detecta Node.js y arranca build automáticamente
4. Esperá que termine (1-2 min)

---

## 3️⃣ Agregar volumen persistente

**IMPORTANTE**: Sin esto, cada deploy borra la base de datos.

1. En el proyecto Railway → click en el servicio
2. **Settings** → **Volumes** → **+ New Volume**
3. Mount path: `/data`
4. Size: `1 GB`
5. Guardar

---

## 4️⃣ Variables de entorno

En **Variables** agregá:

| Variable | Valor |
|----------|-------|
| `DB_PATH` | `/data/igu.db` |
| `NODE_ENV` | `production` |
| `TZ` | `America/Montevideo` |

Railway aplica redeploy automático.

---

## 5️⃣ Generar dominio público

1. **Settings** → **Networking** → **Generate Domain**
2. Railway te da algo como: `indice-ganadero-uy-production.up.railway.app`
3. Guardá esta URL, la vas a usar varias veces

---

## 6️⃣ Inicializar base de datos

### Opción A: Railway CLI (recomendado)

```bash
# Instalar CLI (una sola vez)
npm install -g @railway/cli

# Login
railway login

# En tu carpeta local del proyecto:
railway link
# Seleccionar el proyecto indice-ganadero-uy

# Ejecutar init-db en el entorno remoto con acceso al volumen
railway run npm run init-db
```

Deberías ver:
```
✓ Base de datos IGU inicializada correctamente
✓ 5 categorías creadas
✓ 5 precios base cargados
✓ Path: /data/igu.db
```

### Opción B: Railway Shell (alternativa web)

1. En Railway → tu servicio → **Shell** (ícono terminal)
2. Ejecutar: `npm run init-db`
3. Mismo output esperado

---

## 7️⃣ Verificar deploy

Abrí estas URLs (reemplazando con tu dominio):

### Health check
```
https://tu-dominio.up.railway.app/health
```
Debe devolver: `{"status":"ok","service":"IGU API",...}`

### Dashboard
```
https://tu-dominio.up.railway.app/
```
Debe mostrar el dashboard con valores en `---` (sin datos aún).

### API categorías
```
https://tu-dominio.up.railway.app/api/categorias
```
Debe devolver las 5 categorías con sus ponderaciones.

---

## 8️⃣ Primera carga de datos de prueba

### Vía curl (terminal)

```bash
URL=https://tu-dominio.up.railway.app/api/precios
FECHA=$(date +%Y-%m-%d)

# Novillo Gordo
curl -X POST $URL -H "Content-Type: application/json" \
  -d "{\"fecha\":\"$FECHA\",\"categoria_codigo\":\"NG\",\"fuente\":\"manual\",\"precio\":4.35,\"volumen\":180}"

# Vaca Gorda
curl -X POST $URL -H "Content-Type: application/json" \
  -d "{\"fecha\":\"$FECHA\",\"categoria_codigo\":\"VG\",\"fuente\":\"manual\",\"precio\":3.62,\"volumen\":90}"

# Ternero
curl -X POST $URL -H "Content-Type: application/json" \
  -d "{\"fecha\":\"$FECHA\",\"categoria_codigo\":\"TE\",\"fuente\":\"manual\",\"precio\":4.08,\"volumen\":350}"

# Vaquillona
curl -X POST $URL -H "Content-Type: application/json" \
  -d "{\"fecha\":\"$FECHA\",\"categoria_codigo\":\"VQ\",\"fuente\":\"manual\",\"precio\":3.40,\"volumen\":120}"

# Vaca Invernada
curl -X POST $URL -H "Content-Type: application/json" \
  -d "{\"fecha\":\"$FECHA\",\"categoria_codigo\":\"VI\",\"fuente\":\"manual\",\"precio\":2.95,\"volumen\":80}"
```

### Vía dashboard

Ir a la URL principal, scrollear hasta "CARGA MANUAL DE PRECIO" y completar el formulario 5 veces (una por categoría).

Después de cargar las 5 categorías, el dashboard muestra el IGU calculado con variaciones, gráfico, etc.

---

## 9️⃣ (Opcional) Dashboard en GitHub Pages

Si preferís separar frontend de backend (como con IMPROLUX):

1. Crear repo nuevo: `igu-ui`
2. Copiar `public/index.html` ahí
3. Editar la línea del API_BASE:
   ```javascript
   const API_BASE = 'https://tu-dominio.up.railway.app/api';
   ```
4. En el repo `igu-ui` → Settings → Pages → Source: `main` branch, folder: `/ (root)`
5. Te queda en: `https://jjdastolfo-ui.github.io/igu-ui/`

**NOTA**: Si hacés esto, tenés que habilitar CORS en el backend. El código ya lo tiene (`app.use(cors())`), así que funciona directo.

---

## 🔟 Siguiente paso: scraping automático

Los scrapers están armados pero con selectores placeholder. Para activarlos:

1. Abrir Plaza Rural, ACG, INAC en el navegador
2. F12 → Inspeccionar el HTML donde están los precios
3. Editar `scraper.js` reemplazando los selectores CSS placeholder con los reales
4. Commit + push → Railway redeploy automático
5. Probar manualmente: `POST /api/scrape`

Los cron jobs ya están configurados para correr a las 19:00 hs (scraping) y 20:00 hs (recálculo) hora Uruguay, solo hay que tener los selectores bien.

---

## 🐛 Troubleshooting

### "Cannot find module 'better-sqlite3'"
→ Railway no instaló dependencias. En Settings → Service, verificar que **Build Command** sea `npm install` (debería ser automático).

### Los datos se borran después de cada deploy
→ Te faltó el volumen persistente. Ver paso 3.

### "No such table: categorias"
→ Te faltó ejecutar `npm run init-db`. Ver paso 6.

### Error 404 en /api/indice/actual
→ Normal si todavía no cargaste ningún precio. Es esperado en el primer momento.

### Los cron jobs no corren
→ Verificar que `TZ=America/Montevideo` esté seteado. Los cron son en ese timezone.

---

## 📊 Monitoreo en producción

Railway → Servicio → **Observability**:
- Ver logs en tiempo real
- CPU/RAM usage
- Request count

Para consultar directamente la base de datos:

```bash
# Conectarse al shell del container
railway shell

# Una vez dentro:
sqlite3 /data/igu.db
> .tables
> SELECT * FROM indice ORDER BY fecha DESC LIMIT 10;
> SELECT COUNT(*) FROM precios_raw;
> .exit
```

---

## 💾 Backup de la base de datos

Una vez que tengas datos importantes cargados, configurá backups periódicos:

```bash
# Descargar la BD local (ocasionalmente)
railway run cat /data/igu.db > backup_igu_$(date +%Y%m%d).db
```

O agregar un endpoint `/api/admin/backup` que devuelva el archivo (con autenticación).

---

**Todo listo**. Una vez que funcione el deploy inicial, avísame y seguimos con el próximo paso: ajustar los scrapers contra un sitio real o cargar el histórico.
