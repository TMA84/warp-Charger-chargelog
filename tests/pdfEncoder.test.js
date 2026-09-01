const { toWinAnsi, escapePdf, textWidth } = require('../simplepdf');
const fc = require('fast-check');

// WinAnsi map (mirrored from simplepdf.js for property test reference)
const WIN_ANSI = {
  'ä': 0xe4, 'ö': 0xf6, 'ü': 0xfc, 'Ä': 0xc4, 'Ö': 0xd6, 'Ü': 0xdc,
  'ß': 0xdf, '€': 0x80, '–': 0x96, '—': 0x97, '°': 0xb0,
};

// ─── 8.1 Unit Tests ─────────────────────────────────────────────────────────

describe('toWinAnsi – Unit Tests', () => {
  it('Umlaute → correct WinAnsi bytes', () => {
    const buf = toWinAnsi('äöüÄÖÜß');
    expect([...buf]).toEqual([0xe4, 0xf6, 0xfc, 0xc4, 0xd6, 0xdc, 0xdf]);
  });

  it('Euro sign → 0x80', () => {
    const buf = toWinAnsi('€');
    expect([...buf]).toEqual([0x80]);
  });

  it('ASCII string → identical bytes', () => {
    const str = 'Hello';
    const buf = toWinAnsi(str);
    expect([...buf]).toEqual([...'Hello'].map(c => c.charCodeAt(0)));
  });

  it('Non-WinAnsi chars → 0x3F', () => {
    // Chinese character – not in WinAnsi and charCode > 255
    const buf = toWinAnsi('中');
    expect([...buf]).toEqual([0x3f]);
  });
});

describe('escapePdf – Unit Tests', () => {
  it('parentheses and backslash → escaped', () => {
    const input = Buffer.from([0x28, 0x29, 0x5c]); // ( ) backslash
    const escaped = escapePdf(input);
    expect([...escaped]).toEqual([0x5c, 0x28, 0x5c, 0x29, 0x5c, 0x5c]);
  });

  it('plain bytes → unchanged', () => {
    const input = Buffer.from([0x41, 0x42, 0x43]); // ABC
    const escaped = escapePdf(input);
    expect([...escaped]).toEqual([0x41, 0x42, 0x43]);
  });
});

describe('textWidth – Unit Tests', () => {
  it('empty string → width 0', () => {
    expect(textWidth('', 12)).toBe(0);
  });

  it('known character width', () => {
    // 'A' has Helvetica width 667, at size 10 → 667 * 10 / 1000 = 6.67
    expect(textWidth('A', 10)).toBeCloseTo(6.67, 2);
  });
});

// ─── 8.2 Property 18: toWinAnsi character mapping ──────────────────────────

describe('toWinAnsi – Property Tests', () => {
  /**
   * Property 18: toWinAnsi character mapping
   * WinAnsi map entries → defined byte value, ASCII (0-255) → char code, others → 0x3F
   *
   * **Validates: Requirements 5.3, 5.4**
   */
  it('Property 18: toWinAnsi character mapping', () => {
    const winAnsiChars = Object.keys(WIN_ANSI);

    fc.assert(
      fc.property(
        fc.string({ minLength: 0, maxLength: 50 }),
        (str) => {
          const buf = toWinAnsi(str);
          const chars = [...str];
          expect(buf.length).toBe(chars.length);

          for (let i = 0; i < chars.length; i++) {
            const ch = chars[i];
            if (WIN_ANSI[ch] !== undefined) {
              expect(buf[i]).toBe(WIN_ANSI[ch]);
            } else {
              const code = ch.charCodeAt(0);
              if (code < 256) {
                expect(buf[i]).toBe(code);
              } else {
                expect(buf[i]).toBe(0x3f);
              }
            }
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── 8.3 Property 19: escapePdf correctness ────────────────────────────────

describe('escapePdf – Property Tests', () => {
  /**
   * Property 19: escapePdf correctness
   * Bytes 0x28, 0x29, 0x5C get backslash-escaped, all others unchanged
   *
   * **Validates: Requirements 5.5, 5.6**
   */
  it('Property 19: escapePdf correctness', () => {
    const SPECIAL = new Set([0x28, 0x29, 0x5c]);

    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 255 }), { minLength: 0, maxLength: 100 }),
        (bytes) => {
          const input = Buffer.from(bytes);
          const escaped = escapePdf(input);

          // Build expected output
          const expected = [];
          for (const b of bytes) {
            if (SPECIAL.has(b)) {
              expected.push(0x5c, b);
            } else {
              expected.push(b);
            }
          }

          expect([...escaped]).toEqual(expected);
        }
      ),
      { numRuns: 100 }
    );
  });
});

// ─── 8.4 Property 20: textWidth additivity and non-negativity ───────────────

describe('textWidth – Property Tests', () => {
  /**
   * Property 20: textWidth additivity and non-negativity
   * textWidth(a + b, size) === textWidth(a, size) + textWidth(b, size)
   * For non-empty strings with size > 0: textWidth > 0
   *
   * **Validates: Requirements 5.7, 5.8, 5.9**
   */
  it('Property 20: textWidth additivity and non-negativity', () => {
    // Restrict to printable ASCII to stay within HELV_WIDTHS keys
    const arbPrintable = fc.array(
      fc.integer({ min: 32, max: 126 }),
      { minLength: 0, maxLength: 30 }
    ).map(codes => String.fromCharCode(...codes));

    fc.assert(
      fc.property(
        arbPrintable,
        arbPrintable,
        fc.double({ min: 0, max: 200, noNaN: true, noDefaultInfinity: true }),
        (a, b, size) => {
          const wAB = textWidth(a + b, size);
          const wA = textWidth(a, size);
          const wB = textWidth(b, size);

          // Additivity (use tolerance for floating point)
          expect(wAB).toBeCloseTo(wA + wB, 10);

          // Non-negativity
          expect(wAB).toBeGreaterThanOrEqual(0);

          // Positive for non-empty strings with size > 0
          if ((a + b).length > 0 && size > 0) {
            expect(wAB).toBeGreaterThan(0);
          }
        }
      ),
      { numRuns: 100 }
    );
  });
});
