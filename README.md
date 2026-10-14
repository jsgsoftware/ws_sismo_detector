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
  - Hasta 300 estaciones, monitoreadas aunque no haya usuarios
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

- El catálogo es independiente del monitoreo: como máximo 300 estaciones seleccionadas.
- Solo canales verticales BHZ/HHZ con calibración en m/s y datos menores de 60 segundos.
- Selección geográfica: primer punto cerca de Panamá, luego cubrir los mayores huecos;
  cada punto incorpora hasta dos estaciones vecinas (20–500 km), si existen.
- El criterio es una heurística de cobertura, no una red mundial de alerta temprana validada.
- Se revisa disponibilidad cada 15 minutos. Si hay menos de 300 elegibles se informa el déficit.
- Tres conexiones multiestación con reconexión y vigilancia de datos; los usuarios no abren ni cierran conexiones.
- Las suscripciones WS solo eligen señales para visualizar entre las estaciones ya seleccionadas.
- Un detector sísmico por estación (no por usuario)

`/status` y `/health` muestran `pool.stationLimit`, `selectedStations`, `connectedStations`,
`feeds` y la lista seleccionada con coordenadas, antigüedad y contadores de paquetes.
`connectedStations` cuenta señales recientes recibidas, no solamente handshakes aceptados.
`firebase.initialized` indica SDK inicializado; solo `lastPublishedAt` confirma una escritura.
La detección/localización existente sigue siendo experimental: 300 estaciones no garantizan
cobertura de todos los sismos ni latencia de milisegundos. No se suben señales crudas a Firestore.

Pruebas sin Firebase ni notificaciones: `node --test tests/globalMonitor.test.js`.
Prueba real de 3 minutos sin publicar alertas: `node scripts/check-global-monitor.mjs`.

## Requisitos

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

El token debe ser FCM nativo (`getDevicePushTokenAsync` en Expo), no un token
de Expo Push. Para publicar desde el servidor, configura
`FIREBASE_SERVICE_ACCOUNT_JSON` como secreto del entorno de producción. Nunca
subas ese JSON al repositorio.

Despliegue de Firebase:

```bash
firebase deploy --only functions:notifyNearbyUsers,firestore:rules --project appsismo-fee42
```

## Licencia

ISC
