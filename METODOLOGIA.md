# Metodología del Índice Ganadero Uruguayo (IGU)

**Versión 1.0 · Abril 2026**
**Publicado por ADE / IMPROLUX SAS**

---

## 1. Objetivo

El Índice Ganadero Uruguayo (IGU) mide la evolución del precio de una canasta representativa de categorías de ganado bovino en el mercado uruguayo. Su propósito es servir como:

- Benchmark de referencia para el sector ganadero
- Base para productos financieros derivados (forwards, futuros, bonos indexados)
- Herramienta de análisis para productores, inversores, frigoríficos y entidades financieras

---

## 2. Definición formal

### 2.1 Tipo de índice

El IGU es un índice de **tipo Laspeyres con ponderaciones fijas**, siguiendo la metodología estándar utilizada por institutos de estadística (INE Uruguay para el IPC, INDEC Argentina, IBGE Brasil, BLS USA).

### 2.2 Fórmula de cálculo

```
IGU_t = ( Σ_i [ P_i,t × Q_i,0 × W_i ] ) / ( Σ_i [ P_i,0 × Q_i,0 × W_i ] ) × 100
```

Donde:
- `P_i,t`: precio promedio ponderado de la categoría i en el período t (USD/kg)
- `P_i,0`: precio promedio de la categoría i en el período base (USD/kg)
- `Q_i,0`: cantidad de referencia fija de la categoría i
- `W_i`: ponderación de la categoría i en el índice
- Suma sobre todas las categorías activas

### 2.3 Período base

**Base 100 = Enero 2024** (promedio anual 2024 como referencia de precios base).

---

## 3. Composición de la canasta

### 3.1 Categorías incluidas

| Código | Categoría | Descripción | Ponderación |
|--------|-----------|-------------|-------------|
| NG | Novillo Gordo | Novillo terminado apto frigorífico, 480-520 kg | 40% |
| VG | Vaca Gorda | Vaca terminada apta frigorífico | 20% |
| TE | Ternero | Ternero de destete, 140-180 kg | 20% |
| VQ | Vaquillona | Vaquillona de reposición, 220-280 kg | 10% |
| VI | Vaca de Invernada | Vaca para recría/invernada | 10% |

### 3.2 Criterios de ponderación

Las ponderaciones se derivan de la participación estimada de cada categoría en el mercado ganadero uruguayo, considerando:

- Volumen de faena INAC por categoría (fuente principal)
- Volumen operado en remates (Plaza Rural, Pantalla Uruguay, Lote21)
- Valor económico total (precio × volumen) de cada categoría

Las ponderaciones se **revisan y validan anualmente** por el Comité Técnico del Índice.

### 3.3 Sub-índices

El sistema publica además los siguientes sub-índices:

- **IGU-Carne**: categorías con destino frigorífico (NG + VG, ponderaciones renormalizadas 66.7% / 33.3%)
- **IGU-Reposición**: categorías de reposición/engorde (TE + VQ, ponderaciones 66.7% / 33.3%)
- **IGU-Cría**: categorías de cría (VI, 100%)

---

## 4. Fuentes de precios

### 4.1 Fuentes primarias

| Fuente | Tipo | Frecuencia | Categorías cubiertas |
|--------|------|------------|---------------------|
| Plaza Rural | Remate (TV) | Semanal | NG, VG, TE, VQ, VI |
| Pantalla Uruguay | Remate (TV) | Semanal | NG, VG, TE, VQ, VI |
| ACG | Precios referencia | Diaria | NG, VG |
| INAC | kg carne equivalente | Semanal | NG, VG |

### 4.2 Criterios de selección

Para que una observación sea incluida en el cálculo debe cumplir:

1. **Origen verificable**: fuente pública o acceso documentado
2. **Descripción clara**: categoría identificable sin ambigüedad
3. **Unidad consistente**: precio en USD/kg o convertible a tal
4. **Representatividad**: volumen mínimo de 50 cabezas (en el caso de remates) o metodología clara de formación (en precios de referencia)

### 4.3 Tratamiento de outliers

Se aplica un filtro de 2 desvíos estándar respecto a la mediana semanal por categoría. Observaciones fuera de este rango se revisan manualmente antes de incluirlas o descartarlas.

---

## 5. Procedimiento de cálculo

### 5.1 Flujo diario

1. **Captura de datos** (scraping automático + carga manual complementaria)
2. **Validación**: filtros de outliers, verificación de fuente
3. **Cálculo de promedio ponderado por volumen** por categoría y fecha:

   ```
   P_i,t = Σ(precio_k × volumen_k) / Σ(volumen_k)
   ```

   Donde k recorre todas las observaciones válidas de la categoría i en el día t. Si no hay información de volumen, se usa promedio aritmético simple.

4. **Cálculo del IGU** aplicando la fórmula Laspeyres
5. **Cálculo de variaciones** diaria, mensual (30 días) y anual (365 días)
6. **Persistencia** en base de datos y publicación vía API

### 5.2 Manejo de días sin datos

Si en un día hábil no hay observaciones para una categoría, se aplica imputación por **último valor disponible** (last observation carried forward), marcando el registro como imputado para efectos de auditoría.

En días no hábiles (fines de semana, feriados), no se calcula nuevo valor. Se publica el último valor hábil disponible.

### 5.3 Revisiones

Los valores publicados son **provisorios durante 5 días hábiles**, período durante el cual pueden ajustarse si surgen observaciones tardías o correcciones. Luego del cierre de ese período, el valor se considera **definitivo** y no se modifica.

---

## 6. Gobernanza

### 6.1 Comité Técnico del Índice

Se propone conformar un comité con representación de:

- 1 representante de ADE / IMPROLUX (administrador)
- 1 representante de ACG o ARU
- 1 representante de INAC (observador)
- 1 académico (Facultad de Agronomía o Ciencias Económicas UdelaR)
- 1 representante de sector financiero (banca o corredora)

El comité se reúne trimestralmente y tiene facultades para:

- Validar metodología vigente
- Proponer cambios de ponderaciones (con vigencia a partir del siguiente período anual)
- Resolver controversias sobre inclusión/exclusión de observaciones
- Autorizar cambios de base

### 6.2 Publicación

- **Frecuencia**: diaria (días hábiles), cierre 20:00 hs Uruguay
- **Canal oficial**: API REST pública + dashboard web
- **Formato**: JSON, CSV descargable, gráficos interactivos
- **Histórico**: completo y accesible sin restricciones

### 6.3 Auditoría

- Log completo de observaciones raw (trazabilidad total)
- Código fuente del cálculo disponible para revisión
- Auditoría externa anual de metodología y cálculo

---

## 7. Limitaciones y consideraciones

1. **Sesgo Laspeyres**: la canasta fija no refleja sustituciones entre categorías. Esto es conocido y aceptado en la práctica internacional.
2. **Cobertura regional**: el índice agrega datos nacionales; no refleja diferencias regionales significativas.
3. **Calidad heterogénea**: dentro de cada categoría existe variabilidad (raza, conformación, grasa) no capturada por el promedio.
4. **Período base**: a medida que pasa el tiempo, la base 2024 puede volverse menos representativa. Se prevé **cambio de base cada 5 años**.

---

## 8. Versionado

| Versión | Fecha | Cambios |
|---------|-------|---------|
| 1.0 | Abril 2026 | Versión inicial. 5 categorías, base 2024. |

---

**Contacto**: ADE / IMPROLUX SAS · Uruguay
**Website**: [a definir]
**API**: [a definir]/api
