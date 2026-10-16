# WS Sismo Detector

Servidor Node.js que se conecta a las estaciones sísmicas oficiales de **EarthScope** (IRIS) vía **SeedLink WebSocket** en tiempo real, detecta sismos y envía alertas a los clientes conectados.

## Arquitectura

```
EarthScope SeedLink (wss://rtserve.earthscope.org/seedlink)
    |
    v
[Pool de estaciones] (stationPool.js)
  - Carga dinámica de estaciones desde IRIS FDSN
  - Conexión reutilizable (pool)
  - Hasta 40 estaciones, monitoreadas aunque no haya usuarios
  - Tres conexiones SeedLink multiestación compartidas
  - Un detector sísmico por estación
    |
    v
[Servidor Node.js] (index.js)
  - WebSocket server para clientes
  - Detección STA/LTA + máquina de estados P/S
  - Broadcast de waveform y alertas en tiempo real
    |
    v
[App móvil]
  - Suscripción con ubicación
  - Recibe alertas instantáneas
  - Recibe waveform en tiempo real
```

## Reglas del pool de estaciones

- El catálogo es independiente del monitoreo: como máximo 40 estaciones seleccionadas.
- Solo canales verticales BHZ/HHZ con calibración en m/s y datos menores de 60 segundos.
- Selección geográfica: primer punto cerca de Panamá, luego cubrir los mayores huecos;
  cada punto incorpora hasta dos estaciones vecinas (20–500 km), si existen.
- El criterio es una heurística de cobertura, no una red mundial de alerta temprana validada.
- Se revisa disponibilidad cada 15 minutos. Si hay menos de 40 elegibles se informa el déficit.
- Tres conexiones multiestación con reconexión y vigilancia de datos; los usuarios no abren ni cierran conexiones.
- Las suscripciones WS solo eligen señales para visualizar entre las estaciones ya seleccionadas.
- Un detector sísmico por estación (no por usuario)

`/status` y `/health` muestran `pool.stationLimit`, `selectedStations`, `connectedStations`,
`feeds` y la lista seleccionada con coordenadas, antigüedad y contadores de paquetes.
`connectedStations` cuenta señales recientes recibidas, no solamente handshakes aceptados.
`firebase.initialized` indica SDK inicializado; solo `lastPublishedAt` confirma una escritura.
El límite se redujo de 300 a 40 para disminuir el procesamiento del servidor, a costa de
menor cobertura. Se mantienen tres estaciones compatibles para confirmar un evento.
La detección/localización sigue siendo experimental: no garantiza cobertura mundial
ni latencia de milisegundos. No se suben señales crudas a Firestore.

Pruebas sin Firebase ni notificaciones: `node --test tests/globalMonitor.test.js`.
Pruebas de equivalencia y microbenchmark RMS: `node --test tests/rollingRms.test.js`.
El detector usa ventanas circulares de memoria fija y sumas de cuadrados acumuladas
(con recálculo periódico para limitar el error numérico), en lugar de recorrer toda
la ventana por muestra. Los gráficos WS solo se preparan si hay suscriptores y se
serializan una vez por paquete. Esto no cambia los umbrales de detección; el
microbenchmark no mide el consumo total ni garantiza rendimiento en producción.
Prueba real de 3 minutos sin publicar alertas: `node scripts/check-global-monitor.mjs`.

## Requisitos

### Magnitud experimental de onda P

Implementación opcional: `P_WAVE_MAGNITUDE_ENABLED=true`. Por defecto está
desactivada: se guarda `magnitude: null`, nunca la ML defectuosa anterior. `/status` expone
`magnitudeMode`. No activar para alertas públicas antes de validar con registros
históricos, magnitudes de catálogo y pruebas de entrega.

El nuevo camino conserva 60 segundos de counts crudos por estación en un buffer
circular. Tras confirmar un evento recoge 30 segundos previos a P, los primeros
4 segundos de P y 10 segundos de margen posterior. Rechaza huecos y cambios de canal.
ObsPy/evalresp obtiene StationXML `level=response` para el NSLC y época completos,
elimina la respuesta instrumental de todas sus etapas y devuelve desplazamiento
en metros. Después aplica un pasa-bajos causal de dos polos a 3 Hz, mide Pd en la
ventana P y convierte a cm. Nunca aplica el factor 2800 ni convierte una muestra
de velocidad en magnitud. No utiliza el filtro 1–10 Hz del detector para medir Pd.

La eliminación de respuesta usa prefiltrado 0.05/0.1/8/10 Hz (esquinas altas
ajustadas a Nyquist), taper 5% y `water_level=60` dB para no invertir ceros de respuesta.
El water level puede atenuar frecuencias válidas: evaluar esa sensibilidad con
instrumentos reales. Son decisiones de implementación
que requieren validación, no una reproducción certificada de EPIC. Los datos de
relleno posteriores introducen latencia; este modo no promete alerta temprana.
Se espera hasta 20 s por ventanas y hasta 45 s por el proceso externo. Solo un
evento puede usar el worker a la vez, máximo 8 estaciones y un hilo BLAS; los demás
se conservan con magnitud desconocida, sin cola ilimitada. La detección continúa.

Usa la ecuación 2 de [Kuyuk y Allen, 2013](https://seismo.berkeley.edu/~rallen/pub/2013kuyuk2/KuyukAllen-GlobalEEWMagRelation-GRL-2013.pdf):
`M = 1.23 log10(Pd_cm) + 1.38 log10(distancia_epicentral_km) + 5.39`.
Combina con mediana al menos tres estaciones únicas, hasta 250 km; rechaza ventanas
con llegada S estimada dentro de esos 4 segundos según el modelo simple local.
No sustituye una medición real de S: puede quedar contaminación sin detectar.

La preparación instrumental completa requiere validación con datos reales; no reproduce EPIC.
La incertidumbre del estudio no se atribuye a este servidor. No hay garantía de
cobertura con 40 estaciones ni de exactitud para eventos grandes (posible saturación).
Si faltan estaciones válidas, falla Python o falta la respuesta, guarda el evento
con magnitud desconocida y `magnitudeReason`; nunca recurre a ML.
La profundidad continúa desconocida (`null`), no se estima mediante esta ecuación.

Los eventos llevan `magnitudeType: M_Pd`, `preliminaryMagnitude: true`,
`magnitudeStatus: experimental`, método y `magnitudeUncertainty: null`.
La función incluye la etiqueta preliminar en el push; para aplicarla es necesario
desplegar también `functions:notifyNearbyUsers`. Para magnitud desconocida el push
omite el campo numérico (no cadena vacía ni cero) y muestra «magnitud no determinada».
La función no envía eventos marcados como simulación. Los registros históricos
no se reescriben; no se pueden recalcular a partir de sus amplitudes puntuales.
La app debe aceptar valores desconocidos: no usar `Number(null)`, `Number('')`
ni `magnitude ?? 0`. Versiones antiguas requieren actualizarse.
Pruebas: `node --test tests/pWaveMagnitude.test.js tests/globalMonitor.test.js tests/rollingRms.test.js`.

Instalación local opcional del worker (PowerShell, desde la raíz):

```powershell
python -m venv .venv-magnitude
.\.venv-magnitude\Scripts\python.exe -m pip install -r scripts/requirements-magnitude.txt
$env:MAGNITUDE_PYTHON = (Resolve-Path .\.venv-magnitude\Scripts\python.exe).Path
.\.venv-magnitude\Scripts\python.exe scripts/test_measure_pd.py
node --test tests/responseMagnitude.test.js
```

El Dockerfile incluye Python y ObsPy. Reconstruir la imagen para aplicar el cambio.
No activar `P_WAVE_MAGNITUDE_ENABLED=true` públicamente solo por pasar pruebas
sintéticas: aún falta comparar ventanas reales con un catálogo de referencia.

- Node.js 24+
- Docker / Podman (opcional)

## Instalación local

```bash
npm install
npm start
```

El servidor arranca en:
- HTTP: `http://localhost:3001`
- WebSocket: `ws://localhost:3001/ws`

## Docker / Podman

```bash
# Podman
podman build -t sismo-server .
podman run -d -p 3001:3001 --name sismo-server sismo-server

# Docker Compose
docker compose up -d
```

## Endpoints REST

### GET /health
Estado del servidor y del pool de conexiones.

### GET /status
Estado detallado: clientes, pool, estaciones disponibles.

### GET /stations?lat=LAT&lon=LON&radius=RADIUS
Devuelve las estaciones más cercanas a una ubicación. Sin parámetros, devuelve todas.

### POST /location
Registra la ubicación de un cliente:
```json
{ "latitude": 9.04, "longitude": -79.42, "clientId": "abc123" }
```

## WebSocket /ws

### Mensaje del cliente al servidor

**Suscribirse a estaciones cercanas:**
```json
{
  "type": "subscribe",
  "latitude": 9.04,
  "longitude": -79.42,
  "radiusKm": 500
}
```

### Mensajes del servidor al cliente

- `connected` — Confirmación de conexión
- `subscribed` — Estaciones asignadas al cliente
- `waveform` — Datos sísmicos en tiempo real
- `level_change` — Cambio de nivel sísmico
- `earthquake_alert` — Alerta de sismo detectado

### Ejemplo de alerta

```json
{
  "type": "earthquake_alert",
  "timestamp": "2026-08-25T...",
  "pga": 0.045,
  "level": "ALERT",
  "levelName": "S",
  "alertType": "S",
  "severity": "high",
  "message": "Onda S detectada",
  "estimatedDistance": 120,
  "earlyWarningTime": 20,
  "station": "CU-BCI",
  "stationName": "Isla Barro Colorado, Panama"
}
```

## Configuración

### Variables de entorno

- `PORT` — Puerto HTTP/WS (default: 3001)

### Archivos principales

- `index.js` — Servidor Express + WebSocket
- `stationPool.js` — Pool de conexiones SeedLink reutilizables
- `seismicAnalysis.js` — Detector sísmico (máquina de estados P/S)
- `polyfill.mjs` — Polyfills para seisplotjs en Node
- `Dockerfile` — Imagen de contenedor

## Conectar la app móvil

La app móvil se conecta por WebSocket a este servidor:

```js
const ws = new WebSocket('ws://TU_IP:3001/ws');
ws.send(JSON.stringify({
  type: 'subscribe',
  latitude: 9.04,
  longitude: -79.42,
  radiusKm: 500
}));
```

El servidor responde con las estaciones más cercanas y comienza a enviar waveform y alertas en tiempo real.

## Firebase y notificaciones por radio

Los eventos confirmados se publican en `events/{eventId}`. La Cloud Function
`notifyNearbyUsers` calcula la distancia entre el epicentro y cada documento de
`users` y envía FCM si está dentro de `radiusKm`.

Cada usuario debe guardar esta estructura en Firestore:

```json
{
  "latitude": 9.0412,
  "longitude": -79.4174,
  "radiusKm": 500,
  "notificationsEnabled": true,
  "fcmTokens": ["TOKEN_FCM_DEL_DISPOSITIVO"]
}
```

El token debe ser FCM nativo (`getToken` de React Native Firebase en Android/iOS), no un token
de Expo Push. Para publicar desde el servidor, configura
`FIREBASE_SERVICE_ACCOUNT_JSON` como secreto del entorno de producción. Nunca
subas ese JSON al repositorio.

### Desplegar la Cloud Function

Proyecto: `appsismo-fee42`, función Gen 2 `notifyNearbyUsers`, región `us-central1`.
Se dispara al crear `events/{eventId}`; no tiene una URL HTTP para que la app envíe
solicitudes. Requiere Firestore `(default)`, facturación Blaze y permisos de despliegue.
Ejecutar desde la raíz, no desde `functions/`:

```powershell
npm install -g firebase-tools
firebase login
npm ci --prefix functions
$env:FUNCTIONS_DISCOVERY_TIMEOUT = '60'
firebase deploy --only functions:notifyNearbyUsers --project appsismo-fee42
firebase functions:list --project appsismo-fee42
firebase functions:log --only notifyNearbyUsers --project appsismo-fee42
```

El runtime declarado actualmente en `functions/package.json` es Node 20: revisar
su soporte y migrarlo con pruebas antes de que Firebase bloquee nuevos despliegues.
El código del servidor y la función se despliegan por separado; un `git push`
no confirma ninguno de los dos. El Admin SDK dentro de la función usa su identidad
de Google; no subir archivos privados al directorio `functions`.

Orden de actualización: primero la función que acepta magnitud desconocida, luego
la app compatible y después el servidor. Una función antigua puede convertir
`null` a M0; una app antigua puede guardar magnitud desconocida como cero o ignorar
el mensaje en primer plano. No considerar la actualización completada sin probar
estos casos en un dispositivo de prueba.

Las reglas se despliegan por separado **tras compararlas con las reglas existentes**
para no retirar acceso de otras colecciones del proyecto compartido:

```bash
firebase deploy --only firestore:rules --project appsismo-fee42
```

Si el CLI indica «Functions successfully deployed» seguido de un error de política
de limpieza, la función puede haber quedado desplegada: verificar `functions:list`.
Opcionalmente configurar eliminación de imágenes antiguas (borra artefactos de
compilación, no documentos Firestore):

```powershell
firebase functions:artifacts:setpolicy --location us-central1 --days 7 --project appsismo-fee42
```

Consultar [gestión de funciones](https://firebase.google.com/docs/functions/manage-functions)
y [credenciales administrativas](https://firebase.google.com/docs/admin/setup).
No llamar `/simulate` para comprobar el despliegue: puede afectar clientes reales.

### Crear estaciones en Firestore

La colección `stations` es un catálogo opcional; no controla el pool ni dispara
`notifyNearbyUsers`. Tener miles de documentos no abre miles de conexiones: el
servidor selecciona como máximo 40 de su inventario EarthScope. El monitoreo y
los push no requieren que el catálogo se copie a Firestore.

Para crear documentos manualmente:

1. Abrir Firebase Console → `appsismo-fee42` → Firestore Database → `(default)`.
2. Crear la colección `stations` (si ya existe, abrirla).
3. Consultar `/stations` en el servidor para obtener nombres y coordenadas. Para
   ver únicamente la selección del monitor, consultar `/status` → `pool.stations`.
4. Usar como ID el `code`, por ejemplo `CU-BCIP`. No usar un ID aleatorio: así una
   actualización puede dirigirse al mismo documento sin duplicarlo.
5. Crear los campos `code`, `network`, `station`, `name` como strings y
   `latitude`, `longitude` como números (copiar `lat`/`lon` del servidor).

Ejemplo basado en las coordenadas del evento analizado; verificar el catálogo
actual antes de cargarlo:

```json
{
  "code": "CU-BCIP",
  "network": "CU",
  "station": "BCIP",
  "name": "CU-BCIP",
  "latitude": 9.1665,
  "longitude": -79.8373
}
```

Usar el nombre descriptivo devuelto por `/stations` cuando esté disponible.
No poner `active: true` como prueba de conexión: la disponibilidad real se consulta
en `/health`. Crear estaciones no crea usuarios ni tokens: la app registra
`users/{uid}` con Auth; la función consulta `users`, no `stations` ni `pushDevices`.
El despliegue de reglas/funciones no carga automáticamente este catálogo.

## Licencia

ISC
