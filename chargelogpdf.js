// Charge log PDF in the layout of the WARP firmware (redesign from October 2026).
// Port of Tinkerforge esp32-firmware software/src/modules/charge_tracker/pdf_charge_log.cpp
// (LGPL-2.1+), adapted to consolidated logs of several wallboxes.
//
// All vertical positions named *_T are distances from the top edge of the page (SimplePDF uses the same).

'use strict';

const path = require('path');
const SimplePDF = require('./simplepdf');

const MM = mm => mm * 72 / 25.4;

const PAGE_W = MM(210);

const MARGIN_L = MM(15);
const MARGIN_R = MM(15);
const CONTENT_W = PAGE_W - MARGIN_L - MARGIN_R;
const RIGHT_EDGE = PAGE_W - MARGIN_R;

const GRID_GAP = 10;
const COL_W = (CONTENT_W - GRID_GAP) / 2;
const RIGHT_COL_X = MARGIN_L + COL_W + GRID_GAP;

const SIZE_TITLE = 18;
const SIZE_TILE_VALUE = 14;
const SIZE_SECTION = 10;
const SIZE_TEXT = 9;
const SIZE_SMALL = 7.5;

const BAR_H = 56;
const LOGO_H = 24;

const TITLE_T = 86;
const SUBTITLE_T = 100;
const TITLE_RULE_T = 110;

const LETTERHEAD_X = MM(25); // compatible with the old layout (window envelopes)
const LETTERHEAD_W = RIGHT_COL_X - GRID_GAP - LETTERHEAD_X;
const BLOCK_T = 127;
const BLOCK_LEADING = 12;
const INFO_LABEL_GAP = 10;

const TILES_GAP_T = 13;
const TILE_H = 40;
const TILE_STRIPE_W = 3;
const TILE_PADDING = 10;

const SECTION_GAP_T = 22;
const SECTION_TABLE_GAP_T = 7;

const CONT_TITLE_T = 82;
const CONT_TABLE_T = 94;

const TABLE_HEADER_H = 22;
const HEADER_BASELINE_1 = 9.5;
const HEADER_BASELINE_2 = 18;
const ROW_H = 21;
const ROW_BASELINE_1 = 8.5;
const ROW_BASELINE_2 = 17;
const ROW_BASELINE_CENTER = 12.75;
const CELL_PADDING = 3.5;

const TABLE_LINES_PER_PAGE = 32;
const LINES_PER_OBJECT = 8; // the firmware fetches charges in blocks of 8; kept for identical page breaks

const TOTALS_H = 20;
const TOTALS_BASELINE = 13;
const NOTE_GAP = 12;
const NOTE_PADDING = 9;
const NOTE_TITLE_BASELINE = 15;
const NOTE_TEXT_BASELINE = 26;
const NOTE_LEADING = 10;
const NOTE_TEXT_X = MARGIN_L + TILE_STRIPE_W + NOTE_PADDING;
const NOTE_TEXT_W = RIGHT_EDGE - NOTE_PADDING - NOTE_TEXT_X;

const SUB_TITLE_H = 27;
const SUB_TITLE_BASELINE = 20;
const SUB_HEADER_H = TABLE_HEADER_H;
const SUB_ROW_H = 14;
const SUB_BASELINE = 10;

const CONTENT_BOTTOM_T = 798;
const FOOTER_RULE_T = 806;
const FOOTER_T = 818;

const COLOR_TEXT = 0x222222;
const COLOR_MUTED = 0x6B7280;
const COLOR_LIGHT_BG = 0xF3F4F6;
const COLOR_RULE = 0xD1D5DB;
const COLOR_WHITE = 0xFFFFFF;
const ACCENT = 0x545454; // WARP logo background

const LOGO_FILE = path.join(__dirname, 'warp_logo.png');
const LOGO_W = 269, LOGO_HEIGHT_PX = 35;

// Visible columns. Two-line cells show `top` in the text color and `bottom` muted.
const VCOL = { NUMBER: 0, TIME: 1, NAMES: 2, DURATION: 3, METER: 4, ENERGY: 5, COST: 6 };
const VISIBLE_COLUMNS = [
  { top: null,         bottom: null,       width: 28, right: true },  // charge number
  { top: 'start',      bottom: 'end',      width: 70, right: false },
  { top: 'user',       bottom: 'charger',  width: 0,  right: false }, // shares the remaining width
  { top: 'duration',   bottom: null,       width: 52, right: true },
  { top: 'meterStart', bottom: 'meterEnd', width: 72, right: true },
  { top: 'energy',     bottom: null,       width: 60, right: true },
  { top: 'cost',       bottom: null,       width: 50, right: true },
];

// Subtotal columns: name, count, duration, energy, cost → visible column they are aligned to
const VCOL_OF_SUB_COL = [VCOL.NUMBER, VCOL.METER, VCOL.DURATION, VCOL.ENERGY, VCOL.COST];

function measureNote(pdf, note) {
  // Count lines without drawing (needs a page for the API, nothing is emitted with draw=false)
  return pdf.wrapText(note, 0, 0, NOTE_TEXT_W, NOTE_LEADING, { size: SIZE_SMALL, draw: false });
}

class Layout {
  constructor(pdf, r) {
    this.r = r;
    this.tableRows = r.rows.length;
    this.vcols = r.showCost ? VISIBLE_COLUMNS.length : VISIBLE_COLUMNS.length - 1;

    // Columns
    let fixed = 0, flexible = 0;
    for (let i = 0; i < this.vcols; i++) {
      fixed += VISIBLE_COLUMNS[i].width;
      if (VISIBLE_COLUMNS[i].width === 0) flexible++;
    }
    const flexW = (CONTENT_W - fixed) / flexible;
    this.colX = [MARGIN_L];
    for (let i = 0; i < this.vcols; i++) {
      this.colX.push(this.colX[i] + (VISIBLE_COLUMNS[i].width === 0 ? flexW : VISIBLE_COLUMNS[i].width));
    }

    // Info block
    let labelW = 0;
    for (const row of r.info) labelW = Math.max(labelW, SimplePDF.measure(row.label, SIZE_TEXT));
    this.infoValueX = RIGHT_COL_X + Math.min(labelW + INFO_LABEL_GAP, COL_W / 2);

    // Vertical layout of the first page
    const blockLines = Math.max(1, r.letterhead.length, r.info.length);
    this.tilesT = BLOCK_T + (blockLines - 1) * BLOCK_LEADING + TILES_GAP_T;
    this.sectionT = this.tilesT + TILE_H + SECTION_GAP_T;
    this.firstTableT = this.sectionT + SECTION_TABLE_GAP_T;

    const fittingFirst = Math.floor((CONTENT_BOTTOM_T - this.firstTableT - TABLE_HEADER_H) / ROW_H);
    this.rowsFirstPage = Math.max(LINES_PER_OBJECT, Math.floor(fittingFirst / LINES_PER_OBJECT) * LINES_PER_OBJECT);

    // Note
    const noteLines = r.note ? measureNote(pdf, r.note) : 0;
    this.noteH = NOTE_TEXT_BASELINE + Math.max(0, noteLines - 1) * NOTE_LEADING + NOTE_PADDING;

    // Pages with charges
    let remaining = this.tableRows;
    this.rowsLastPage = Math.min(remaining, this.rowsFirstPage);
    remaining -= this.rowsLastPage;
    this.tablePages = 1;
    while (remaining > 0) {
      this.rowsLastPage = Math.min(remaining, TABLE_LINES_PER_PAGE);
      remaining -= this.rowsLastPage;
      this.tablePages++;
    }

    // If the start of the summary does not fit below the rows of the last page, move the last rows to a new page.
    this.rowsSplitPage = -1;
    const last = this.tablePages - 1;
    const space = CONTENT_BOTTOM_T - this.rowsT(last) - this.displayedRows(last) * ROW_H;
    if (space < this.summaryKeepH() && this.rowsLastPage > LINES_PER_OBJECT) {
      this.rowsSplitPage = Math.floor((this.rowsLastPage - 1) / LINES_PER_OBJECT) * LINES_PER_OBJECT;
      this.rowsLastPage -= this.rowsSplitPage;
      this.tablePages++;
    }

    this.flow = this.buildFlow();
    this.pages = Math.max(this.tablePages, ...this.flow.map(f => f.page + 1));
  }

  isFirst(page) { return page === 0; }
  tableT(page) { return this.isFirst(page) ? this.firstTableT : CONT_TABLE_T; }
  rowsT(page) { return this.tableT(page) + TABLE_HEADER_H; }

  rowsOnPage(page) {
    if (page >= this.tablePages) return 0;
    if (page === this.tablePages - 1) return this.rowsLastPage;
    if (page === this.tablePages - 2 && this.rowsSplitPage >= 0) return this.rowsSplitPage;
    return this.isFirst(page) ? this.rowsFirstPage : TABLE_LINES_PER_PAGE;
  }

  // A message is shown in place of the first row if there are no charges.
  displayedRows(page) {
    return (this.tableRows === 0 && page === 0) ? 1 : this.rowsOnPage(page);
  }

  firstRowNumber(page) {
    let n = 0;
    for (let p = 0; p < page; p++) n += this.rowsOnPage(p);
    return n;
  }

  summaryKeepH() {
    const firstTable = this.r.subtotalTables.find(t => t.rows.length > 0);
    if (firstTable) return TOTALS_H + SUB_TITLE_H + SUB_HEADER_H + SUB_ROW_H * Math.min(firstTable.rows.length, 2);
    return TOTALS_H + (this.r.note ? NOTE_GAP + this.noteH : 0);
  }

  // Elements of the summary below the table (totals, subtotal tables, note), placed on pages.
  buildFlow() {
    const items = [];
    let page = this.tablePages - 1;
    let top = this.rowsT(page) + this.displayedRows(page) * ROW_H;

    const ensureSpace = h => {
      if (top + h > CONTENT_BOTTOM_T) { page++; top = CONT_TABLE_T; }
    };
    const emit = (kind, h, extra = {}) => {
      items.push({ kind, page, top, ...extra });
      top += h;
    };

    ensureSpace(TOTALS_H);
    emit('totals', TOTALS_H);

    this.r.subtotalTables.forEach((st, table) => {
      if (st.rows.length === 0) return;
      ensureSpace(SUB_TITLE_H + SUB_HEADER_H + SUB_ROW_H * Math.min(st.rows.length, 2));
      emit('subTitle', SUB_TITLE_H, { table });
      emit('subHeader', SUB_HEADER_H, { table });
      st.rows.forEach((_, row) => {
        if (top + SUB_ROW_H > CONTENT_BOTTOM_T) {
          ensureSpace(SUB_ROW_H);
          emit('subHeader', SUB_HEADER_H, { table });
        }
        emit('subRow', SUB_ROW_H, { table, row });
      });
    });

    if (this.r.note) {
      ensureSpace(NOTE_GAP + this.noteH);
      emit('note', NOTE_GAP + this.noteH);
    }
    return items;
  }

  cellTextX(vcol) {
    return VISIBLE_COLUMNS[vcol].right ? this.colX[vcol + 1] - CELL_PADDING : this.colX[vcol] + CELL_PADDING;
  }
  cellAlign(vcol) { return VISIBLE_COLUMNS[vcol].right ? 'right' : 'left'; }
  cellMaxWidth(vcol) { return this.colX[vcol + 1] - this.colX[vcol] - 2 * CELL_PADDING; }

  // The name of a subtotal row spans the number, time and name columns.
  subCell(subCol) {
    if (subCol === 0) {
      return {
        x: this.colX[VCOL.NUMBER] + CELL_PADDING,
        align: 'left',
        maxWidth: this.colX[VCOL.DURATION] - this.colX[VCOL.NUMBER] - 2 * CELL_PADDING,
      };
    }
    const vcol = VCOL_OF_SUB_COL[subCol];
    return { x: this.cellTextX(vcol), align: this.cellAlign(vcol), maxWidth: this.cellMaxWidth(vcol) };
  }

  subCols() { return this.r.showCost ? 5 : 4; }
}

// ── Drawing ──────────────────────────────────────────────────────────

function drawFirstPageHeader(pdf, l) {
  const r = l.r;

  pdf.drawText(r.title, MARGIN_L, TITLE_T, { size: SIZE_TITLE, bold: true, color: COLOR_TEXT, maxWidth: CONTENT_W });
  pdf.drawText(r.subtitle, MARGIN_L, SUBTITLE_T, { size: SIZE_TEXT, color: COLOR_MUTED, maxWidth: CONTENT_W });
  pdf.line(MARGIN_L, TITLE_RULE_T, RIGHT_EDGE, TITLE_RULE_T, 1, ACCENT);

  // Letterhead (left column)
  r.letterhead.forEach((line, i) => {
    pdf.drawText(line, LETTERHEAD_X, BLOCK_T + i * BLOCK_LEADING, { size: SIZE_TEXT, color: COLOR_TEXT, maxWidth: LETTERHEAD_W });
  });

  // Info block (right column)
  r.info.forEach((row, i) => {
    const y = BLOCK_T + i * BLOCK_LEADING;
    pdf.drawText(row.label, RIGHT_COL_X, y, { size: SIZE_TEXT, color: COLOR_MUTED, maxWidth: l.infoValueX - RIGHT_COL_X - INFO_LABEL_GAP });
    pdf.drawText(row.value, l.infoValueX, y, { size: SIZE_TEXT, bold: !!row.bold, color: COLOR_TEXT, maxWidth: RIGHT_EDGE - l.infoValueX });
  });

  // Tiles: the first one spans the left column, the other two share the right column.
  const smallW = (COL_W - GRID_GAP) / 2;
  const tileX = [MARGIN_L, RIGHT_COL_X, RIGHT_COL_X + smallW + GRID_GAP];
  const tileW = [COL_W, smallW, smallW];
  r.tiles.forEach((tile, i) => {
    const x = tileX[i];
    const textX = x + TILE_STRIPE_W + TILE_PADDING;
    const textW = tileW[i] - TILE_STRIPE_W - 2 * TILE_PADDING;
    pdf.rect(x, l.tilesT, tileW[i], TILE_H, COLOR_LIGHT_BG);
    pdf.rect(x, l.tilesT, TILE_STRIPE_W, TILE_H, ACCENT);
    pdf.drawText(tile.label, textX, l.tilesT + 14, { size: SIZE_TEXT, color: COLOR_MUTED, maxWidth: textW });
    pdf.drawText(tile.value, textX, l.tilesT + 32, { size: SIZE_TILE_VALUE, bold: true, color: COLOR_TEXT, maxWidth: textW });
  });

  pdf.drawText(r.sectionTitle, MARGIN_L, l.sectionT, { size: SIZE_SECTION, bold: true, color: COLOR_TEXT, maxWidth: CONTENT_W });
}

function drawFollowingPageHeader(pdf, l) {
  pdf.drawText(l.r.title, MARGIN_L, CONT_TITLE_T, { size: SIZE_SECTION, bold: true, color: COLOR_TEXT, maxWidth: COL_W });
  pdf.drawText(l.r.period, RIGHT_EDGE, CONT_TITLE_T, { size: SIZE_TEXT, color: COLOR_MUTED, align: 'right', maxWidth: COL_W });
}

// Header cells are bottom-aligned. A '\n' splits a header cell into two lines.
function drawHeaderCell(pdf, cell, headerT, x, align, maxWidth) {
  const [first, second] = cell.split('\n');
  const opts = { size: SIZE_SMALL, bold: true, color: COLOR_WHITE, align, maxWidth };
  if (second !== undefined) {
    pdf.drawText(first, x, headerT + HEADER_BASELINE_1, opts);
    pdf.drawText(second, x, headerT + HEADER_BASELINE_2, opts);
  } else {
    pdf.drawText(first, x, headerT + HEADER_BASELINE_2, opts);
  }
}

function drawTableHeader(pdf, l, tableT) {
  pdf.rect(MARGIN_L, tableT, CONTENT_W, TABLE_HEADER_H, ACCENT);
  for (let vcol = 0; vcol < l.vcols; vcol++) {
    drawHeaderCell(pdf, l.r.tableHeader[vcol], tableT, l.cellTextX(vcol), l.cellAlign(vcol), l.cellMaxWidth(vcol));
  }
}

function drawRows(pdf, l, page) {
  const rowsT = l.rowsT(page);
  const first = l.firstRowNumber(page);
  const count = l.rowsOnPage(page);

  for (let i = 0; i < count; i++) {
    const charge = l.r.rows[first + i];
    const rowT = rowsT + i * ROW_H;

    for (let vcol = 0; vcol < l.vcols; vcol++) {
      const c = VISIBLE_COLUMNS[vcol];
      const x = l.cellTextX(vcol);
      const base = { size: SIZE_SMALL, align: l.cellAlign(vcol), maxWidth: l.cellMaxWidth(vcol) };

      if (c.top === null) {
        pdf.drawText(String(first + i + 1), x, rowT + ROW_BASELINE_CENTER, { ...base, color: COLOR_MUTED });
      } else if (c.bottom === null) {
        pdf.drawText(charge[c.top], x, rowT + ROW_BASELINE_CENTER, { ...base, color: COLOR_TEXT });
      } else {
        pdf.drawText(charge[c.top], x, rowT + ROW_BASELINE_1, { ...base, color: COLOR_TEXT });
        pdf.drawText(charge[c.bottom], x, rowT + ROW_BASELINE_2, { ...base, color: COLOR_MUTED });
      }
    }
  }
}

function drawFooter(pdf, l, page) {
  const label = l.r.pageLabelFormat.replace('%d', page + 1).replace('%d', l.pages);
  const labelW = SimplePDF.measure(label, SIZE_SMALL);
  pdf.line(MARGIN_L, FOOTER_RULE_T, RIGHT_EDGE, FOOTER_RULE_T, 0.5, COLOR_RULE);
  pdf.drawText(l.r.footer, MARGIN_L, FOOTER_T, { size: SIZE_SMALL, color: COLOR_MUTED, maxWidth: CONTENT_W - labelW - 20 });
  pdf.drawText(label, RIGHT_EDGE, FOOTER_T, { size: SIZE_SMALL, color: COLOR_MUTED, align: 'right' });
}

function drawTotals(pdf, l, top) {
  const t = l.r.totals;
  const y = top + TOTALS_BASELINE;
  const bold = { size: SIZE_SMALL, bold: true, color: COLOR_TEXT };

  pdf.line(MARGIN_L, top, RIGHT_EDGE, top, 1, ACCENT);
  pdf.drawText(t.label, l.colX[VCOL.NUMBER] + CELL_PADDING, y,
    { ...bold, maxWidth: l.colX[VCOL.DURATION] - l.colX[VCOL.NUMBER] - 2 * CELL_PADDING });
  pdf.drawText(t.duration, l.cellTextX(VCOL.DURATION), y, { ...bold, align: 'right', maxWidth: l.cellMaxWidth(VCOL.DURATION) });
  pdf.drawText(t.energy, l.cellTextX(VCOL.ENERGY), y, { ...bold, align: 'right', maxWidth: l.cellMaxWidth(VCOL.ENERGY) });
  if (l.r.showCost) {
    pdf.drawText(t.cost, l.cellTextX(VCOL.COST), y, { ...bold, align: 'right', maxWidth: l.cellMaxWidth(VCOL.COST) });
  }
}

function drawSubHeader(pdf, l, table, top) {
  pdf.rect(MARGIN_L, top, CONTENT_W, SUB_HEADER_H, ACCENT);
  for (let sc = 0; sc < l.subCols(); sc++) {
    const { x, align, maxWidth } = l.subCell(sc);
    drawHeaderCell(pdf, table.header[sc], top, x, align, maxWidth);
  }
}

function drawNote(pdf, l, top) {
  const noteT = top + NOTE_GAP;
  pdf.rect(MARGIN_L, noteT, CONTENT_W, l.noteH, COLOR_LIGHT_BG);
  pdf.rect(MARGIN_L, noteT, TILE_STRIPE_W, l.noteH, ACCENT);
  pdf.drawText(l.r.noteTitle, NOTE_TEXT_X, noteT + NOTE_TITLE_BASELINE, { size: SIZE_SMALL, bold: true, color: COLOR_TEXT });
  pdf.wrapText(l.r.note, NOTE_TEXT_X, noteT + NOTE_TEXT_BASELINE, NOTE_TEXT_W, NOTE_LEADING, { size: SIZE_SMALL, color: COLOR_TEXT });
}

function drawSummary(pdf, l, page) {
  for (const item of l.flow) {
    if (item.page !== page) continue;
    const table = l.r.subtotalTables[item.table];

    switch (item.kind) {
      case 'totals':
        drawTotals(pdf, l, item.top);
        break;
      case 'subTitle':
        pdf.drawText(table.title, MARGIN_L, item.top + SUB_TITLE_BASELINE,
          { size: SIZE_SECTION, bold: true, color: COLOR_TEXT, maxWidth: CONTENT_W });
        break;
      case 'subHeader':
        drawSubHeader(pdf, l, table, item.top);
        break;
      case 'subRow': {
        if (item.row % 2 === 1) pdf.rect(MARGIN_L, item.top, CONTENT_W, SUB_ROW_H, COLOR_LIGHT_BG);
        if (item.row + 1 === table.rows.length) {
          pdf.line(MARGIN_L, item.top + SUB_ROW_H, RIGHT_EDGE, item.top + SUB_ROW_H, 0.5, COLOR_RULE);
        }
        const cells = table.rows[item.row];
        for (let sc = 0; sc < l.subCols(); sc++) {
          const { x, align, maxWidth } = l.subCell(sc);
          pdf.drawText(cells[sc], x, item.top + SUB_BASELINE, { size: SIZE_SMALL, color: COLOR_TEXT, align, maxWidth });
        }
        break;
      }
      case 'note':
        drawNote(pdf, l, item.top);
        break;
    }
  }
}

function drawPage(pdf, l, page, logoId) {
  pdf.addPage();

  // Header bar with logo
  pdf.rect(0, 0, PAGE_W, BAR_H, ACCENT);
  pdf.drawImage(logoId, MARGIN_L, (BAR_H - LOGO_H) / 2, LOGO_H * LOGO_W / LOGO_HEIGHT_PX, LOGO_H);

  if (l.isFirst(page)) drawFirstPageHeader(pdf, l);
  else drawFollowingPageHeader(pdf, l);

  if (page < l.tablePages) {
    drawTableHeader(pdf, l, l.tableT(page));

    const rowsT = l.rowsT(page);
    const rows = l.displayedRows(page);

    // Zebra stripes, one per charge
    for (let i = 1; i < rows; i += 2) {
      pdf.rect(MARGIN_L, rowsT + i * ROW_H, CONTENT_W, ROW_H, COLOR_LIGHT_BG);
    }

    if (l.tableRows === 0) {
      pdf.drawText(l.r.noChargesText, MARGIN_L + CELL_PADDING, rowsT + ROW_BASELINE_CENTER,
        { size: SIZE_SMALL, color: COLOR_MUTED, maxWidth: CONTENT_W });
    }

    if (page < l.tablePages - 1) {
      const end = rowsT + rows * ROW_H;
      pdf.line(MARGIN_L, end, RIGHT_EDGE, end, 0.5, COLOR_RULE);
    }

    drawRows(pdf, l, page);
  }

  if (page >= l.tablePages - 1) drawSummary(pdf, l, page);

  drawFooter(pdf, l, page);
}

/**
 * Renders a charge log report (see buildReport in server.js) to a PDF buffer.
 */
function renderChargeLogPdf(report) {
  const pdf = new SimplePDF();
  pdf.title = report.docTitle;
  const logoId = pdf.addImage(LOGO_FILE, { background: ACCENT });

  const layout = new Layout(pdf, report);
  for (let page = 0; page < layout.pages; page++) drawPage(pdf, layout, page, logoId);

  return { buffer: pdf.toBuffer(), pages: layout.pages };
}

module.exports = { renderChargeLogPdf, Layout };
