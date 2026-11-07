function alertPayload(alert, eventId, distance) {
  const known = Number.isFinite(alert.magnitude) && alert.magnitudeStatus !== 'unknown';
  return {
    notification: {
      title: known ? `ALERTA SÍSMICA M${alert.magnitude.toFixed(1)} (preliminar)` : 'Detección sísmica: magnitud no determinada',
      body: `Epicentro estimado a ${distance.toFixed(0)} km. Datos preliminares.`,
    },
    data: {
      type: 'earthquake_alert', eventId: String(eventId),
      latitude: String(alert.latitude), longitude: String(alert.longitude),
      ...(known ? { magnitude: String(alert.magnitude) } : {}),
      magnitudeStatus: known ? String(alert.magnitudeStatus ?? 'experimental') : 'unknown',
      magnitudeType: known ? String(alert.magnitudeType ?? '') : '',
      preliminaryMagnitude: 'true', depthStatus: Number.isFinite(alert.depth) ? 'estimated' : 'unknown',
      ...(Number.isFinite(alert.depth) ? { depth: String(alert.depth) } : {}),
      distanceKm: distance.toFixed(2),
    },
  };
}
module.exports = { alertPayload };
