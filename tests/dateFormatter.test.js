const { tsToDate, fmtDate, fmtDuration } = require('../server');
const fc = require('fast-check');

// ─── 7.1 Unit Tests ─────────────────────────────────────────────────────────

describe('tsToDate – Unit Tests', () => {
  it('tsMin=0 → null', () => {
    expect(tsToDate(0)).toBeNull();
  });

  it('known tsMin → correct Date', () => {
    const tsMin = 28771200; // some known value
    const d = tsToDate(tsMin);
    expect(d).toBeInstanceOf(Date);
    expect(d.getTime()).toBe(tsMin * 60 * 1000);
  });
});

describe('fmtDate – Unit Tests', () => {
  it('null → "–"', () => {
    expect(fmtDate(null)).toBe('–');
  });

  it('known date → expected string', () => {
    // 2024-03-15 14:30 UTC
    const d = new Date(Date.UTC(2024, 2, 15, 14, 30));
    expect(fmtDate(d)).toBe('15.03.2024 14:30');
  });

  it('epoch start → "01.01.1970 00:00"', () => {
    const d = new Date(0);
    expect(fmtDate(d)).toBe('01.01.1970 00:00');
  });
});

describe('fmtDuration – Unit Tests', () => {
  it('duration 0 → "0:00:00"', () => {
    expect(fmtDuration(0)).toBe('0:00:00');
  });

  it('3661 seconds → "1:01:01"', () => {
    expect(fmtDuration(3661)).toBe('1:01:01');
  });

  it('7200 seconds → "2:00:00"', () => {
    expect(fmtDuration(7200)).toBe('2:00:00');
  });

  it('59 seconds → "0:00:59"', () => {
    expect(fmtDuration(59)).toBe('0:00:59');
  });
});

// ─── 7.2 Property 15: tsToDate conversion correctness ──────────────────────

describe('tsToDate – Property Tests', () => {
  /**
   * Property 15: tsToDate conversion correctness
   * For any positive tsMin, tsToDate(tsMin).getTime() === tsMin * 60 * 1000
   *
   * **Validates: Requirements 4.1**
   */
  it('Property 15: tsToDate conversion correctness', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 0xFFFFFFFF }),
        (tsMin) => {
          const d = tsToDate(tsMin);
          expect(d).toBeInstanceOf(Date);
          expect(d.getTime()).toBe(tsMin * 60 * 1000);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── 7.3 Property 16: fmtDate format compliance ────────────────────────────

describe('fmtDate – Property Tests', () => {
  /**
   * Property 16: fmtDate format compliance
   * For any valid Date object, fmtDate(d) matches /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/
   *
   * **Validates: Requirements 4.3, 4.7**
   */
  it('Property 16: fmtDate format compliance', () => {
    const dateRegex = /^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}$/;
    const minMs = Date.UTC(1970, 0, 1);
    const maxMs = Date.UTC(2099, 11, 31);
    fc.assert(
      fc.property(
        fc.integer({ min: minMs, max: maxMs }).map((ms) => new Date(ms)),
        (d) => {
          const result = fmtDate(d);
          expect(result).toMatch(dateRegex);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── 7.4 Property 17: fmtDuration round-trip ───────────────────────────────

describe('fmtDuration – Property Tests', () => {
  /**
   * Property 17: fmtDuration round-trip
   * For any non-negative integer s, parsing fmtDuration(s) back gives s.
   * Format is "H:MM:SS", so parseInt(H)*3600 + parseInt(MM)*60 + parseInt(SS) === s
   *
   * **Validates: Requirements 4.5**
   */
  it('Property 17: fmtDuration round-trip', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 359999 }),
        (s) => {
          const formatted = fmtDuration(s);
          const parts = formatted.split(':');
          expect(parts).toHaveLength(3);
          const reconstructed =
            parseInt(parts[0], 10) * 3600 +
            parseInt(parts[1], 10) * 60 +
            parseInt(parts[2], 10);
          expect(reconstructed).toBe(s);
        }
      ),
      { numRuns: 100 }
    );
  });
});
