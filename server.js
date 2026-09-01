const express = require('express');
const fs = require('fs');
const http = require('http');
const yaml = require('js-yaml');
const PDFDocument = require('./simplepdf');
const Bonjour = require('bonjour-service').Bonjour;

const app = express();
app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');
app.locals.de = (num, digits) => num.toFixed(digits).replace('.', ',');

const CONFIG = yaml.load(fs.readFileSync('config.yaml', 'utf8'));

// ── Persistent company data ──────────────────────────────────────────
const COMPANY_FILE = __dirname + '/company.json';
function loadCompany() {
  try { return JSON.parse(fs.readFileSync(COMPANY_FILE, 'utf8')); }
  catch { return CONFIG.company || { name: '', street: '', city: '' }; }
}
function saveCompany(data) {
  fs.writeFileSync(COMPANY_FILE, JSON.stringify(data, null, 2));
}

app.use(express.urlencoded({ extended: false }));

// ── mDNS Discovery (cached) ───────────────────────────────────────────

let cachedHosts = null;

function discoverWallboxes(timeoutMs = 3000) {
  return new Promise(resolve => {
    const bonjour = new Bonjour();
    const found = [];
    const browser = bonjour.find({ type: 'http' }, service => {
      if (/^warp\d*-/i.test(service.name)) {
        const addr = (service.addresses || []).find(a => !a.includes(':')) || service.host;
        found.push({ host: addr, name: service.name });
      }
    });
    setTimeout(() => {
      browser.stop();
      bonjour.destroy();
      resolve(found);
    }, timeoutMs);
  });
}

async function getWallboxHosts() {
  if (CONFIG.wallboxes && CONFIG.wallboxes.length > 0 && CONFIG.wallboxes[0].host) {
    return CONFIG.wallboxes.map(wb => wb.host);
  }
  if (cachedHosts) return cachedHosts;
  console.log('Suche Wallboxen per mDNS...');
  const found = await discoverWallboxes();
  cachedHosts = found.map(f => f.host);
  console.log(`Gefunden: ${found.map(f => `${f.name} (${f.host})`).join(', ') || 'keine'}`);
  return cachedHosts;
}

// ── WARP3 API helpers ─────────────────────────────────────────────────

function fetchJson(host, endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}/${endpoint}`, { timeout: 10000 }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error from ${host}/${endpoint}`)); }
      });
    }).on('error', reject);
  });
}

function fetchBinary(host, endpoint) {
  return new Promise((resolve, reject) => {
    http.get(`http://${host}/${endpoint}`, { timeout: 10000 }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

async function getUsers(host) {
  const cfg = await fetchJson(host, 'users/config');
  const users = {};
  for (const u of (cfg.users || [])) {
    users[u.id] = u.display_name;
  }
  return users;
}

async function getElectricityPrice(host) {
  const cfg = await fetchJson(host, 'charge_tracker/config');
  return cfg.electricity_price / 100.0;
}

function parseChargeLog(buf) {
  const charges = [];
  for (let i = 0; i + 16 <= buf.length; i += 16) {
    const tsMin = buf.readUInt32LE(i);
    const kwhStart = buf.readFloatLE(i + 4);
    const userId = buf.readUInt8(i + 8);
    const duration = buf[i + 9] | (buf[i + 10] << 8) | (buf[i + 11] << 16);
    const kwhEnd = buf.readFloatLE(i + 12);
    const energy = (isNaN(kwhStart) || isNaN(kwhEnd)) ? null : Math.round((kwhEnd - kwhStart) * 1000) / 1000;
    charges.push({
      tsMin, userId, duration,
      kwhStart: isNaN(kwhStart) ? null : Math.round(kwhStart * 1000) / 1000,
      energy
    });
  }
  return charges;
}

async function getWallboxName(host) {
  const info = await fetchJson(host, 'info/name');
  return info.name || host;
}

let dataCache = null;
let cacheTime = 0;
const CACHE_TTL = 5 * 60 * 1000; // 5 Minuten

let fetchAllData = async function(forceRefresh = false) {
  if (!forceRefresh && dataCache && (Date.now() - cacheTime < CACHE_TTL)) {
    return dataCache;
  }

  const hosts = await getWallboxHosts();

  const results = await Promise.all(hosts.map(async host => {
    const [name, users, price, buf] = await Promise.all([
      getWallboxName(host),
      getUsers(host),
      getElectricityPrice(host),
      fetchBinary(host, 'charge_tracker/charge_log'),
    ]);
    return { name, users, price, charges: parseChargeLog(buf) };
  }));

  const allCharges = [];
  const userNames = {};
  const prices = {};

  for (const r of results) {
    Object.assign(userNames, r.users);
    prices[r.name] = r.price;
    for (const c of r.charges) {
      c.wallbox = r.name;
      c.price = r.price;
      allCharges.push(c);
    }
  }

  allCharges.sort((a, b) => a.tsMin - b.tsMin);
  dataCache = { charges: allCharges, userNames, prices };
  cacheTime = Date.now();
  return dataCache;
}

// ── Helpers ───────────────────────────────────────────────────────────

function tsToDate(tsMin) {
  return tsMin ? new Date(tsMin * 60 * 1000) : null;
}

function fmtDate(d) {
  if (!d) return '–';
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mi = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${d.getUTCFullYear()} ${hh}:${mi}`;
}

function fmtDuration(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function applyFilters(charges, userId, dateFrom, dateTo, month, year) {
  let result = charges;
  if (userId !== null && userId !== undefined && userId !== '') {
    const uid = parseInt(userId);
    result = result.filter(c => c.userId === uid);
  }
  if (month) {
    const [y, m] = month.split('-').map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1)).getTime() / 60000;
    const to = new Date(Date.UTC(y, m, 1)).getTime() / 60000;
    result = result.filter(c => c.tsMin >= from && c.tsMin < to);
  } else if (year) {
    const y = parseInt(year);
    const from = new Date(Date.UTC(y, 0, 1)).getTime() / 60000;
    const to = new Date(Date.UTC(y + 1, 0, 1)).getTime() / 60000;
    result = result.filter(c => c.tsMin >= from && c.tsMin < to);
  } else {
    if (dateFrom) {
      const ts = new Date(dateFrom).getTime() / 60000;
      result = result.filter(c => c.tsMin >= ts);
    }
    if (dateTo) {
      const ts = new Date(dateTo).getTime() / 60000 + 1440;
      result = result.filter(c => c.tsMin < ts);
    }
  }
  return result;
}

function buildRows(charges, userNames) {
  return charges.map(c => {
    const cost = c.energy ? Math.round(c.energy * c.price) / 100 : 0;
    return {
      date: fmtDate(tsToDate(c.tsMin)),
      user: userNames[c.userId] || `ID ${c.userId}`,
      energy: c.energy,
      duration: fmtDuration(c.duration),
      kwhStart: c.kwhStart,
      cost: Math.round(cost * 100) / 100,
      wallbox: c.wallbox,
    };
  });
}

// ── Routes ────────────────────────────────────────────────────────────

app.get('/', async (req, res) => {
  try {
    const { charges, userNames, prices } = await fetchAllData();
    const filtered = applyFilters(charges, req.query.user, req.query.from, req.query.to, req.query.month, req.query.year);
    const rows = buildRows(filtered, userNames);
    const totalKwh = rows.reduce((s, r) => s + (r.energy || 0), 0);
    const totalCost = rows.reduce((s, r) => s + Math.round(r.cost * 100), 0) / 100;

    res.render('index', {
      users: userNames, rows, prices,
      totalKwh: Math.round(totalKwh * 1000) / 1000,
      totalCost: Math.round(totalCost * 100) / 100,
      selUser: req.query.user || '',
      selFrom: req.query.from || '',
      selTo: req.query.to || '',
      selMonth: req.query.month || '',
      selYear: req.query.year || '',
      company: loadCompany(),
      error: null
    });
  } catch (e) {
    res.render('index', {
      users: {}, rows: [], prices: {},
      totalKwh: 0, totalCost: 0,
      selUser: '', selFrom: '', selTo: '', selMonth: '', selYear: '',
      company: loadCompany(),
      error: e.message
    });
  }
});

app.post('/company', (req, res) => {
  saveCompany({ name: req.body.name || '', street: req.body.street || '', city: req.body.city || '' });
  res.redirect('/');
});

app.get('/refresh', (req, res) => {
  dataCache = null;
  cachedHosts = null;
  res.redirect(req.headers.referer || '/');
});

app.get('/pdf', async (req, res) => {
  const { charges, userNames, prices } = await fetchAllData();
  const filtered = applyFilters(charges, req.query.user, req.query.from, req.query.to, req.query.month, req.query.year);

  if (!filtered.length) return res.status(404).send('Keine Ladevorgänge gefunden');

  const priceCt = filtered[0].price;
  const company = loadCompany();
  const uid = req.query.user;
  const userLabel = (uid !== undefined && uid !== '') ? (userNames[parseInt(uid)] || `ID ${uid}`) : 'Alle Benutzer';
  const totalKwh = filtered.reduce((s, c) => s + (c.energy || 0), 0);
  const totalCost = filtered.reduce((s, c) => s + (c.energy ? Math.round(c.energy * c.price) : 0), 0) / 100;
  const multiWb = new Set(filtered.map(c => c.wallbox)).size > 1;
  const wbNames = [...new Set(filtered.map(c => c.wallbox))].join(', ');
  const now = new Date();
  const de = (n, d) => n.toFixed(d).replace('.', ',');

  let periodFrom, periodTo;
  if (req.query.month) {
    const [y, m] = req.query.month.split('-').map(Number);
    periodFrom = fmtDate(new Date(Date.UTC(y, m - 1, 1)));
    periodTo = fmtDate(new Date(Date.UTC(y, m, 1)));
  } else {
    periodFrom = req.query.from ? fmtDate(new Date(req.query.from)) : 'Aufzeichnungsbeginn';
    periodTo = req.query.to ? fmtDate(new Date(req.query.to)) : 'Aufzeichnungsende';
  }

  // Layout constants from original WARP3 firmware (pdf_charge_log.cpp)
  const PH = 841.89, ML = 42.5, MLH = 70.9, MR = 28.3, MT = 99.2, MB = 28.3;
  const LW = 595.28 - ML - MR;
  const FS = 9, LH = 13;
  const colUnit = LW / 6;
  const colX = [0, 0.8, 3.4, 4.125, 4.75, 5.575].map(f => ML + f * colUnit);
  const colW = [];
  for (let i = 0; i < 6; i++) colW.push((i < 5 ? colX[i+1] : ML + LW) - colX[i]);
  // For multi-wallbox: redistribute columns more evenly
  if (multiWb) {
    const ML = 42.5, LW = 524.5;
    const ws = [88, 78, 72, 68, 82, 62, 74]; // 7 columns = 524
    let x = ML;
    colX.length = 0; colW.length = 0;
    for (const w of ws) { colX.push(x); colW.push(w); x += w; }
  }

  const hdrs = multiWb
    ? ['Startzeit', 'Benutzer', 'Wallbox', 'Zählerstand Start', 'geladen (kWh)', 'Ladedauer', 'Kosten (€)']
    : ['Startzeit', 'Benutzer', 'Zählerstand Start', 'geladen (kWh)', 'Ladedauer', 'Kosten (€)'];
  const PAD = 6;
  const rightCols = multiWb ? new Set([3, 4, 5, 6]) : new Set([2, 3, 4, 5]);

  const ROWS_FIRST = 32, ROWS_PER = 40;
  const totalPages = filtered.length <= ROWS_FIRST ? 1 : 1 + Math.ceil((filtered.length - ROWS_FIRST) / ROWS_PER);

  const pdf = new PDFDocument();
  const path = require('path');
  const logoId = pdf.addImage(path.join(__dirname, 'warp_logo.png'));
  let pageNum = 0;
  let tableY;

  function newPage(isFirst) {
    pdf.addPage();
    pageNum++;
    // Grey header bar + logo (from original: rect 0,24 full-width h=75, logo at 42.5,43)
    pdf.rect(0, 24.2, 595.28, 75, 0x545454);
    pdf.drawImage(logoId, 42.5, 43, 300, 39);
    // Page number bottom center
    pdf.text(`Seite ${pageNum} von ${totalPages}`, 595.28 / 2 - 30, PH - MB, { size: FS });

    if (isFirst) {
      // Stats (right column area) – original position: column 3 of 6-col layout
      const sx = ML + 3.4 * (LW / 6); // 339.7pt from original
      const startY = MT + 10 + LH * 2; // 135.2pt – matches original
      let sy = startY;
      const stats = [
        `Wallbox: ${wbNames}`,
        `Exportiert am: ${fmtDate(now)}`,
        `Exportierte Benutzer: ${userLabel}`,
        `Exportierter Zeitraum: ${periodFrom} bis ${periodTo}`,
        `Gesamtenergie exportierter Ladevorgänge: ${de(totalKwh, 3)} kWh`,
      ];
      if (priceCt) stats.push(`Gesamtkosten: ${de(totalCost, 2)}€ (${de(priceCt, 2)} ct/kWh)`);
      for (const line of stats) { pdf.text(line, sx, sy, { size: FS }); sy += LH; }

      // Letterhead (left)
      if (company.name) {
        let ly = startY;
        pdf.text(company.name, MLH, ly, { size: FS, bold: true }); ly += LH;
        if (company.street) { pdf.text(company.street, MLH, ly, { size: FS }); ly += LH; }
        if (company.city) { pdf.text(company.city, MLH, ly, { size: FS }); ly += LH; }
      }

      const headerRows = Math.max(company.name ? 3 : 0, stats.length);
      tableY = startY + (headerRows + 2) * LH;
    } else {
      tableY = MT + 10;
    }

    // Table header
    hdrs.forEach((h, i) => {
      if (rightCols.has(i)) pdf.textRight(h, colX[i], tableY, colW[i] - PAD, { size: FS, bold: true });
      else pdf.text(h, colX[i], tableY, { size: FS, bold: true });
    });
    pdf.line(ML, tableY + FS - 4, ML + LW, tableY + FS - 4);
    tableY += LH + 4;
  }

  newPage(true);
  const maxY = PH - MB - LH * 2;

  filtered.sort((a, b) => a.tsMin - b.tsMin);

  for (const c of filtered) {
    if (tableY > maxY) newPage(false);

    const dt = tsToDate(c.tsMin);
    const cost = c.energy ? Math.round(c.energy * c.price) / 100 : 0;
    const vals = [
      fmtDate(dt),
      userNames[c.userId] || `ID ${c.userId}`,
    ];
    if (multiWb) vals.push(c.wallbox);
    vals.push(
      c.kwhStart !== null ? de(c.kwhStart, 3) : '-',
      c.energy !== null ? de(c.energy, 3) : '-',
      fmtDuration(c.duration),
      de(cost, 2),
    );

    vals.forEach((v, i) => {
      if (rightCols.has(i)) pdf.textRight(v, colX[i], tableY, colW[i] - PAD, { size: FS });
      else pdf.text(v, colX[i], tableY, { size: FS });
    });
    tableY += LH * 1.2;
  }

  const buf = pdf.toBuffer();
  const filename = `Ladelog-${now.toISOString().slice(0, 16).replace(/:/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buf.length);
  res.end(buf);
});

if (require.main === module) {
  const port = CONFIG.port || 3000;
  app.listen(port, () => console.log(`WARP3 Ladeabrechnung: http://localhost:${port}`));
}

module.exports = {
  parseChargeLog, applyFilters, buildRows,
  tsToDate, fmtDate, fmtDuration,
  loadCompany, saveCompany, app,
  // Exposed for testing: allows tests to override fetchAllData
  get _fetchAllData() { return fetchAllData; },
  set _fetchAllData(fn) { fetchAllData = fn; },
  _resetCache() { dataCache = null; cachedHosts = null; },
};
