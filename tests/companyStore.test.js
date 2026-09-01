const fs = require('fs');
const path = require('path');
const fc = require('fast-check');
const { loadCompany, saveCompany } = require('../server');
const { arbCompanyData } = require('./helpers');

const COMPANY_FILE = path.join(__dirname, '..', 'company.json');

describe('Company Store', () => {
  let originalContent;

  beforeAll(() => {
    // Save original company.json content
    try {
      originalContent = fs.readFileSync(COMPANY_FILE, 'utf8');
    } catch {
      originalContent = null;
    }
  });

  afterAll(() => {
    // Restore original company.json
    if (originalContent !== null) {
      fs.writeFileSync(COMPANY_FILE, originalContent);
    } else {
      try { fs.unlinkSync(COMPANY_FILE); } catch {}
    }
  });

  afterEach(() => {
    // Restore after each test to keep tests isolated
    if (originalContent !== null) {
      fs.writeFileSync(COMPANY_FILE, originalContent);
    } else {
      try { fs.unlinkSync(COMPANY_FILE); } catch {}
    }
  });

  // ── 12.1 Unit Tests ──────────────────────────────────────────────

  describe('saveCompany', () => {
    it('writes JSON file', () => {
      const data = { name: 'Test GmbH', street: 'Teststr. 1', city: '12345 Teststadt' };
      saveCompany(data);

      const written = JSON.parse(fs.readFileSync(COMPANY_FILE, 'utf8'));
      expect(written).toEqual(data);
    });
  });

  describe('loadCompany', () => {
    it('reads saved data', () => {
      const data = { name: 'Firma ABC', street: 'Hauptstr. 5', city: '80000 München' };
      saveCompany(data);

      const loaded = loadCompany();
      expect(loaded).toEqual(data);
    });

    it('returns fallback object when company.json is missing', () => {
      // Remove the file
      try { fs.unlinkSync(COMPANY_FILE); } catch {}

      const loaded = loadCompany();
      expect(loaded).toHaveProperty('name');
      expect(loaded).toHaveProperty('street');
      expect(loaded).toHaveProperty('city');
      expect(typeof loaded.name).toBe('string');
      expect(typeof loaded.street).toBe('string');
      expect(typeof loaded.city).toBe('string');
    });

    it('returns fallback object when company.json contains invalid JSON', () => {
      fs.writeFileSync(COMPANY_FILE, '{not valid json!!!');

      const loaded = loadCompany();
      expect(loaded).toHaveProperty('name');
      expect(loaded).toHaveProperty('street');
      expect(loaded).toHaveProperty('city');
      expect(typeof loaded.name).toBe('string');
      expect(typeof loaded.street).toBe('string');
      expect(typeof loaded.city).toBe('string');
    });
  });

  // ── 12.2 Property 22: Company data round-trip ────────────────────

  describe('Property 22: Company data round-trip', () => {
    it('saveCompany then loadCompany returns equivalent object', () => {
      /**
       * Validates: Requirements 8.4
       *
       * For any object with string fields name, street, city:
       * saveCompany(data) then loadCompany() returns equivalent object.
       */
      fc.assert(
        fc.property(arbCompanyData(), (data) => {
          saveCompany(data);
          const loaded = loadCompany();
          expect(loaded).toEqual(data);
        }),
        { numRuns: 100 }
      );
    });
  });
});
