import {
  computePeakMarkPrice,
  priceHitsEmergencyDrawdown,
  scaleQuoteByVolatility,
} from './spot-roundtrip.util';

describe('spot-roundtrip.util emergency & sizing', () => {
  it('computePeakMarkPrice', () => {
    expect(
      computePeakMarkPrice({
        trackedBtc: 0,
        prevPeakMarkUsdt: 100,
        markPrice: 105,
      }),
    ).toBe(0);
    expect(
      computePeakMarkPrice({
        trackedBtc: 0.1,
        prevPeakMarkUsdt: 0,
        markPrice: 100,
      }),
    ).toBe(100);
    expect(
      computePeakMarkPrice({
        trackedBtc: 0.1,
        prevPeakMarkUsdt: 100,
        markPrice: 105,
      }),
    ).toBe(105);
  });

  it('priceHitsEmergencyDrawdown', () => {
    expect(
      priceHitsEmergencyDrawdown({
        markPrice: 94,
        peakMarkUsdt: 100,
        drawdownPercent: 5,
      }),
    ).toBe(true);
    expect(
      priceHitsEmergencyDrawdown({
        markPrice: 96,
        peakMarkUsdt: 100,
        drawdownPercent: 5,
      }),
    ).toBe(false);
  });

  it('scaleQuoteByVolatility', () => {
    expect(
      scaleQuoteByVolatility({
        maxQuoteUsdt: 20,
        returnStdevPp: 0.4,
        refStdevPp: 0.2,
        minScale: 0.25,
        enabled: true,
      }),
    ).toBe(10);
    expect(
      scaleQuoteByVolatility({
        maxQuoteUsdt: 20,
        returnStdevPp: 0.1,
        refStdevPp: 0.2,
        minScale: 0.25,
        enabled: true,
      }),
    ).toBe(20);
  });
});
