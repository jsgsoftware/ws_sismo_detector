import unittest
import numpy as np
from obspy import Trace, UTCDateTime
from obspy.core.inventory import Inventory, Network, Station, Channel
from obspy.core.inventory.response import Response, InstrumentSensitivity, PolesZerosResponseStage, FIRResponseStage
from measure_pd import measure


class MeasurementTest(unittest.TestCase):
    def fixture(self):
        rate = 40
        n = 44 * rate + 1
        t = np.arange(n) / rate - 30
        displacement = 1e-5 * np.exp(-((t-1.5)/0.5)**2) * np.sin(2*np.pi*t)
        stages = [PolesZerosResponseStage(1, 2, 1, 'M/S', 'V',
                  'LAPLACE (RADIANS/SECOND)', 1, [], [], normalization_factor=1),
                  FIRResponseStage(2, 500000, 1, 'V', 'COUNTS', symmetry='NONE',
                  coefficients=[0.25, 0.5, 0.25], decimation_input_sample_rate=rate,
                  decimation_factor=1, decimation_offset=0, decimation_delay=1/rate,
                  decimation_correction=1/rate)]
        response = Response(instrument_sensitivity=InstrumentSensitivity(1e6, 1, 'M/S', 'COUNTS'), response_stages=stages)
        response.recalculate_overall_sensitivity()
        h, _ = response.get_evalresp_response(1/rate, n, output='DISP')
        counts = np.fft.irfft(np.fft.rfft(displacement) * h, n=n)
        channel = Channel('BHZ', '00', 9, -79, 0, 0, sample_rate=rate,
                          start_date=UTCDateTime(0), response=response)
        inv = Inventory([Network('XX', stations=[Station('TEST', 9, -79, 0, channels=[channel])])], 'synthetic test')
        window = dict(stationCode='XX-TEST', network='XX', station='TEST', location='00', channel='BHZ',
                      sampleRate=rate, startTimeMs=1700000000000, pTimeMs=1700000030000, samples=counts.tolist())
        expected = Trace(displacement.copy(), header={'sampling_rate':rate})
        expected.filter('lowpass', freq=3, corners=2, zerophase=False)
        pd = np.max(np.abs(expected.data[30*rate:34*rate+1]))*100
        return window, inv, pd

    def test_multistage_response_recovers_displacement(self):
        window, inv, expected = self.fixture()
        result = measure(window, inv)
        self.assertTrue(result['responseCorrected'])
        self.assertAlmostEqual(result['pdCm']/expected, 1, delta=0.15)

    def test_missing_epoch_and_incomplete_window_fail(self):
        window, inv, _ = self.fixture()
        window['samples'] = window['samples'][:-1]
        with self.assertRaises(ValueError): measure(window, inv)
        window, inv, _ = self.fixture()
        inv[0][0][0].end_date = UTCDateTime(1)
        with self.assertRaises(ValueError): measure(window, inv)


if __name__ == '__main__':
    unittest.main()
