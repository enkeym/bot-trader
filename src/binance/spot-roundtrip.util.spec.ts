import {
  computePeakMarkPrice,
  computeSellQuantityRespectingMinNotional,
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

  it('computeSellQuantityRespectingMinNotional rejects dust', () => {
    const lot = { minQty: 0.00001, stepSize: 0.00001 };
    const r = computeSellQuantityRespectingMinNotional({
      freeBtc: 1,
      trackedBtc: 0.00001,
      lot,
      markPriceUsdt: 70_000,
      minNotionalUsdt: 5,
    });
    expect(r.quantity).toBe(0);
    expect(r.belowMinNotional).toBe(true);
  });

  it('computeSellQuantityRespectingMinNotional allows above min notional', () => {
    const lot = { minQty: 0.00001, stepSize: 0.00001 };
    const r = computeSellQuantityRespectingMinNotional({
      freeBtc: 1,
      trackedBtc: 0.001,
      lot,
      markPriceUsdt: 70_000,
      minNotionalUsdt: 5,
    });
    expect(r.quantity).toBe(0.001);
    expect(r.belowMinNotional).toBeUndefined();
  });
});
