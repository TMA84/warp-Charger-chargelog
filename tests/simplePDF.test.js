const SimplePDF = require('../simplepdf');
const fc = require('fast-check');

// ─── 9.1 Unit Tests for SimplePDF class ─────────────────────────────────────

describe('SimplePDF – Unit Tests', () => {
  let pdf;
  let output;

  beforeAll(() => {
    pdf = new SimplePDF();
    pdf.addPage();
    pdf.text('Hello World', 50, 100);
    pdf.text('Bold Text', 50, 120, { bold: true });
    pdf.rect(50, 200, 200, 50, 0xcccccc);
    pdf.line(50, 300, 250, 300);
    output = pdf.toBuffer().toString('latin1');
  });

  it('PDF header starts with %PDF-1.4', () => {
    expect(output.startsWith('%PDF-1.4')).toBe(true);
  });

  it('PDF footer ends with %%EOF', () => {
    expect(output.trimEnd().endsWith('%%EOF')).toBe(true);
  });

  it('addPage → A4 dimensions (595.28 x 841.89)', () => {
    expect(output).toContain('595.28 841.89');
  });

  it('text() → BT/ET operators', () => {
    expect(output).toContain('BT');
    expect(output).toContain('ET');
  });

  it('text with bold → /F2', () => {
    expect(output).toContain('/F2');
  });

  it('text without bold → /F1', () => {
    expect(output).toContain('/F1');
  });

  it('rect() → rectangle operator (re f)', () => {
    expect(output).toMatch(/re f/);
  });

  it('line() → line operator (m ... l S)', () => {
    expect(output).toMatch(/m .* l S/);
  });

  it('xref table and trailer with /Root', () => {
    expect(output).toContain('xref');
    expect(output).toContain('trailer');
    expect(output).toContain('/Root');
  });
});


// ─── 9.2 Property 21: SimplePDF page count consistency ──────────────────────

describe('SimplePDF – Property Tests', () => {
  /**
   * Property 21: SimplePDF page count consistency
   * For any number of pages N (1-20), a SimplePDF with N addPage() calls
   * produces a buffer containing `/Count N` in the Pages object.
   *
   * **Validates: Requirements 6.9**
   */
  it('Property 21: SimplePDF page count consistency', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        (n) => {
          const pdf = new SimplePDF();
          for (let i = 0; i < n; i++) {
            pdf.addPage();
          }
          const output = pdf.toBuffer().toString('latin1');
          expect(output).toContain(`/Count ${n}`);
        }
      ),
      { numRuns: 100 }
    );
  });
});
