# MIS CUENTAS — Sistema de Gestión Financiera Personal Permanente

Aplicación financiera personal diseñada para uso indefinido en PC y celular, con **una sola fuente de verdad**, aritmética monetaria exacta en céntimos enteros, zona horaria `America/Lima` y moneda principal `PEN (S/)`.

---

## Fases Implementadas

### Fase 1: Núcleo Financiero Responsive, Persistencia Real e Intercambio CSV/JSON
- **Experiencia Responsive Diferenciada (`apps/web`):**
  - **PC (`>= 1024px`):** Sidebar lateral fija y colapsable (`pc-sidebar`) + Dashboard en **cuadrícula de tres columnas** (`dashboard-grid-3col`).
  - **Celular (`< 1024px`, diseño mobile-first propio):** Cabecera compacta con selector de mes, navegación inferior (`mobile-bottom-nav`), botón flotante `+` (`fab-registrar`) y hoja modal inferior con teclado numérico (`inputMode="decimal"`) y selectores de un toque para registrar un movimiento en menos de 5 segundos.
- **Módulo de Transacciones y Reglas Contables ([`packages/core/src/libro.ts`](./packages/core/src/libro.ts)):**
  - Operaciones de **Ingreso**, **Egreso (`GASTO`)**, **Transferencia entre cuentas** (con detección de **pago de tarjeta de crédito** para evitar doble contabilización) y **Saldo inicial real** por cuenta.
  - Si una cuenta carece de saldo inicial real, no inventa ni asume un saldo bancario (`saldoBancarioRealCentimos: null`, estado `SIN_SALDO_INICIAL`).
  - Diferenciación entre fecha del movimiento (`fechaMovimiento` + `horaMovimiento` en `America/Lima`) y fecha de registro (`registradoEn` UTC ISO-8601).
- **Importación y Exportación Transaccional CSV y JSON ([`packages/core/src/intercambio.ts`](./packages/core/src/intercambio.ts)):**
  - Validación de estructura y tipos, previsualización, detección de duplicados por ID y por huella contable, y confirmación obligatoria antes de sobrescribir.

### Fase 2: Sistema Universal de Eventos, Presupuestos, Control Diario, Gastos Compartidos y Recurrencia
- **Gestión Universal de Eventos y Presupuestos por Evento ([`packages/core/src/eventos.ts`](./packages/core/src/eventos.ts)):**
  - Creación de eventos ilimitados de cualquier duración (`VIAJE`, `CELEBRACION`, `COMPRA_IMPORTANTE`, `PROYECTO`, `ACTIVIDAD_PERSONAL` o tipo personalizado) con estados `PLANIFICADO`, `ACTIVO`, `FINALIZADO` y `CANCELADO`.
  - Plantilla inicial editable para viajes (*Pasajes y transporte*, *Alojamiento*, *Alimentación*, *Compras y frontera*, *Imprevistos*) y gestión libre de partidas presupuestarias.
  - Cálculo derivado desde las transacciones reales vinculadas por `eventoId` (`event_id`) sin duplicar transacciones: Presupuesto total, Presupuesto asignado, Gasto real, Dinero comprometido, Saldo disponible, Porcentaje consumido y Exceso presupuestario.
  - **Control Diario automático (`calcularControlDiarioEvento`):**
    - $\text{Presupuesto diario recomendado} = \text{Saldo presupuestario disponible} / \text{días calendario restantes}$.
    - $\text{Burn Rate diario} = \text{Gasto real acumulado} / \text{días transcurridos}$.
    - Considera eventos no iniciados, eventos en curso y eventos finalizados, actualizándose en cada alta, edición o baja de transacción.
  - **Planificación sin doble conteo (`GastoPlanificadoEvento`):** diferencia entre `PLANIFICADO`, `COMPROMETIDO` y `REGISTRADO`, y convierte un gasto planificado en transacción real única (`convertirGastoPlanificadoEnMovimientoReal`).
- **Gastos Compartidos y Liquidaciones ([`packages/core/src/compartidos.ts`](./packages/core/src/compartidos.ts)):**
  - División equitativa o por porcentaje/importe entre participantes, pagos parciales y liquidaciones completas.
  - Calcula automáticamente quién debe a quién y separa: (1) *Dinero que salió de mi bolsillo*, (2) *Parte del gasto que realmente me corresponde*, (3) *Dinero que otras personas me deben* (sin contabilizarlo como ingreso real antes de cobrarlo) y (4) *Dinero que debo a otras personas*.
- **Reglas de Recurrencia y Calendario ([`packages/core/src/recurrencia_calendario.ts`](./packages/core/src/recurrencia_calendario.ts)):**
  - Frecuencias `SEMANAL`, `MENSUAL`, `ANUAL` y `PERSONALIZADA_DIAS`. Toda regla recurrente es una previsión (`PROYECTADO`) y nunca registra un gasto real sin autorización explícita (`autorizarOcurrenciaRecurrente`).
  - Agenda unificada (`construirAgendaCalendario`) para próximos viajes, eventos personales, gastos importantes, fechas de pago y compromisos presupuestarios.

### Fase 3: Analítica Financiera Avanzada (Apache ECharts)
- **Integración de Apache ECharts (`echarts@^6.1.0`) y Pestaña "Analítica Avanzada" ([`packages/core/src/analitica.ts`](./packages/core/src/analitica.ts), [`apps/web/src/componentes/PanelAnaliticaAvanzada.tsx`](./apps/web/src/componentes/PanelAnaliticaAvanzada.tsx)):**
  - **1. Waterfall Chart (`calcularWaterfallFlujo`):** Descompone $\text{Ingresos} - \text{Gastos fijos} - \text{Gastos variables} - \text{Gastos asociados a eventos} = \text{Flujo neto}$ con categorías **mutuamente excluyentes** (un gasto vinculado a un evento jamás se vuelve a sumar como variable ni fijo).
  - **2. Heatmap Temporal 24×7 (`calcularHeatmapTemporal`):** Eje X de 24 horas (`00..23`) y Eje Y de 7 días (`Lunes..Domingo`) usando los timestamps reales en `America/Lima`, con selector entre *Frecuencia de operaciones*, *Importe gastado* e *Importe promedio por operación*.
  - **3. Curva de Liquidez y Desviación (`calcularCurvaLiquidezYDesviacion`):** Visualización diaria de flujo acumulado real, gasto diario, gasto acumulado real $S(t)$, gasto acumulado esperado $E[S(t)] = t \times \mu$ y bandas descriptivas $\pm 1\sigma$ y $\pm 2\sigma$ con $\sigma_{\text{acum}}(t) = \sigma \times \sqrt{t}$ (indicando explícitamente que son bandas descriptivas bajo el supuesto de independencia diaria y no intervalos de confianza garantizados; sin mostrar saldo bancario real cuando falta saldo inicial ni calcular bandas con historial insuficiente).
  - **4. Pareto 80/20 (`calcularParetoCategorias`):** Ordena categorías por gasto real descendente, muestra importe, porcentaje individual, porcentaje acumulado, línea de referencia del 80 % y núcleo vital de gasto.
  - **5. Filtros Globales y Drill-Down:** Filtros por periodo (`MES`, `AÑO`, `RANGO`, `TODO`), mes, año, categoría, cuenta, tipo de operación, evento y etiquetas, con navegación directa a las transacciones que componen cualquier barra o celda seleccionada.

### Fase 4: Motor Estadístico de Predicciones y Riesgo Financiero
- **Motor Estadístico Centralizado y Reutilizable (`packages/core/src/predicciones/`):**
  - **[`preparacion.ts`](./packages/core/src/predicciones/preparacion.ts):** Construcción cronológica de series diarias reales (`construirSerieTemporalDiaria`) y diagnóstico de calidad de datos (`DiagnosticoCalidadSerie`: días observados, días activos, proporción de ceros, autocorrelaciones $\rho_1$ y $\rho_7$).
  - **[`estimacion.ts`](./packages/core/src/predicciones/estimacion.ts):** Cuatro modelos matemáticamente diferenciados:
    1. **MCO (`ajustarMCO`):** Regresión lineal temporal $y_t = \beta_0 + \beta_1 t + \varepsilon_t$.
    2. **SES (`ajustarSES`):** Suavizamiento Exponencial Simple de nivel $\ell_t = \alpha y_t + (1-\alpha)\ell_{t-1}$ con pronóstico plano $\hat{y}_{n+h|n} = \ell_n$.
    3. **Método de Holt (`ajustarHolt`):** Suavizamiento Exponencial Doble con nivel $\ell_t$ y pendiente lineal $b_t$, pronóstico $\hat{y}_{n+h|n} = \ell_n + h \cdot b_n$.
    4. **Holt-Winters Aditivo (`ajustarHoltWintersAditivo`):** Nivel $\ell_t$, tendencia $b_t$ y estacionalidad semanal aditiva ($m = 7$), habilitado únicamente cuando existen al menos 2 ciclos completos de entrenamiento ($n_{\text{train}} \ge 14$ y $N \ge 21$ días).
  - **[`backtesting.ts`](./packages/core/src/predicciones/backtesting.ts):** Validación temporal fuera de muestra (*walk-forward* / ventana expansiva cronológica estricta sin mezclar pasado y futuro). Evalúa RMSE, MAE, Sesgo medio y sMAPE fuera de muestra, selecciona el mejor método y lo reentrena sobre toda la serie observada.
  - **[`incertidumbre.ts`](./packages/core/src/predicciones/incertidumbre.ts):** Diferenciación explícita entre el **Intervalo de Confianza del 95 % de la Media Esperada** y el **Intervalo de Predicción del 95 % de la Observación Futura**, junto con diagnóstico de distribución de residuos (sesgo, varianza $\hat{\sigma}^2_\varepsilon$, asimetría, curtosis y cambios recientes de comportamiento).
  - **[`montecarlo.ts`](./packages/core/src/predicciones/montecarlo.ts):** Simulación de **1,000 iteraciones** mediante **Bootstrap por Bloques Móviles** (`BOOTSTRAP_BLOQUES_MOVILES`) o **Bootstrap Empírico IID** (`BOOTSTRAP_EMPIRICO`) exclusivamente sobre observaciones reales, sin asumir normalidad ni inventar distribuciones. Calcula probabilidad de superar el presupuesto mensual o de un evento, escenarios favorable ($P_{10}$), central ($P_{50}$ / media) y desfavorable ($P_{90}$), e informa `"Historial insuficiente"` cuando no existen datos suficientes.
  - **[`anomalias.ts`](./packages/core/src/predicciones/anomalias.ts):** Detector automático de gastos atípicos mediante **Z-score clásico** y **Z-score robusto (Mediana y MAD escalado por $0.6745$)** con umbral configurable ($Z > 2.0$), comparación por categoría cuando $n_{\text{cat}} \ge 5$, y distinción explícita entre alerta estadística y fraude.
  - **[`proyecciones.ts`](./packages/core/src/predicciones/proyecciones.ts) y [`cache.ts`](./packages/core/src/predicciones/cache.ts):** Proyecciones de fin de mes (`proyectarFinDeMes`) y fin de cada evento (`proyectarFinDeEvento`), respaldadas por `CachePrediccionesFinancieras` con invalidación por huella FNV-1a cuando cambian las transacciones o presupuestos.
- **Pestaña `"Predicciones y Riesgo Financiero"` ([`PanelPrediccionesYRiesgo.tsx`](./apps/web/src/componentes/PanelPrediccionesYRiesgo.tsx)):** Dashboard completo de riesgo e incertidumbre en PC y móvil.

### Fase 5: Sincronización Multidispositivo, Seguridad Criptográfica y Conversión Completa a PWA
- **Esquema PostgreSQL, Supabase Auth y Row Level Security (RLS) ([`supabase/migrations/20260401000001_esquema_rls_multidispositivo.sql`](./supabase/migrations/20260401000001_esquema_rls_multidispositivo.sql)):**
  - Sincronización de las 9 tablas del sistema (`cuentas`, `categorias`, `movimientos`, `eventos`, `gastos_planificados`, `gastos_compartidos`, `reglas_recurrentes`, `auditoria`, `cola_sincronizacion_remota`) con `UUID` estable, `created_at`, `updated_at`, `version`, `estado_sincronizacion`, `propietario_id` y borrado lógico (`eliminado_en`).
  - Políticas de autorización privada (`auth.uid() = propietario_id`) en todas las tablas (`SELECT`, `INSERT`, `UPDATE`, `DELETE`) y revocación explícita de permisos al rol `anon` (sin acceso público).
- **Seguridad de Credenciales ([`.env.example`](./.env.example), [`seguridad_credenciales.ts`](./packages/core/src/sincronizacion/seguridad_credenciales.ts)):**
  - Detector estricto de claves secretas (`service_role`, `sb_secret_`, JWT con rol administrativo) que bloquea su uso en el navegador y prohíbe almacenar credenciales secretas en `localStorage`, consola o logs.
- **Motor de Sincronización Multidispositivo y Funcionamiento Offline ([`motor_sincronizacion.ts`](./packages/core/src/sincronizacion/motor_sincronizacion.ts), [`cliente_supabase.ts`](./apps/web/src/persistencia/cliente_supabase.ts), [`indexeddb.ts`](./apps/web/src/persistencia/indexeddb.ts)):**
  - Sincronización bidireccional PC ↔ Nube ↔ Celular con cola local persistente de operaciones pendientes (`ALMACENES.COLA_SINCRONIZACION`), reintentos con backoff exponencial, operaciones idempotentes y deduplicación por `id` e `idempotenciaClave`.
  - Detección y resolución segura de conflictos (`ConflictoSincronizacion` por modificaciones simultáneas o colisión edición vs. eliminación lógica) sin sobrescribir silenciosamente información crítica (`CONSERVAR_LOCAL`, `ACEPTAR_REMOTO`).
  - Recuperación automática al reconectar internet (`window.online`) sin duplicar transacciones.
- **Conversión Completa a PWA y Estrategia de Caché Segura ([`manifest.json`](./apps/web/public/manifest.json), [`sw.js`](./apps/web/public/sw.js), [`estrategia_cache_pwa.ts`](./packages/core/src/sincronizacion/estrategia_cache_pwa.ts)):**
  - Instalable en PC y celular (`display: standalone`, iconos SVG `192x192` y `512x512`, `theme-color`, metadatos iOS, prompt de instalación y aviso de actualización de versión).
  - El Service Worker almacena en caché **únicamente** recursos estáticos del App Shell; jamás cachea datos financieros personales ni respuestas privadas de Supabase Auth/PostgREST.
- **Transferencia Manual Segura, Respaldo Cifrado, QR Corto y Bloqueo Local ([`cifrado_y_qr.ts`](./packages/core/src/sincronizacion/cifrado_y_qr.ts), [`PanelSincronizacionYPwa.tsx`](./apps/web/src/componentes/PanelSincronizacionYPwa.tsx), [`PantallaBloqueoApp.tsx`](./apps/web/src/componentes/PantallaBloqueoApp.tsx)):**
  - Exportación e importación manual en CSV, JSON y **JSON cifrado con contraseña** mediante Web Crypto API (`PBKDF2-HMAC-SHA256` con 210,000 iteraciones + `AES-256-GCM` autenticado con sal e IV aleatorios).
  - Paquetes **QR cortos y cifrados** (emparejamiento de sesión o hasta 5 movimientos recientes, máximo 1,800 bytes), bloqueando explícitamente volcar toda la base de datos en un QR gigante.
  - Pantalla de bloqueo local con PIN/contraseña verificada por `PBKDF2-SHA256`, bloqueo por inactividad y cierre seguro de sesión.

---

## Arquitectura 100 % Independiente de la PC (Vercel + Supabase Cloud + IndexedDB)

La aplicación en producción **no depende de `localhost`, de una IP de tu red doméstica ni de ningún proceso ejecutándose en tu computadora**. Durante tus viajes, tu PC puede permanecer completamente apagada:

1. **Base de Datos Cloud en Supabase:**
   - Crea tu proyecto en Supabase (`https://<tu-proyecto>.supabase.co`).
   - Ejecuta el script idempotente [`supabase/migrations/20260401000001_esquema_rls_multidispositivo.sql`](./supabase/migrations/20260401000001_esquema_rls_multidispositivo.sql) en el *SQL Editor* de Supabase.
   - Crea tu usuario único de propietario en *Authentication → Users* (desactivando el registro público).
2. **Alojamiento Frontend en Vercel ([`vercel.json`](./vercel.json)):**
   - Importa el repositorio en Vercel (detecta automáticamente `buildCommand: "npm run build:web"` y `outputDirectory: "apps/web/dist"` desde [`vercel.json`](./vercel.json)).
   - Configura en Vercel las 3 variables de entorno públicas (respaldadas por RLS):
     - `VITE_SUPABASE_URL=https://<tu-proyecto>.supabase.co`
     - `VITE_SUPABASE_PUBLISHABLE_KEY=<tu-anon-o-publishable-key>`
     - `VITE_PROPIETARIO_EMAIL_AUTORIZADO=<tu-correo-personal>`
3. **Protocolo de Prueba en Celular con la PC Apagada (Internet Móvil 4G/5G + Modo Avión):**
   - Abre la URL de Vercel en tu celular, inicia sesión en la pestaña **Sync/PWA** e instala la PWA (*Añadir a pantalla de inicio*).
   - **Apaga completamente tu PC** y desconecta el Wi-Fi del celular (usando únicamente datos móviles).
   - Activa el **Modo Avión** en el celular, registra movimientos de prueba, **cierra la aplicación y reinicia el celular**.
   - Abre la PWA aún sin internet: verifica que los movimientos y el contador de pendientes (`IndexedDB`) permanecen intactos.
   - Desactiva el Modo Avión para reconectar a **Internet móvil**: verifica que el indicador superior cambia automáticamente a `↻ Sincronizando con Supabase Cloud...` y luego a `0 pend.` sin duplicados.

---

## Comandos principales (Desarrollo y Administración en PC)

```powershell
# 1. Verificación de tipos (TypeScript) y suite completa de pruebas (Vitest)
npm run check

# 2. Levantar la aplicación web/móvil en modo desarrollo (http://localhost:5173)
npm run dev

# 3. Compilar la aplicación web/móvil para producción
npm run build:web

# 4. Comandos del servidor SQLite y backups (apps/server)
npm run inicializar
npm run verificar
npm run backup
npm run exportar
```
