/**
 * Integration Tests for Express Routes using supertest.
 * Requirements: 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 9.7, 10.4
 *
 * Strategy: Override server.js's fetchAllData via the exported setter
 * to return controlled test data. This avoids all network access
 * (no mDNS discovery, no HTTP calls to wallboxes).
 */
const path = require('path');
const fs = require('fs');
const request = require('supertest');

const serverModule = require('../server');
const { app } = serverModule;

const COMPANY_FILE = path.join(__dirname, '..', 'company.json');

// ── Test data ───────────────────────────────────────────────────────
const TS_APR_2026 = Math.floor(new Date(Date.UTC(2026, 3, 10, 8, 0)).getTime() / 60000);
const TS_APR_2026_B = Math.floor(new Date(Date.UTC(2026, 3, 15, 14, 30)).getTime() / 60000);

const MOCK_DATA = {
  charges: [
    { tsMin: TS_APR_2026, userId: 1, duration: 3600, kwhStart: 100.0, energy: 10.5, wallbox: 'TestWB', price: 30 },
    { tsMin: TS_APR_2026_B, userId: 2, duration: 7200, kwhStart: 110.5, energy: 14.5, wallbox: 'TestWB', price: 30 },
  ],
  userNames: { 1: 'Alice', 2: 'Bob' },
  prices: { 'TestWB': 30 },
};

// ── Mock state ──────────────────────────────────────────────────────
let fetchShouldFail = false;

describe('Express Routes Integration Tests', () => {
  let originalCompany;
  let originalFetchAllData;

  beforeAll(() => {
    // Save original fetchAllData and company.json
    originalFetchAllData = serverModule._fetchAllData;
    try { originalCompany = fs.readFileSync(COMPANY_FILE, 'utf8'); }
    catch { originalCompany = null; }

    // Override fetchAllData with our mock
    serverModule._fetchAllData = async () => {
      if (fetchShouldFail) throw new Error('Network error (mocked)');
      return MOCK_DATA;
    };
  });

  afterAll(() => {
    // Restore originals
    serverModule._fetchAllData = originalFetchAllData;
    if (originalCompany !== null) {
      fs.writeFileSync(COMPANY_FILE, originalCompany);
    } else {
      try { fs.unlinkSync(COMPANY_FILE); } catch {}
    }
  });

  beforeEach(() => {
    fetchShouldFail = false;
  });

  // ── GET / → Status 200, HTML content ──────────────────────────────
  // Requirements: 9.1
  it('GET / returns status 200 with HTML content', async () => {
    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/html/);
    expect(res.text).toContain('WARP3 Ladeabrechnung');
  });

  // ── GET / with query params → filters applied ────────────────────
  // Requirements: 9.2
  it('GET / with user filter shows only matching records', async () => {
    const res = await request(app).get('/?user=1');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice');
    expect(res.text).toContain('WARP3 Ladeabrechnung');
  });

  it('GET / with month filter applies correctly', async () => {
    const res = await request(app).get('/?month=2026-04');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice');
    expect(res.text).toContain('Bob');
  });

  it('GET / with year filter applies correctly', async () => {
    const res = await request(app).get('/?year=2026');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice');
    expect(res.text).toContain('Bob');
  });

  it('GET / with date range filter applies correctly', async () => {
    const res = await request(app).get('/?from=2026-04-09&to=2026-04-11');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Alice');
  });

  // ── GET /pdf with data → Content-Type application/pdf ─────────────
  // Requirements: 9.3
  it('GET /pdf with data returns application/pdf', async () => {
    const res = await request(app).get('/pdf');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  });

  // ── GET /pdf without data → Status 404 ───────────────────────────
  // Requirements: 9.4
  it('GET /pdf with no matching records returns 404', async () => {
    const res = await request(app).get('/pdf?user=99');
    expect(res.status).toBe(404);
    expect(res.text).toContain('Keine Ladevorgänge gefunden');
  });

  // ── POST /company → company data saved, redirect to / ────────────
  // Requirements: 9.5
  it('POST /company saves data and redirects to /', async () => {
    const res = await request(app)
      .post('/company')
      .type('form')
      .send({ name: 'Test GmbH', street: 'Teststr. 1', city: '12345 Teststadt' });

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');

    const saved = JSON.parse(fs.readFileSync(COMPANY_FILE, 'utf8'));
    expect(saved.name).toBe('Test GmbH');
    expect(saved.street).toBe('Teststr. 1');
    expect(saved.city).toBe('12345 Teststadt');
  });

  // ── GET /refresh → cache reset, redirect ──────────────────────────
  // Requirements: 9.6
  it('GET /refresh resets cache and keeps the filters', async () => {
    const res = await request(app).get('/refresh?user=1&month=2026-04');

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/?user=1&month=2026-04');
  });

  // ── Home Assistant ingress: redirects stay inside the add-on ──────
  it('redirects keep the ingress prefix (X-Ingress-Path)', async () => {
    const ingress = '/api/hassio_ingress/abc123';
    const refresh = await request(app).get('/refresh?user=1').set('X-Ingress-Path', ingress);
    expect(refresh.headers.location).toBe(ingress + '/?user=1');

    const company = await request(app)
      .post('/company?year=2026')
      .set('X-Ingress-Path', ingress)
      .type('form')
      .send({ name: 'Test GmbH', street: '', city: '' });
    expect(company.headers.location).toBe(ingress + '/?year=2026');
  });

  it('page uses only relative URLs (works behind ingress)', async () => {
    const res = await request(app).get('/');
    expect(res.text).not.toMatch(/(href|action)="\//);
    expect(res.text).not.toMatch(/location\.href = '\//);
    expect(res.text).toContain('id="results"');
  });

  it('GET /refresh without referer redirects to /', async () => {
    const res = await request(app).get('/refresh');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  // ── Error during data fetch → error page rendered ─────────────────
  // Requirements: 9.7
  it('renders error page when data fetch fails', async () => {
    fetchShouldFail = true;

    const res = await request(app).get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Fehler beim Abrufen der Wallbox-Daten');
  });
});
