const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { logger } = require('firebase-functions');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

function distanceKm(lat1, lon1, lat2, lon2) {
  const earthRadiusKm = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * Math.PI / 180)
    * Math.cos(lat2 * Math.PI / 180)
    * Math.sin(dLon / 2) ** 2;
  return 2 * earthRadiusKm * Math.asin(Math.sqrt(a));
}

exports.notifyNearbyUsers = onDocumentCreated(
  { document: 'events/{eventId}', region: 'us-central1', retry: true },
  async (event) => {
    const alert = event.data?.data();
    if (!alert || alert.latitude == null || alert.longitude == null) {
      logger.warn('Evento sin coordenadas; no se envían notificaciones');
      return;
    }

    const snapshot = await db.collection('users')
      .where('notificationsEnabled', '!=', false)
      .get();
    const messages = [];
    const tokenOwners = new Map();

    for (const userDoc of snapshot.docs) {
      const user = userDoc.data();
      const lat = Number(user.latitude);
      const lon = Number(user.longitude);
      const radiusKm = Number(user.radiusKm ?? 500);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(radiusKm)) continue;

      const distance = distanceKm(alert.latitude, alert.longitude, lat, lon);
      if (distance > radiusKm) continue;

      const tokens = Array.isArray(user.fcmTokens)
        ? user.fcmTokens
        : user.fcmToken ? [user.fcmToken] : [];
      for (const token of tokens.filter(Boolean)) {
        tokenOwners.set(token, userDoc.ref);
        messages.push({
          token,
          notification: {
            title: `ALERTA SÍSMICA M${Number(alert.magnitude ?? 0).toFixed(1)}`,
            body: `Sismo detectado a ${distance.toFixed(0)} km`,
          },
          data: {
            type: 'earthquake_alert',
            eventId: String(event.params.eventId),
            latitude: String(alert.latitude),
            longitude: String(alert.longitude),
            magnitude: String(alert.magnitude ?? ''),
            distanceKm: distance.toFixed(2),
          },
          android: { priority: 'high', notification: { channelId: 'sismo-alertas' } },
        });
      }
    }

    for (let i = 0; i < messages.length; i += 500) {
      const response = await getMessaging().sendEach(messages.slice(i, i + 500));
      logger.info(`Evento ${event.params.eventId}: ${response.successCount} notificaciones enviadas`);

      const invalidTokens = [];
      response.responses.forEach((result, index) => {
        if (!result.success && ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'].includes(result.error?.code)) {
          invalidTokens.push(messages[i + index].token);
        }
      });
      for (const token of invalidTokens) {
        const owner = tokenOwners.get(token);
        if (owner) await owner.update({ fcmTokens: require('firebase-admin/firestore').FieldValue.arrayRemove(token) });
      }
    }
  }
);
