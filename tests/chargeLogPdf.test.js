const { buildReport, fmtNum } = require('../server');
const { renderChargeLogPdf } = require('../chargelogpdf');
const SimplePDF = require('../simplepdf');

const company = { name: 'Musterfirma GmbH', street: 'Musterstraße 1', city: '12345 Musterstadt' };
const users = { 1: 'Alice', 2: 'Bob' };
const now = new Date(Date.UTC(2026, 9, 2, 12, 54));

function makeCharges(n, { wallboxes = ['warp4-aaaa'], price = 25.33 } = {}) {
  const base = Date.UTC(2026, 8, 1, 8, 0) / 60000;
  return Array.from({ length: n }, (_, i) => ({
    tsMin: base + i * 60,
    userId: (i % 2) + 1,
    duration: 3600,
    kwhStart: 1000 + i * 10,
    energy: 10,
    wallbox: wallboxes[i % wallboxes.length],
    price,
  }));
}

describe('fmtNum', () => {
  it('uses German thousands and decimal separators', () => {
    expect(fmtNum(15444.261, 3)).toBe('15.444,261');
    expect(fmtNum(0.5, 2)).toBe('0,50');
    expect(fmtNum(1234567, 0)).toBe('1.234.567');
    expect(fmtNum(null, 3)).toBe('-');
  });
});

describe('buildReport', () => {
  it('fills info block, tiles and totals like the WARP firmware', () => {
    const r = buildReport(makeCharges(3), users, { month: '2026-09' }, company, now);
    expect(r.period).toBe('01.09.2026 - 30.09.2026');
    expect(r.info.map(i => i.label)).toEqual(['Zeitraum', 'Gerät', 'Benutzer', 'Strompreis', 'Erstellt am']);
    expect(r.info[1].value).toBe('warp4-aaaa');
    expect(r.info[3].value).toBe('25,33 ct/kWh');
    expect(r.tiles.map(t => t.value)).toEqual(['30,000 kWh', '3', '7,59 €']);
    expect(r.totals).toMatchObject({ duration: '3:00:00', energy: '30,000', cost: '7,59' });
    expect(r.letterhead).toEqual(['Musterfirma GmbH', 'Musterstraße 1', '12345 Musterstadt']);
  });

  it('builds two-line rows with end time, wallbox and end meter reading', () => {
    const r = buildReport(makeCharges(1), users, {}, company, now);
    expect(r.rows[0]).toEqual({
      start: '01.09.2026 10:00', end: '01.09.2026 11:00',
      user: 'Alice', charger: 'warp4-aaaa',
      duration: '1:00:00', meterStart: '1.000,000', meterEnd: '1.010,000',
      energy: '10,000', cost: '2,53',
    });
  });

  it('shows subtotal tables only for more than one user / wallbox', () => {
    const single = buildReport(makeCharges(2).map(c => ({ ...c, userId: 1 })), users, {}, company, now);
    expect(single.subtotalTables).toEqual([]);

    const multi = buildReport(makeCharges(4, { wallboxes: ['warp4-b', 'warp4-a'] }), users, {}, company, now);
    expect(multi.subtotalTables.map(t => t.title)).toEqual(['Übersicht nach Benutzer', 'Übersicht nach Wallbox']);
    expect(multi.subtotalTables[1].rows.map(r => r[0])).toEqual(['warp4-a', 'warp4-b']);
    expect(multi.info[1]).toMatchObject({ label: 'Geräte', value: 'warp4-a, warp4-b' });
  });

  it('marks charges without meter values and mentions it in the note', () => {
    const charges = makeCharges(2);
    charges[1].energy = null;
    const r = buildReport(charges, users, {}, company, now);
    expect(r.rows[1].energy).toBe('-');
    expect(r.rows[1].cost).toBe('-');
    expect(r.note).toContain('keine gültigen Zählerstände');
  });

  it('switches the third tile to the charging time without electricity price', () => {
    const r = buildReport(makeCharges(2, { price: 0 }), users, {}, company, now);
    expect(r.showCost).toBe(false);
    expect(r.tiles[2]).toEqual({ label: 'Gesamtladedauer', value: '2:00:00 h' });
  });
});

describe('renderChargeLogPdf', () => {
  it('renders a valid single-page PDF with the new layout texts', () => {
    const { buffer, pages } = renderChargeLogPdf(buildReport(makeCharges(5), users, {}, company, now));
    const out = buffer.toString('latin1');
    expect(pages).toBe(1);
    expect(out.startsWith('%PDF-')).toBe(true);
    expect(out).toContain('/Title (WARP Ladelog)');
    for (const t of ['Ladelog', 'Erfasste Ladevorg\xe4nge', 'Summe', 'Hinweis', 'Seite 1 von 1']) {
      expect(out).toContain(t);
    }
  });

  it('breaks pages like the firmware (8-row blocks on the first page, 32 rows on following pages)', () => {
    const { pages } = renderChargeLogPdf(buildReport(makeCharges(100), users, {}, company, now));
    // first page: 24 rows, then 32 + 32, the remaining 12 + summary on page 4
    expect(pages).toBe(4);
  });
});

describe('SimplePDF.drawText', () => {
  it('truncates text with an ellipsis to fit maxWidth', () => {
    const pdf = new SimplePDF();
    pdf.addPage();
    const w = pdf.drawText('Ein sehr langer Wallbox-Name, der nicht passt', 0, 10, { size: 7.5, maxWidth: 50 });
    expect(w).toBeLessThanOrEqual(50.01);
    expect(Buffer.concat(pdf.currentPage.cmds).includes(0x85)).toBe(true);
  });
});
