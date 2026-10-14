import { seedlink } from 'seisplotjs/nodeonly';

export function stationCommands(station) {
  // SeedLink 3: station FIRST, network SECOND; blank location = two spaces.
  return [`STATION ${station.station} ${station.network}`,
    `SELECT ${station.location || '  '}${station.channel}.D`, 'DATA'];
}

function deadline(promise, ms = 10000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('SeedLink handshake timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}

// One socket per group, DATA for EACH station and a single END at the end.
export class SeedlinkFeed {
  constructor(stations, onPacket, onState, Connection = seedlink.SeedlinkConnection) {
    Object.assign(this, { stations, onPacket, onState, Connection });
    this.stopped = true;
    this.attempt = 0;
  }
  start() { this.stopped = false; this.connect(); }
  async connect() {
    if (this.stopped) return;
    let failed = false;
    const fail = (error) => {
      if (failed || this.stopped) return;
      failed = true;
      clearInterval(this.watchdog);
      this.connection?.close();
      this.onState('reconnecting', error?.message || 'SeedLink closed');
      this.timer = setTimeout(() => this.connect(), Math.min(60000, 2000 * 2 ** Math.min(this.attempt++, 5)));
    };
    const connection = new this.Connection('wss://rtserve.earthscope.org/seedlink', [], packet => {
      if (failed || this.stopped) return;
      this.lastPacketAt = Date.now();
      this.attempt = 0;
      this.onPacket(packet);
    }, fail);
    this.connection = connection;
    connection.setOnClose(() => fail(new Error('SeedLink closed')));
    this.onState('connecting');
    try {
      await deadline(connection.interactiveConnect());
      await deadline(connection.sendHello());
      for (const station of this.stations) {
        for (const command of stationCommands(station)) {
          if (failed || this.stopped) return;
          await deadline(connection.createCmdPromise(command));
        }
      }
      if (failed || this.stopped) return;
      connection.webSocket.onmessage = event => connection.handle(event);
      connection.webSocket.send('END\r\n');
      this.lastPacketAt = Date.now();
      this.onState('streaming');
      this.watchdog = setInterval(() => {
        if (Date.now() - this.lastPacketAt > 90000) fail(new Error('No packets for 90 seconds'));
      }, 10000);
    } catch (error) { fail(error); }
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    clearInterval(this.watchdog);
    this.connection?.close();
  }
}
