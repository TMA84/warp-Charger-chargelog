const { parseChargeLog } = require('../server');

describe('parseChargeLog – Unit Tests', () => {
  it('returns empty array for empty buffer', () => {
    const result = parseChargeLog(Buffer.alloc(0));
    expect(result).toEqual([]);
  });

  it('ignores remainder bytes when buffer length is not a multiple of 16', () => {
    // 20 bytes = 1 full record (16) + 4 remainder bytes
    const buf = Buffer.alloc(20, 0);
    buf.writeUInt32LE(100, 0);       // tsMin
    buf.writeFloatLE(10.5, 4);       // kwhStart
    buf.writeUInt8(3, 8);            // userId
    buf[9] = 60; buf[10] = 0; buf[11] = 0; // duration = 60
    buf.writeFloatLE(12.5, 12);      // kwhEnd

    const result = parseChargeLog(buf);
    expect(result).toHaveLength(1);
    expect(result[0].tsMin).toBe(100);
  });

  it('returns null for kwhStart and energy when kwhStart is NaN', () => {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(500, 0);
    // Write NaN into kwhStart (offset 4)
    buf.writeFloatLE(NaN, 4);
    buf.writeUInt8(1, 8);
    buf[9] = 10; buf[10] = 0; buf[11] = 0;
    buf.writeFloatLE(20.0, 12);

    const result = parseChargeLog(buf);
    expect(result).toHaveLength(1);
    expect(result[0].kwhStart).toBeNull();
    expect(result[0].energy).toBeNull();
  });

  it('returns null for energy when kwhEnd is NaN', () => {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(500, 0);
    buf.writeFloatLE(10.0, 4);
    buf.writeUInt8(1, 8);
    buf[9] = 10; buf[10] = 0; buf[11] = 0;
    buf.writeFloatLE(NaN, 12);

    const result = parseChargeLog(buf);
    expect(result).toHaveLength(1);
    // kwhStart is valid, so it should be a number
    expect(result[0].kwhStart).toBe(10.0);
    expect(result[0].energy).toBeNull();
  });

  it('parses a known 16-byte record with correct field values', () => {
    const buf = Buffer.alloc(16);
    const tsMin = 29_235_360;        // some minutes-since-epoch value
    const kwhStart = 123.456;
    const userId = 42;
    const duration = 3661;           // 1h 1m 1s
    const kwhEnd = 130.789;

    buf.writeUInt32LE(tsMin, 0);
    buf.writeFloatLE(kwhStart, 4);
    buf.writeUInt8(userId, 8);
    buf[9]  = duration & 0xFF;
    buf[10] = (duration >> 8) & 0xFF;
    buf[11] = (duration >> 16) & 0xFF;
    buf.writeFloatLE(kwhEnd, 12);

    const result = parseChargeLog(buf);
    expect(result).toHaveLength(1);

    const rec = result[0];
    expect(rec.tsMin).toBe(tsMin);
    expect(rec.userId).toBe(userId);
    expect(rec.duration).toBe(duration);

    // kwhStart is rounded to 3 decimals
    const expectedKwhStart = Math.round(buf.readFloatLE(4) * 1000) / 1000;
    expect(rec.kwhStart).toBe(expectedKwhStart);

    // energy = round((kwhEnd - kwhStart) * 1000) / 1000
    const rawStart = buf.readFloatLE(4);
    const rawEnd = buf.readFloatLE(12);
    const expectedEnergy = Math.round((rawEnd - rawStart) * 1000) / 1000;
    expect(rec.energy).toBe(expectedEnergy);
  });

  it('parses multiple records from a buffer', () => {
    const buf = Buffer.alloc(32, 0);
    // Record 1
    buf.writeUInt32LE(100, 0);
    buf.writeFloatLE(5.0, 4);
    buf.writeUInt8(1, 8);
    buf[9] = 30; buf[10] = 0; buf[11] = 0;
    buf.writeFloatLE(10.0, 12);
    // Record 2
    buf.writeUInt32LE(200, 16);
    buf.writeFloatLE(15.0, 20);
    buf.writeUInt8(2, 24);
    buf[25] = 0x58; buf[26] = 0x02; buf[27] = 0x00; // duration = 600
    buf.writeFloatLE(20.0, 28);

    const result = parseChargeLog(buf);
    expect(result).toHaveLength(2);
    expect(result[0].tsMin).toBe(100);
    expect(result[0].userId).toBe(1);
    expect(result[1].tsMin).toBe(200);
    expect(result[1].userId).toBe(2);
  });

  it('reads duration as 24-bit little-endian correctly', () => {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(1, 0);
    buf.writeFloatLE(0.0, 4);
    buf.writeUInt8(0, 8);
    // duration = 0x030201 = 197121
    buf[9]  = 0x01;
    buf[10] = 0x02;
    buf[11] = 0x03;
    buf.writeFloatLE(1.0, 12);

    const result = parseChargeLog(buf);
    expect(result[0].duration).toBe(0x01 | (0x02 << 8) | (0x03 << 16));
    expect(result[0].duration).toBe(197121);
  });

  it('calculates energy correctly with rounding to 3 decimals', () => {
    const buf = Buffer.alloc(16, 0);
    buf.writeUInt32LE(1, 0);
    buf.writeFloatLE(10.0, 4);
    buf.writeUInt8(0, 8);
    buf[9] = 0; buf[10] = 0; buf[11] = 0;
    buf.writeFloatLE(10.5, 12);

    const result = parseChargeLog(buf);
    expect(result[0].energy).toBe(0.5);
  });

  it('returns empty array for buffer shorter than 16 bytes', () => {
    const buf = Buffer.alloc(15, 0xFF);
    const result = parseChargeLog(buf);
    expect(result).toEqual([]);
  });
});

const fc = require('fast-check');
const { arbChargeRecord, arbChargeBuffer } = require('./helpers');

describe('parseChargeLog – Property Tests', () => {
  /**
   * Property 1: Parse record count equals floor(bufferLength / 16)
   * For any Buffer of length L, parseChargeLog(buf) returns exactly
   * Math.floor(L / 16) records, each with fields tsMin, userId, duration, kwhStart, energy.
   *
   * **Validates: Requirements 1.1, 1.2, 1.3**
   */
  it('Property 1: record count equals floor(bufferLength / 16)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 20 }).chain(n =>
          fc.tuple(
            fc.constant(n),
            arbChargeBuffer(n),
            fc.integer({ min: 0, max: 15 })
          )
        ),
        ([n, recordBuf, extraBytes]) => {
          const tail = Buffer.alloc(extraBytes);
          const buf = Buffer.concat([recordBuf, tail]);
          const result = parseChargeLog(buf);

          // Record count must equal floor(totalLength / 16)
          expect(result).toHaveLength(Math.floor(buf.length / 16));

          // Each record must have the required fields
          for (const rec of result) {
            expect(rec).toHaveProperty('tsMin');
            expect(rec).toHaveProperty('userId');
            expect(rec).toHaveProperty('duration');
            expect(rec).toHaveProperty('kwhStart');
            expect(rec).toHaveProperty('energy');
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 2: Energy calculation correctness
   * For any 16-byte record with valid (non-NaN) floats for kwhStart and kwhEnd,
   * energy = Math.round((kwhEnd - kwhStart) * 1000) / 1000.
   * When NaN values present, energy and/or kwhStart should be null.
   *
   * **Validates: Requirements 1.5, 1.6**
   */
  it('Property 2: energy calculation correctness', () => {
    fc.assert(
      fc.property(
        arbChargeRecord({ allowNaN: true }),
        (recordBuf) => {
          const result = parseChargeLog(recordBuf);
          expect(result).toHaveLength(1);
          const rec = result[0];

          const rawStart = recordBuf.readFloatLE(4);
          const rawEnd = recordBuf.readFloatLE(12);

          if (isNaN(rawStart)) {
            expect(rec.kwhStart).toBeNull();
            expect(rec.energy).toBeNull();
          } else if (isNaN(rawEnd)) {
            expect(rec.kwhStart).not.toBeNull();
            expect(rec.energy).toBeNull();
          } else {
            const expectedEnergy = Math.round((rawEnd - rawStart) * 1000) / 1000;
            expect(rec.energy).toBe(expectedEnergy);
          }
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 3: Duration 24-bit Little-Endian parsing
   * For any 3-byte value (0-16777215) at offset 9-11,
   * duration = buf[9] | (buf[10] << 8) | (buf[11] << 16).
   *
   * **Validates: Requirements 1.7**
   */
  it('Property 3: duration 24-bit LE parsing', () => {
    fc.assert(
      fc.property(
        arbChargeRecord(),
        (recordBuf) => {
          const result = parseChargeLog(recordBuf);
          expect(result).toHaveLength(1);

          const expectedDuration =
            recordBuf[9] | (recordBuf[10] << 8) | (recordBuf[11] << 16);
          expect(result[0].duration).toBe(expectedDuration);
        }
      ),
      { numRuns: 100 }
    );
  });

  /**
   * Property 4: Parse determinism
   * For any Buffer, calling parseChargeLog twice returns identical results.
   *
   * **Validates: Requirements 1.8**
   */
  it('Property 4: parse determinism', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }).chain(n =>
          fc.tuple(arbChargeBuffer(n), fc.integer({ min: 0, max: 15 }))
        ),
        ([recordBuf, extraBytes]) => {
          const tail = Buffer.alloc(extraBytes);
          const buf = Buffer.concat([recordBuf, tail]);

          const result1 = parseChargeLog(buf);
          const result2 = parseChargeLog(buf);

          expect(result1).toEqual(result2);
        }
      ),
      { numRuns: 100 }
    );
  });
});
