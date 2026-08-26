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
  - Apertura/cierre automático según suscriptores
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

- 2477 estaciones globales cargadas dinámicamente desde IRIS FDSN
- Cada usuario recibe solo las 2-3 estaciones más cercanas dentro de su radio
- Si nadie usa una estación, se cierra automáticamente
- Si otro usuario la necesita, se reutiliza sin abrir nueva conexión
- Un detector sísmico por estación (no por usuario)

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

## Licencia

ISC