import '../polyfill.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { parseChannels, availableStations, selectStrategicStations } from '../services/globalInventory.js';
import { stationCommands, SeedlinkFeed } from '../services/seedlinkFeed.js';
import { GlobalMonitor } from '../stationPool.js';
import { registerPPick, resetCorrelator } from '../services/eventCorrelator.js';

const now = Date.parse('2026-10-13T00:00:00Z');
const row = 'CU|BCIP|00|BHZ|9.16|-79.83|61|0|0|-90|Velocity Sensor|2447800000|0.02|m/s|40|2022-09-02T00:00:00|';
test('metadata: correct scale/sample rate; current velocity channels only', () => {
  const m = parseChannels(row, now);
  assert.equal(m.get('CU.BCIP.00.BHZ').sampleRate, 40);
  assert.equal(m.get('CU.BCIP.00.BHZ').sensitivity.sensitivity, 2447800000);
  assert.equal(parseChannels(row.replace('m/s|', 'm/s**2|'), now).size, 0);
  assert.equal(parseChannels(row + '2023-01-01T00:00:00', now).size, 0);
  const stream = {id:'FDSN:CU_BCIP_00_B_H_Z/MSEED', end_time:'2026-10-12T23:59:50Z'};
  assert.equal(availableStations(m, [stream], now).length, 1);
  assert.equal(availableStations(m, [stream], now + 60000).length, 0);
});

const candidates = Array.from({length:500}, (_, i) => ({code:`XX-S${i}`, network:'XX', station:`S${i}`,
  location:'00',channel:'BHZ',lat:-75 + (i % 20)*8,lon:-175 + Math.floor(i / 20)*14,dataAgeMs:1000}));
test('selection: hard cap 40, unique, geographic distribution rather than first 40', () => {
  const s = selectStrategicStations([...candidates], 2476);
  assert.equal(s.length, 40);
  assert.equal(new Set(s.map(x=>x.code)).size, 40);
  assert.ok(s.some(x=>x.lon > 130)); assert.ok(s.some(x=>x.lon < -130));
  assert.ok(s.some(x=>x.lat > 50)); assert.ok(s.some(x=>x.lat < -50));
  assert.equal(selectStrategicStations(candidates.slice(0,4)).length,4);
});

test('global monitor starts without clients; disconnects never close feeds or enlarge selection', async () => {
  let active = 0;
  class Feed { start(){active++;} stop(){active--;} }
  const m = new GlobalMonitor({Feed, inventory: async()=>[...candidates]});
  try {
    await m.start();
    assert.equal(active,3); assert.equal(m.stats().selectedStations,40);
    assert.equal(m.stats().stationLimit,40);
    assert.equal(m.stats().connectedStations,0); // handshake is not data
    m.subscribe('user',9,-79,20000); m.unsubscribe('user');
    assert.equal(active,3); assert.equal(m.stats().selectedStations,40);
    assert.equal(m.stats().totalSubscribers,0);
  } finally { m.stop(); }
  assert.equal(active,0);
});

test('SeedLink sends STATION station network and DATA per station, END once', async () => {
  const commands = [];
  class Connection {
    constructor(){this.webSocket={send:c=>commands.push(c)};}
    setOnClose(){} async interactiveConnect(){} async sendHello(){}
    async createCmdPromise(c){commands.push(c);} close(){} handle(){}
  }
  const stations = [{station:'BCIP',network:'CU',location:'00',channel:'BHZ'},
    {station:'ANMO',network:'IU',location:'',channel:'BHZ'}];
  const feed = new SeedlinkFeed(stations,()=>{},()=>{},Connection);
  feed.stopped = false;
  try { await feed.connect(); assert.deepEqual(commands,[...stationCommands(stations[0]),...stationCommands(stations[1]),'END\r\n']); }
  finally {feed.stop();}
  assert.equal(commands[0],'STATION BCIP CU'); assert.equal(commands[1],'SELECT 00BHZ.D');
});

test('global correlation excludes unrelated continents and avoids repeat publication', () => {
  resetCorrelator();
  const pick=(stationCode,lat,lon)=>({stationCode,lat,lon,pTime:DateTime.fromMillis(now),amplitude:1});
  registerPPick(pick('A',9,-79));
  registerPPick(pick('B',40,140));
  const c=registerPPick(pick('C',10,-80));
  assert.notEqual(c?.state,'CONFIRMED_EVENT');
  const e=registerPPick(pick('D',8,-78));
  assert.equal(e.state,'CONFIRMED_EVENT'); assert.equal(e.numStations,3);
  assert.equal(registerPPick(pick('E',9,-78)),null);
  resetCorrelator();
});
