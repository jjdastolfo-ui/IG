# IGU · Índice Ganadero Uruguayo

Sistema automático de cálculo, publicación y distribución del **Índice Ganadero Uruguayo (IGU)**.

Metodología Laspeyres · Base 100 = Enero 2024 · 5 categorías · API REST pública

---

## 🏗 Arquitectura

```
┌─────────────────────┐      ┌──────────────────┐      ┌──────────────────┐
│  FUENTES EXTERNAS   │      │   SERVIDOR IGU   │      │   CONSUMIDORES   │
│                     │      │                  │      │                  │
│  Plaza Rural  ─────┐│      │  ┌────────────┐  │      │                  │
│  ACG          ────┐││ ───> │  │  scraper   │  │      │                  │
│  INAC         ───┐│││      │  └─────┬──────┘  │      │  Dashboard Web   │
│  Pantalla Urug.  ││││      │        ▼         │      │  API REST JSON   │
│  Carga manual  ──┘│││      │  ┌────────────┐  │ ───> │  CSV Descargable │
│                   ││└─────>│  │  SQLite DB │  │      │  ETFs/Futuros*   │
│                   │└──────>│  └─────┬──────┘  │      │  Investigadores  │
│                   └───────>│        ▼         │      │                  │
│                            │  ┌────────────┐  │      │                  │
│                            │  │ Calculador │  │      │                  │
│                            │  │  Laspeyres │  │      │                  │
│                            │  └─────┬──────┘  │      │                  │
│                            │        ▼         │      │                  │
│                            │  ┌────────────┐  │      │                  │
│                            │  │ Express API│  │      │                  │
│                            │  └────────────┘  │      │                  │
└────────────────────────────┴──────────────────┴──────┴──────────────────┘

* En etapa futura, cuando el índice tenga track record y adopción
```

## 📦 Stack

- **Backend**: Node.js 18+ · Express
- **Base de datos**: SQLite (better-sqlite3)
- **Scraping**: axios + cheerio
- **Cron**: node-cron
- **Frontend**: HTML + Chart.js (sin framework)
- **Despliegue**: Railway (backend) + GitHub Pages (dashboard estático opcional)

---

## 🚀 Instalación y ejecución local

```bash
# 1. Instalar dependencias
npm install

# 2. Inicializar base de datos
npm run init-db

# 3. Ejecutar servidor
npm start
```

El servidor arranca en `http://localhost:3000`.

### Variables de entorno (.env)

```bash
PORT=3000
DB_PATH=./data/igu.db
NODE_ENV=production
```

---

## 🌐 Despliegue en Railway

1. Crear nuevo proyecto en Railway y conectar al repo GitHub
2. Agregar volumen persistente para SQLite: mount en `/data`
3. Variables de entorno:
   - `DB_PATH=/data/igu.db`
   - `PORT=3000` (Railway lo asigna automáticamente)
4. Inicializar base de datos (ejecutar una sola vez):
   ```bash
   railway run npm run init-db
   ```
5. El servidor estará disponible en la URL que Railway asigne

---

## 📡 API Endpoints

### Consulta del índice

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/indice/actual` | Último valor del IGU publicado |
| GET | `/api/indice/:fecha` | IGU de una fecha específica (YYYY-MM-DD) |
| GET | `/api/indice/historico?desde=&hasta=` | Serie histórica |

### Consulta de categorías y precios

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| GET | `/api/categorias` | Categorías del índice con ponderaciones |
| GET | `/api/precios/:fecha` | Precios promedio ponderados de un día |
| GET | `/api/precios/raw/:fecha` | Todas las observaciones raw del día (auditable) |

### Operaciones

| Método | Endpoint | Descripción |
|--------|----------|-------------|
| POST | `/api/precios` | Cargar observación manual de precio |
| POST | `/api/calcular/:fecha` | Forzar recálculo del índice para una fecha |
| POST | `/api/scrape` | Ejecutar scraping manual de todas las fuentes |
| GET | `/api/stats` | Estadísticas generales del sistema |

### Ejemplo de request POST

```bash
curl -X POST http://localhost:3000/api/precios \
  -H "Content-Type: application/json" \
  -d '{
    "fecha": "2026-04-16",
    "categoria_codigo": "NG",
    "fuente": "plaza_rural",
    "precio": 4.35,
    "volumen": 180,
    "observaciones": "Remate jueves"
  }'
```

### Ejemplo de response de `/api/indice/actual`

```json
{
  "fecha": "2026-04-16",
  "igu_general": 103.47,
  "sub_carne": 105.12,
  "sub_reposicion": 101.88,
  "sub_cria": 99.34,
  "variacion_diaria": 0.23,
  "variacion_mensual": 2.15,
  "variacion_anual": 8.72,
  "metodologia_version": "1.0",
  "calculado_at": "2026-04-16T20:00:15.123Z"
}
```

---

## ⏰ Jobs automáticos

El sistema ejecuta por cron (zona horaria America/Montevideo):

- **19:00 hs lunes a viernes**: scraping automático de todas las fuentes
- **20:00 hs lunes a viernes**: cálculo/recálculo del índice del día

---

## 🛠 Ajustes pendientes antes de producción

Este sistema está listo en arquitectura, pero antes de pasarlo a producción real necesita:

1. **Ajustar selectores CSS del scraper** (`scraper.js`):
   - Los selectores actuales son placeholders. Hay que inspeccionar el HTML real de cada fuente (Plaza Rural, ACG, INAC) y reemplazarlos.
   - Hacer esto con las herramientas de desarrollador del navegador en cada sitio.

2. **Cargar datos históricos base**:
   - Recopilar precios diarios/semanales de 2022-2024 para construir el período base definitivo.
   - Usar el endpoint `/api/precios` en modo bulk o crear un script de importación CSV.

3. **Validar ponderaciones**:
   - Las ponderaciones actuales (40/20/20/10/10) son una propuesta inicial basada en estimación de participación.
   - Cruzar con datos oficiales de faena INAC y volumen de mercado.

4. **Conformar Comité Técnico**:
   - Para dar validez institucional al índice, involucrar a ACG, INAC, ARU o academia.

5. **Documentación legal**:
   - Publicar metodología firmada y versionada (ver METODOLOGIA.md)
   - Considerar registro como índice financiero si se va a vender a bolsa

---

## 💰 Monetización (referencia)

Usos comerciales del índice una vez establecido:

1. **Data feeds** a suscriptores (frigoríficos, bancos, invernadores grandes): USD 20-100k/año
2. **Licenciamiento a bolsa** (BVM, Matba-Rofex) para contratos de futuros
3. **Productos propietarios** (ADE/IMPROLUX): forwards OTC, asesoramiento de hedging usando el IGU como benchmark
4. **Seguros paramétricos** con reaseguradora internacional (Swiss Re, Munich Re)
5. **White label**: licenciar el sistema a otros países del Mercosur

---

## 📁 Estructura del proyecto

```
indice-ganadero/
├── server.js              # Servidor Express + API + cron
├── scraper.js             # Módulo de scraping de fuentes
├── init-db.js             # Inicialización de schema SQLite
├── package.json
├── METODOLOGIA.md         # Documento metodológico oficial
├── README.md              # Este archivo
├── data/
│   └── igu.db             # Base de datos SQLite (creada al init)
└── public/
    └── index.html         # Dashboard web
```

---

## 📄 Licencia

Propiedad de ADE / IMPROLUX SAS · Uruguay · 2026

Todos los derechos reservados. El uso comercial de los datos del índice
requiere licencia.
