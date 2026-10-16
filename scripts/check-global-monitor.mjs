// Read-only smoke test: real waveforms, no index.js, Firebase or push callbacks.
import '../polyfill.mjs';
import { GlobalMonitor } from '../stationPool.js';

let processed = 0;
const monitor = new GlobalMonitor();
const timer = setTimeout(() => {
  const stats = monitor.stats();
  console.log(JSON.stringify({ ...stats, processed,
    stations: stats.stations.filter(s => s.packetCount > 0).slice(0, 10) }, null, 2));
  monitor.stop();
  process.exit(stats.selectedStations <= 40 && stats.connectedStations > 0 && processed > 0 ? 0 : 1);
}, 180000);
process.once('SIGINT', () => { clearTimeout(timer); monitor.stop(); process.exit(0); });
await monitor.start(() => { processed++; }, () => {});
