const fc = require('fast-check');

/**
 * fast-check Arbitrary for a valid 16-byte Charge Record buffer.
 *
 * Layout (Little-Endian):
 *   Offset 0:  UInt32  tsMin (minutes since epoch)
 *   Offset 4:  Float32 kwhStart
 *   Offset 8:  UInt8   userId (0-255)
 *   Offset 9:  24-bit  duration (0-16777215), 3 bytes LE
 *   Offset 12: Float32 kwhEnd
 *
 * By default generates finite floats only. Pass { allowNaN: true }
 * to include NaN values for kwhStart/kwhEnd.
 */
function arbChargeRecord(opts = {}) {
  const floatArb = opts.allowNaN
    ? fc.oneof(
        fc.float({ noDefaultInfinity: true, noNaN: false }),
        fc.constant(NaN)
      )
    : fc.float({ noDefaultInfinity: true, noNaN: true });

  return fc.tuple(
    fc.integer({ min: 0, max: 0xFFFFFFFF }),  // tsMin
    floatArb,                                   // kwhStart
    fc.integer({ min: 0, max: 255 }),           // userId
    fc.integer({ min: 0, max: 0xFFFFFF }),      // duration (24-bit)
    floatArb                                    // kwhEnd
  ).map(([tsMin, kwhStart, userId, duration, kwhEnd]) => {
    const buf = Buffer.alloc(16);
    buf.writeUInt32LE(tsMin, 0);
    buf.writeFloatLE(kwhStart, 4);
    buf.writeUInt8(userId, 8);
    buf[9]  = duration & 0xFF;
    buf[10] = (duration >> 8) & 0xFF;
    buf[11] = (duration >> 16) & 0xFF;
    buf.writeFloatLE(kwhEnd, 12);
    return buf;
  });
}

/**
 * fast-check Arbitrary for a Buffer containing n valid 16-byte records.
 * Returns a Buffer of length n * 16.
 */
function arbChargeBuffer(n) {
  return fc.array(arbChargeRecord(), { minLength: n, maxLength: n })
    .map(records => Buffer.concat(records));
}

/**
 * fast-check Arbitrary for valid filter parameter objects.
 * Generates realistic combinations matching applyFilters(charges, userId, dateFrom, dateTo, month, year).
 */
function arbFilterParams() {
  const arbUserId = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.constant(''),
    fc.integer({ min: 0, max: 255 }).map(String)
  );

  const arbMonth = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.tuple(
      fc.integer({ min: 2020, max: 2030 }),
      fc.integer({ min: 1, max: 12 })
    ).map(([y, m]) => `${y}-${String(m).padStart(2, '0')}`)
  );

  const arbYear = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.integer({ min: 2020, max: 2030 }).map(String)
  );

  const arbDateStr = fc.oneof(
    fc.constant(null),
    fc.constant(undefined),
    fc.tuple(
      fc.integer({ min: 2020, max: 2030 }),
      fc.integer({ min: 1, max: 12 }),
      fc.integer({ min: 1, max: 28 })
    ).map(([y, m, d]) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`)
  );

  return fc.record({
    userId: arbUserId,
    dateFrom: arbDateStr,
    dateTo: arbDateStr,
    month: arbMonth,
    year: arbYear,
  });
}

/**
 * fast-check Arbitrary for valid company data objects.
 * Generates objects with name, street, city (all strings).
 */
function arbCompanyData() {
  const arbStr = fc.stringMatching(/^[A-Za-z0-9 .,-]{1,60}$/);

  return fc.record({
    name: arbStr,
    street: arbStr,
    city: arbStr,
  });
}

module.exports = {
  arbChargeRecord,
  arbChargeBuffer,
  arbFilterParams,
  arbCompanyData,
};
