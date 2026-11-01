const express = require('express');
const fs = require('fs');
const http = require('http');
const yaml = require('js-yaml');
const { renderChargeLogPdf } = require('./chargelogpdf');
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

// The wallboxes store UTC timestamps and show them in their local time. All dates and
// filter boundaries use this time zone (config option `timezone`, default Europe/Berlin).
const TIMEZONE = CONFIG.timezone || 'Europe/Berlin';
const tzFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: TIMEZONE, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

// Wall clock time of d in TIMEZONE as { year, month, day, hour, minute } strings
function localParts(d) {
  const p = {};
  for (const { type, value } of tzFormat.formatToParts(d)) p[type] = value;
  return p;
}

// UTC offset of TIMEZONE at the given instant, in ms
function tzOffsetMs(ms) {
  const p = localParts(new Date(ms));
  const wall = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
  return wall - Math.floor(ms / 60000) * 60000;
}

// Minutes since epoch of local midnight y-m-d in TIMEZONE (month 1-based, overflow allowed)
function localDayStartMin(y, m, d) {
  const wall = Date.UTC(y, m - 1, d);
  let ms = wall - tzOffsetMs(wall);
  ms = wall - tzOffsetMs(ms); // second pass for days with a DST change
  return ms / 60000;
}

// "YYYY-MM-DD" → local midnight in minutes; other formats are parsed by Date as before
function dateInputStartMin(str, addDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(str);
  if (m) return localDayStartMin(+m[1], +m[2], +m[3] + addDays);
  return new Date(str).getTime() / 60000 + addDays * 1440;
}

function fmtDate(d) {
  if (!d) return '–';
  const p = localParts(d);
  return `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`;
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
    const from = localDayStartMin(y, m, 1);
    const to = localDayStartMin(y, m + 1, 1);
    result = result.filter(c => c.tsMin >= from && c.tsMin < to);
  } else if (year) {
    const y = parseInt(year);
    const from = localDayStartMin(y, 1, 1);
    const to = localDayStartMin(y + 1, 1, 1);
    result = result.filter(c => c.tsMin >= from && c.tsMin < to);
  } else {
    if (dateFrom) {
      const ts = dateInputStartMin(dateFrom);
      result = result.filter(c => c.tsMin >= ts);
    }
    if (dateTo) {
      const ts = dateInputStartMin(dateTo, 1);
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

// ── PDF report (layout of the WARP firmware charge log) ─────────────

// Number with German thousands and decimal separators, like format_number in the firmware.
function fmtNum(value, decimals) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '-';
  const [int, frac] = Math.abs(value).toFixed(decimals).split('.');
  const sign = value < 0 && Number(Math.abs(value).toFixed(decimals)) !== 0 ? '-' : '';
  return sign + int.replace(/\B(?=(\d{3})+(?!\d))/g, '.') + (frac ? ',' + frac : '');
}

function fmtDay(d) {
  return fmtDate(d).slice(0, 10);
}

function chargeCostCents(c) {
  return c.energy !== null && c.energy !== undefined ? Math.round(c.energy * c.price) : 0;
}

function addStats(stats, c) {
  stats.charges++;
  stats.duration += c.duration || 0;
  if (c.energy !== null && c.energy !== undefined) stats.energy += c.energy;
  stats.costCents += chargeCostCents(c);
}

function statsCells(name, s, showCost) {
  const cells = [name, fmtNum(s.charges, 0), fmtDuration(s.duration), fmtNum(s.energy, 3)];
  if (showCost) cells.push(fmtNum(s.costCents / 100, 2));
  return cells;
}

// Period shown in the report: the filter, or first charge until today if no filter is set.
function reportPeriod(query, charges, now) {
  // Last day of a range: one minute before the exclusive end, like the firmware
  const lastDay = endMin => fmtDay(tsToDate(endMin - 1));
  if (query.month) {
    const [y, m] = query.month.split('-').map(Number);
    return `${fmtDay(tsToDate(localDayStartMin(y, m, 1)))} - ${lastDay(localDayStartMin(y, m + 1, 1))}`;
  }
  if (query.year) {
    const y = parseInt(query.year);
    return `${fmtDay(tsToDate(localDayStartMin(y, 1, 1)))} - ${lastDay(localDayStartMin(y + 1, 1, 1))}`;
  }
  const known = charges.filter(c => c.tsMin).map(c => c.tsMin);
  const from = query.from ? fmtDay(tsToDate(dateInputStartMin(query.from)))
    : known.length ? fmtDay(tsToDate(Math.min(...known))) : 'Aufzeichnungsbeginn';
  const to = query.to ? lastDay(dateInputStartMin(query.to, 1)) : fmtDay(now);
  return `${from} - ${to}`;
}

/**
 * Collects all texts of the charge log PDF. Mirrors build_pdf_report in the WARP firmware
 * (charge_tracker.cpp), extended to charges of several wallboxes.
 */
function buildReport(charges, userNames, query, company, now = new Date()) {
  const userName = id => userNames[id] || `ID ${id}`;
  const sorted = [...charges].sort((a, b) => a.tsMin - b.tsMin);
  const wallboxes = [...new Set(sorted.map(c => c.wallbox))].sort((a, b) => a.localeCompare(b, 'de', { sensitivity: 'base' }));
  const prices = [...new Set(sorted.map(c => c.price))].filter(p => p);
  const showCost = prices.length > 0;
  const priceText = prices.map(p => `${fmtNum(p, 2)} ct/kWh`).join(' / ');
  const period = reportPeriod(query, sorted, now);

  // Statistics
  const total = { charges: 0, duration: 0, energy: 0, costCents: 0 };
  const byUser = new Map(), byWallbox = new Map();
  let unknownStart = 0, withoutMeter = false;
  for (const c of sorted) {
    addStats(total, c);
    for (const [map, key] of [[byUser, userName(c.userId)], [byWallbox, c.wallbox]]) {
      if (!map.has(key)) map.set(key, { charges: 0, duration: 0, energy: 0, costCents: 0 });
      addStats(map.get(key), c);
    }
    if (!c.tsMin) unknownStart++;
    if (c.energy === null || c.energy === undefined) withoutMeter = true;
  }

  // Users
  const uid = query.user;
  const usersText = (uid !== undefined && uid !== '') ? userName(parseInt(uid)) : 'Alle Benutzer';

  const info = [
    { label: 'Zeitraum', value: period, bold: true },
    { label: wallboxes.length > 1 ? 'Geräte' : 'Gerät', value: wallboxes.join(', ') },
    { label: 'Benutzer', value: usersText },
  ];
  if (showCost) info.push({ label: 'Strompreis', value: priceText });
  info.push({ label: 'Erstellt am', value: fmtDate(now) });

  const tiles = [
    { label: 'Gesamtenergie', value: `${fmtNum(total.energy, 3)} kWh` },
    { label: 'Ladevorgänge', value: fmtNum(total.charges, 0) },
    showCost
      ? { label: 'Gesamtkosten', value: `${fmtNum(total.costCents / 100, 2)} €` }
      : { label: 'Gesamtladedauer', value: `${fmtDuration(total.duration)} h` },
  ];

  const rows = sorted.map(c => {
    const valid = c.energy !== null && c.energy !== undefined;
    const known = !!c.tsMin;
    return {
      start: known ? fmtDate(tsToDate(c.tsMin)) : 'unbekannt',
      end: known ? fmtDate(tsToDate(c.tsMin + Math.floor((c.duration + 30) / 60))) : 'unbekannt',
      user: userName(c.userId),
      charger: c.wallbox,
      duration: fmtDuration(c.duration),
      meterStart: c.kwhStart !== null ? fmtNum(c.kwhStart, 3) : '-',
      meterEnd: c.kwhStart !== null && valid ? fmtNum(c.kwhStart + c.energy, 3) : '-',
      energy: valid ? fmtNum(c.energy, 3) : '-',
      cost: valid ? fmtNum(chargeCostCents(c) / 100, 2) : '-',
    };
  });

  // Subtotals, only shown if there is more than one user or wallbox
  const byName = map => [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'de', { sensitivity: 'base' }))
    .map(([name, s]) => statsCells(name, s, showCost));
  const subtotalTables = [];
  if (byUser.size > 1) {
    subtotalTables.push({
      title: 'Übersicht nach Benutzer',
      header: ['Benutzer', 'Ladevorgänge', 'Ladedauer\n(h:mm:ss)', 'Energie\n(kWh)', 'Kosten\n(€)'],
      rows: byName(byUser),
    });
  }
  if (byWallbox.size > 1) {
    subtotalTables.push({
      title: 'Übersicht nach Wallbox',
      header: ['Wallbox', 'Ladevorgänge', 'Ladedauer\n(h:mm:ss)', 'Energie\n(kWh)', 'Kosten\n(€)'],
      rows: byName(byWallbox),
    });
  }

  // Note
  let note = wallboxes.length > 1
    ? 'Dieser Bericht wurde automatisch aus den Ladelogs der oben genannten Geräte erstellt.'
    : 'Dieser Bericht wurde automatisch aus dem Ladelog des oben genannten Geräts erstellt.';
  note += ' Enthalten sind alle Ladevorgänge, die im angegebenen Zeitraum begonnen haben.';
  note += ' Die Energiemengen wurden mit MID-konformen Stromzählern gemessen.';
  note += ' Die Energie eines Ladevorgangs ergibt sich aus der Differenz der Zählerstände bei Ende und Start.';
  if (showCost) {
    note += prices.length > 1
      ? ` Die Kosten wurden mit den in den Wallboxen konfigurierten Strompreisen (${priceText}) berechnet.`
      : ` Die Kosten wurden mit dem konfigurierten Strompreis von ${priceText} berechnet.`;
  }
  if (unknownStart === 1) {
    note += ' Bei einem Ladevorgang ist die Startzeit unbekannt, da die Uhr des Geräts zu diesem Zeitpunkt nicht synchronisiert war.';
  } else if (unknownStart > 1) {
    note += ` Bei ${unknownStart} Ladevorgängen ist die Startzeit unbekannt, da die Uhr des Geräts zu diesem Zeitpunkt nicht synchronisiert war.`;
  }
  if (withoutMeter) {
    note += ' Für mindestens einen Ladevorgang liegen keine gültigen Zählerstände vor. Die Summen sind daher unvollständig.';
  }

  const letterhead = [company.name, company.street, company.city].filter(Boolean);

  return {
    docTitle: 'WARP Ladelog',
    title: 'Ladelog',
    subtitle: 'Ladenachweis der erfassten Ladevorgänge',
    period,
    letterhead,
    info,
    tiles,
    sectionTitle: 'Erfasste Ladevorgänge',
    showCost,
    tableHeader: ['Nr.', 'Start\nEnde', 'Benutzer\nWallbox', 'Ladedauer\n(h:mm:ss)',
      'Start-Zählerstand\nEnd-Zählerstand', 'Energie\n(kWh)', 'Kosten\n(€)'],
    rows,
    noChargesText: 'Im ausgewählten Zeitraum wurden keine Ladevorgänge erfasst.',
    totals: {
      label: 'Summe',
      duration: fmtDuration(total.duration),
      energy: fmtNum(total.energy, 3),
      cost: fmtNum(total.costCents / 100, 2),
    },
    subtotalTables,
    noteTitle: 'Hinweis',
    note,
    footer: `Ladelog · ${wallboxes.join(', ')} · ${CONFIG.name || 'WARP3 Ladeabrechnung'} ${CONFIG.version || ''}`.trim(),
    pageLabelFormat: 'Seite %d von %d',
  };
}

app.get('/pdf', async (req, res) => {
  const { charges, userNames } = await fetchAllData();
  const filtered = applyFilters(charges, req.query.user, req.query.from, req.query.to, req.query.month, req.query.year);

  if (!filtered.length) return res.status(404).send('Keine Ladevorgänge gefunden');

  const now = new Date();
  const report = buildReport(filtered, userNames, req.query, loadCompany(), now);
  const { buffer } = renderChargeLogPdf(report);

  const filename = `Ladelog-${now.toISOString().slice(0, 16).replace(/:/g, '-')}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', buffer.length);
  res.end(buffer);
});

if (require.main === module) {
  const port = CONFIG.port || 3000;
  app.listen(port, () => console.log(`WARP3 Ladeabrechnung: http://localhost:${port}`));
}

module.exports = {
  parseChargeLog, applyFilters, buildRows,
  tsToDate, fmtDate, fmtDuration, fmtNum, buildReport, localDayStartMin, TIMEZONE,
  loadCompany, saveCompany, app,
  // Exposed for testing: allows tests to override fetchAllData
  get _fetchAllData() { return fetchAllData; },
  set _fetchAllData(fn) { fetchAllData = fn; },
  _resetCache() { dataCache = null; cachedHosts = null; },
};
