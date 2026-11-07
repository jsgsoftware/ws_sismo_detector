// Configuracion centralizada del sistema sismico
// Todos los parametros son ajustables desde aqui

export const SEISMIC_CONFIG = {
  // Velocidades de onda (km/s) - modelo simplificado de una capa
  velocities: {
    Vp: 6.1,
    Vs: 3.5,
  },

  // Filtrado de señal
  filter: {
    lowHz: 1,        // high-pass
    highHz: 10,      // low-pass
    numPoles: 4,     // orden del filtro Butterworth
  },

  // Deteccion STA/LTA
  staLta: {
    staSeconds: 1,       // ventana corta
    ltaSeconds: 20,      // ventana larga
    triggerOn: 3.5,      // ratio para disparar
    triggerOff: 1.5,     // ratio para dejar de disparar
    minStaLtaForP: 3.5,   // minimo ratio para considerar P
  },

  // Correlacion multi-estacion
  correlation: {
    minConfirmingStations: 3,      // minimo de estaciones para confirmar evento
    preferredStations: 3,           // ideal de estaciones
    windowSeconds: 15,              // ventana temporal para correlacion
    maxStationDistanceKm: 1000,     // evitar mezclar regiones distantes
  },

  // Discriminacion P/S por relacion V/H
  phaseDiscrimination: {
    vhRatioP: 1.3,    // > 1.3 sugiere P
    vhRatioS: 0.77,   // < 0.77 sugiere S
  },

  // Localizacion
  location: {
    maxDepthKm: 700,        // profundidad maxima de busqueda
    gridStepKm: 5,          // resolucion de la grilla de busqueda
    maxResidual: 5,         // residual maximo aceptable (s)
    confidenceThreshold: 0.5,
  },

  // Legacy single-pick ML removed: magnitude requires raw windows + response.

  // PGA / movimiento del suelo
  groundMotion: {
    // Si hay canal acelerometrico (HNZ/HNN/HNE), calcular PGA en m/s^2
    // PGA_g = PGA_ms2 / 9.80665
    gravity: 9.80665,
  },

  // Logging para calibracion
  logging: {
    saveEventDetails: true,
    saveStationPicks: true,
    saveWaveforms: false,  // guardar waveform completa (consumen espacio)
  },

  // USGS validacion
  usgs: {
    comparisonWindowMinutes: 30,   // ventana para comparar con USGS
    comparisonRadiusKm: 200,        // radio para buscar evento USGS
    feedUrl: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson',
  },
};
