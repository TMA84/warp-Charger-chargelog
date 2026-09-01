const { applyFilters } = require('../server');
const fc = require('fast-check');
const { arbFilterParams } = require('./helpers');

// Helper: create a charge record object (not a buffer) with realistic fields
function makeCharge(tsMin, userId, extra = {}) {
  return {
    tsMin,
    userId,
    duration: extra.duration ?? 3600,
    kwhStart: extra.kwhStart ?? 10.0,
    energy: extra.energy ?? 5.0,
    wallbox: extra.wallbox ?? 'WB1',
    price: extra.price ?? 30,
  };
}

// Helpers for minute-based timestamps
const utcMinutes = (y, m, d) => new Date(Date.UTC(y, m, d)).getTime() / 60000;

// ─── 4.1 Unit Tests ─────────────────────────────────────────────────────────

describe('applyFilters – Unit Tests', () => {
  const charges = [
    makeCharge(utcMinutes(2024, 0, 15), 1),  // Jan 15 2024, user 1
    makeCharge(utcMinutes(2024, 2, 10), 2),  // Mar 10 2024, user 2
    makeCharge(utcMinutes(2024, 6, 20), 1),  // Jul 20 2024, user 1
    makeCharge(utcMinutes(2025, 0, 5), 3),   // Jan 5 2025, user 3
  ];

  it('no filters → all records returned', () => {
    const result = applyFilters(charges, null, null, null, null, null);
    expect(result).toHaveLength(charges.length);
    expect(result).toEqual(charges);
  });

  it('userId filter → only matching records', () => {
    const result = applyFilters(charges, '1', null, null, null, null);
    expect(result).toHaveLength(2);
    expect(result.every(c => c.userId === 1)).toBe(true);
  });

  it('month filter → only records in that month', () => {
    const result = applyFilters(charges, null, null, null, '2024-03', null);
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(2);
  });

  it('year filter → only records in that year', () => {
    const result = applyFilters(charges, null, null, null, null, '2024');
    expect(result).toHaveLength(3);
    expect(result.every(c => {
      const yearStart = utcMinutes(2024, 0, 1);
      const yearEnd = utcMinutes(2025, 0, 1);
      return c.tsMin >= yearStart && c.tsMin < yearEnd;
    })).toBe(true);
  });

  it('month + year → month prioritized', () => {
    const result = applyFilters(charges, null, null, null, '2024-07', '2025');
    expect(result).toHaveLength(1);
    expect(result[0].userId).toBe(1);
    expect(result[0].tsMin).toBe(utcMinutes(2024, 6, 20));
  });

  it('dateFrom/dateTo range', () => {
    const result = applyFilters(
      charges, null,
      '2024-03-01', '2024-07-31',
      null, null
    );
    expect(result).toHaveLength(2);
    expect(result[0].tsMin).toBe(utcMinutes(2024, 2, 10));
    expect(result[1].tsMin).toBe(utcMinutes(2024, 6, 20));
  });
});

// ─── Generators for property tests ──────────────────────────────────────────

/**
 * Arbitrary for an array of charge record objects with tsMin in 2020-2030 range.
 */
function arbChargeObjects() {
  const minTs = new Date(Date.UTC(2020, 0, 1)).getTime() / 60000;
  const maxTs = new Date(Date.UTC(2030, 11, 31)).getTime() / 60000;

  const arbCharge = fc.record({
    tsMin: fc.integer({ min: Math.floor(minTs), max: Math.floor(maxTs) }),
    userId: fc.integer({ min: 0, max: 10 }),
    duration: fc.integer({ min: 0, max: 86400 }),
    kwhStart: fc.float({ noDefaultInfinity: true, noNaN: true, min: 0, max: 10000 }),
    energy: fc.oneof(fc.constant(null), fc.float({ noDefaultInfinity: true, noNaN: true, min: 0, max: 100 })),
    wallbox: fc.constant('WB1'),
    price: fc.integer({ min: 0, max: 100 }),
  });

  return fc.array(arbCharge, { minLength: 0, maxLength: 30 });
}

// ─── 4.2 Property 5: Empty filter returns all records ───────────────────────

describe('applyFilters – Property Tests', () => {
  /**
   * Property 5: Empty filter returns all records
   * applyFilters(charges, null, null, null, null, null) returns same length and content.
   *
   * **Validates: Requirements 2.1**
   */
  it('Property 5: empty filter returns all records', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        (charges) => {
          const result = applyFilters(charges, null, null, null, null, null);
          expect(result).toHaveLength(charges.length);
          expect(result).toEqual(charges);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 6: userId filter correctness
   * All returned records have userId === parseInt(userId).
   *
   * **Validates: Requirements 2.2**
   */
  it('Property 6: userId filter correctness', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        fc.integer({ min: 0, max: 10 }).map(String),
        (charges, userId) => {
          const result = applyFilters(charges, userId, null, null, null, null);
          const uid = parseInt(userId);
          expect(result.every(c => c.userId === uid)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 7: Month filter correctness
   * All returned records have tsMin in UTC range [monthStart, nextMonthStart).
   *
   * **Validates: Requirements 2.3**
   */
  it('Property 7: month filter correctness', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        fc.integer({ min: 2020, max: 2030 }),
        fc.integer({ min: 1, max: 12 }),
        (charges, y, m) => {
          const monthStr = `${y}-${String(m).padStart(2, '0')}`;
          const result = applyFilters(charges, null, null, null, monthStr, null);

          const from = new Date(Date.UTC(y, m - 1, 1)).getTime() / 60000;
          const to = new Date(Date.UTC(y, m, 1)).getTime() / 60000;

          expect(result.every(c => c.tsMin >= from && c.tsMin < to)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 8: Year filter correctness
   * All returned records have tsMin in UTC range [yearStart, nextYearStart).
   *
   * **Validates: Requirements 2.4**
   */
  it('Property 8: year filter correctness', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        fc.integer({ min: 2020, max: 2030 }).map(String),
        (charges, yearStr) => {
          const result = applyFilters(charges, null, null, null, null, yearStr);
          const y = parseInt(yearStr);
          const from = new Date(Date.UTC(y, 0, 1)).getTime() / 60000;
          const to = new Date(Date.UTC(y + 1, 0, 1)).getTime() / 60000;

          expect(result.every(c => c.tsMin >= from && c.tsMin < to)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 9: Date range filter correctness
   * All returned records satisfy tsMin >= dateFrom and tsMin < dateTo + 1440.
   *
   * **Validates: Requirements 2.6, 2.7**
   */
  it('Property 9: date range filter correctness', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        fc.tuple(
          fc.integer({ min: 2020, max: 2029 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 28 })
        ),
        fc.tuple(
          fc.integer({ min: 2020, max: 2030 }),
          fc.integer({ min: 1, max: 12 }),
          fc.integer({ min: 1, max: 28 })
        ),
        (charges, [y1, m1, d1], [y2, m2, d2]) => {
          const dateFrom = `${y1}-${String(m1).padStart(2, '0')}-${String(d1).padStart(2, '0')}`;
          const dateTo = `${y2}-${String(m2).padStart(2, '0')}-${String(d2).padStart(2, '0')}`;

          const result = applyFilters(charges, null, dateFrom, dateTo, null, null);

          const fromTs = new Date(dateFrom).getTime() / 60000;
          const toTs = new Date(dateTo).getTime() / 60000 + 1440;

          expect(result.every(c => c.tsMin >= fromTs && c.tsMin < toTs)).toBe(true);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 10: Filter reduces or preserves size
   * applyFilters(charges, ...).length <= charges.length
   *
   * **Validates: Requirements 2.9**
   */
  it('Property 10: filter reduces or preserves size', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        arbFilterParams(),
        (charges, params) => {
          const result = applyFilters(
            charges,
            params.userId ?? null,
            params.dateFrom ?? null,
            params.dateTo ?? null,
            params.month ?? null,
            params.year ?? null
          );
          expect(result.length).toBeLessThanOrEqual(charges.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 11: Filter idempotence
   * applyFilters(applyFilters(charges, ...), ...) === applyFilters(charges, ...)
   *
   * **Validates: Requirements 2.10**
   */
  it('Property 11: filter idempotence', () => {
    fc.assert(
      fc.property(
        arbChargeObjects(),
        arbFilterParams(),
        (charges, params) => {
          const args = [
            params.userId ?? null,
            params.dateFrom ?? null,
            params.dateTo ?? null,
            params.month ?? null,
            params.year ?? null,
          ];
          const once = applyFilters(charges, ...args);
          const twice = applyFilters(once, ...args);
          expect(twice).toEqual(once);
        }
      ),
      { numRuns: 100 }
    );
  });
});
