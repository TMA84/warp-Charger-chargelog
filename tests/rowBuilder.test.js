const { buildRows, tsToDate, fmtDate, fmtDuration } = require('../server');
const fc = require('fast-check');

// Helper: create a charge record object with realistic fields
function makeCharge(overrides = {}) {
  return {
    tsMin: overrides.tsMin ?? 28771200,   // some valid minute timestamp
    userId: overrides.userId ?? 1,
    duration: overrides.duration ?? 3600,
    kwhStart: 'kwhStart' in overrides ? overrides.kwhStart : 10.0,
    energy: 'energy' in overrides ? overrides.energy : 5.0,
    wallbox: overrides.wallbox ?? 'WB1',
    price: overrides.price ?? 30,
  };
}

// ─── 5.1 Unit Tests ─────────────────────────────────────────────────────────

describe('buildRows – Unit Tests', () => {
  const userNames = { 1: 'Alice', 2: 'Bob' };

  it('known userId → username from map', () => {
    const rows = buildRows([makeCharge({ userId: 1 })], userNames);
    expect(rows[0].user).toBe('Alice');
  });

  it('unknown userId → fallback "ID {userId}"', () => {
    const rows = buildRows([makeCharge({ userId: 99 })], userNames);
    expect(rows[0].user).toBe('ID 99');
  });

  it('energy null → cost 0', () => {
    const rows = buildRows([makeCharge({ energy: null })], userNames);
    expect(rows[0].cost).toBe(0);
  });

  it('correct cost calculation', () => {
    // energy=10, price=30 → Math.round(10*30)/100 = 3, then Math.round(3*100)/100 = 3
    const rows = buildRows([makeCharge({ energy: 10, price: 30 })], userNames);
    expect(rows[0].cost).toBe(3);
  });
});

// ─── Generators for property tests ──────────────────────────────────────────

/**
 * Arbitrary for a charge record object suitable for buildRows.
 * Generates records with all required fields including wallbox and price.
 */
function arbChargeObj() {
  const minTs = new Date(Date.UTC(2020, 0, 1)).getTime() / 60000;
  const maxTs = new Date(Date.UTC(2030, 11, 31)).getTime() / 60000;

  return fc.record({
    tsMin: fc.integer({ min: Math.floor(minTs), max: Math.floor(maxTs) }),
    userId: fc.integer({ min: 0, max: 20 }),
    duration: fc.integer({ min: 0, max: 86400 }),
    kwhStart: fc.oneof(
      fc.constant(null),
      fc.float({ noDefaultInfinity: true, noNaN: true, min: 0, max: 10000 })
    ),
    energy: fc.oneof(
      fc.constant(null),
      fc.float({ noDefaultInfinity: true, noNaN: true, min: 0, max: 100 })
    ),
    wallbox: fc.constantFrom('WB1', 'WB2', 'Garage'),
    price: fc.integer({ min: 0, max: 100 }),
  });
}

/**
 * Arbitrary for an array of charge record objects.
 */
function arbChargeArray() {
  return fc.array(arbChargeObj(), { minLength: 0, maxLength: 30 });
}

/**
 * Arbitrary for a userNames map (userId → name string).
 */
function arbUserNames() {
  return fc.array(
    fc.tuple(
      fc.integer({ min: 0, max: 20 }),
      fc.string({ minLength: 1, maxLength: 20 })
    ),
    { minLength: 0, maxLength: 10 }
  ).map(pairs => Object.fromEntries(pairs));
}

// ─── 5.2 Property 12: Row count equals record count ────────────────────────

describe('buildRows – Property Tests', () => {
  /**
   * Property 12: Row count equals record count
   * buildRows(charges, userNames).length === charges.length
   *
   * **Validates: Requirements 3.1, 3.6**
   */
  it('Property 12: row count equals record count', () => {
    fc.assert(
      fc.property(
        arbChargeArray(),
        arbUserNames(),
        (charges, userNames) => {
          const rows = buildRows(charges, userNames);
          expect(rows).toHaveLength(charges.length);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 13: User name resolution
   * If userId in map → user === userNames[userId], else user === "ID {userId}"
   *
   * **Validates: Requirements 3.2, 3.3**
   */
  it('Property 13: user name resolution', () => {
    fc.assert(
      fc.property(
        arbChargeArray(),
        arbUserNames(),
        (charges, userNames) => {
          const rows = buildRows(charges, userNames);
          for (let i = 0; i < charges.length; i++) {
            const uid = charges[i].userId;
            if (userNames[uid]) {
              expect(rows[i].user).toBe(userNames[uid]);
            } else {
              expect(rows[i].user).toBe(`ID ${uid}`);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 14: Cost calculation correctness
   * For energy !== null and price > 0: cost = Math.round(Math.round(energy * price) / 100 * 100) / 100
   * For energy === null: cost === 0
   *
   * **Validates: Requirements 3.4, 3.5**
   */
  it('Property 14: cost calculation correctness', () => {
    fc.assert(
      fc.property(
        arbChargeArray(),
        arbUserNames(),
        (charges, userNames) => {
          const rows = buildRows(charges, userNames);
          for (let i = 0; i < charges.length; i++) {
            const c = charges[i];
            if (c.energy === null || c.energy === 0) {
              expect(rows[i].cost).toBe(0);
            } else {
              const expected = Math.round(Math.round(c.energy * c.price) / 100 * 100) / 100;
              expect(rows[i].cost).toBe(expected);
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
