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
    minConfirmingStations: 2,      // minimo de estaciones para confirmar evento
    preferredStations: 3,           // ideal de estaciones
    windowSeconds: 15,              // ventana temporal para correlacion
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

  // Magnitud ML (Local Magnitude)
  magnitude: {
    // Correccion de atenuacion Hutton-Boore (California, radio 1-100 km)
    // ML = log10(A_mm) + 1.11 * log10(R_km) + 0.00189 * R_km - 2.09
    // A_mm = amplitud en nanometros (simulacion Wood-Anderson)
    // R_km = distancia hipocentral
    attenuation: {
      a: 1.11,
      b: 0.00189,
      c: -2.09,
    },
    woodAnderson: {
      // Respuesta Wood-Anderson: torccion horizontal, T=0.8s, h=1.0, f0=1.0
      // Para simular: convierte velocidad a desplazamiento y aplica la respuesta WA
      staticMagnification: 2800,  // magnificacion estatica
      period: 0.8,               // periodo natural (s)
      damping: 0.8,              // amortiguamiento
    },
  },

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