"""Raw counts + epoch-specific StationXML -> displacement Pd. No Firebase writes.

Uses ObsPy/evalresp (all response stages), NOT sensitivity-only or a 2800 gain.
Padding and prefilter are engineering choices requiring regional validation.
"""
import io
import json
import sys
import urllib.parse
import urllib.request
import warnings
import numpy as np
from obspy import Trace, UTCDateTime, read_inventory


def measure(window, inventory):
    rate = float(window['sampleRate'])
    samples = np.asarray(window['samples'], dtype=np.float64)
    start = UTCDateTime(window['startTimeMs'] / 1000)
    ptime = UTCDateTime(window['pTimeMs'] / 1000)
    if not 20 <= rate <= 100 or not np.isfinite(samples).all():
        raise ValueError('invalid_samples')
    if len(samples) != round(44 * rate) + 1 or abs(float(ptime - start) - 30) > 0.25 / rate:
        raise ValueError('incomplete_window')
    trace = Trace(samples.copy(), header={
        'network': window['network'], 'station': window['station'],
        'location': window['location'], 'channel': window['channel'],
        'sampling_rate': rate, 'starttime': start})
    channels = [ch for net in inventory for sta in net for ch in sta
                if net.code == window['network'] and sta.code == window['station']
                and ch.code == window['channel'] and ch.location_code == window['location']
                and ch.start_date <= start and (ch.end_date is None or ch.end_date >= trace.stats.endtime)]
    if len(channels) != 1:
        raise ValueError('missing_or_ambiguous_response_epoch')
    channel = channels[0]
    if abs(channel.sample_rate - rate) > 0.001 or not channel.response or not channel.response.response_stages:
        raise ValueError('incomplete_response')
    # Reject warnings such as response sensitivity mismatches, not silent fallback.
    prefilter = [0.05, 0.1, min(8, rate * 0.4), min(10, rate * 0.45)]
    with warnings.catch_warnings():
        warnings.simplefilter('error')
        trace.remove_response(inventory=inventory, output='DISP', water_level=60,
                              pre_filt=prefilter, zero_mean=True, taper=True, taper_fraction=0.05)
        trace.filter('lowpass', freq=3.0, corners=2, zerophase=False)
    index = round(float(ptime - start) * rate)
    baseline = float(np.mean(trace.data[index - round(2 * rate):index]))
    pd_cm = float(np.max(np.abs(trace.data[index:index + round(4 * rate) + 1] - baseline)) * 100)
    if not np.isfinite(pd_cm) or pd_cm <= 0:
        raise ValueError('invalid_pd')
    return {'stationCode': window['stationCode'], 'pdCm': pd_cm, 'pWindowSeconds': 4,
            'responseCorrected': True, 'responseId': trace.id,
            'responseEpochStart': str(channel.start_date),
            'responseEpochEnd': str(channel.end_date) if channel.end_date else None,
            'preFilterHz': prefilter, 'waterLevelDb': 60,
            'responseMethod': 'ObsPy-evalresp-DISP-all-stages'}


def main():
    windows = json.load(sys.stdin)
    if not isinstance(windows, list) or len(windows) > 8:
        raise ValueError('too_many_windows')
    results = []
    for window in windows:
        try:
            query = urllib.parse.urlencode({
                'network': window['network'], 'station': window['station'],
                'location': window['location'] or '--', 'channel': window['channel'],
                'starttime': str(UTCDateTime(window['startTimeMs'] / 1000)),
                'endtime': str(UTCDateTime(window['pTimeMs'] / 1000 + 14)),
                'level': 'response', 'format': 'xml'})
            with urllib.request.urlopen('https://service.earthscope.org/fdsnws/station/1/query?' + query, timeout=8) as response:
                xml = response.read(5 * 1024 * 1024 + 1)
            if len(xml) > 5 * 1024 * 1024:
                raise ValueError('response_too_large')
            results.append(measure(window, read_inventory(io.BytesIO(xml))))
        except Exception as error:
            results.append({'stationCode': window.get('stationCode'), 'error': type(error).__name__})
    print(json.dumps(results, allow_nan=False))


if __name__ == '__main__':
    main()
