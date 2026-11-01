// Minimal PDF generator for charge log tables
// Generates valid PDF 1.4 with Helvetica font, no external dependencies

// WinAnsiEncoding map for common non-ASCII chars
const WIN_ANSI = {
  'ä': 0xe4, 'ö': 0xf6, 'ü': 0xfc, 'Ä': 0xc4, 'Ö': 0xd6, 'Ü': 0xdc,
  'ß': 0xdf, '€': 0x80, '–': 0x96, '—': 0x97, '°': 0xb0,
  '…': 0x85, '‚': 0x82, '„': 0x84, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '•': 0x95,
};

function toWinAnsi(str) {
  const buf = [];
  for (const ch of str) {
    const code = WIN_ANSI[ch];
    if (code !== undefined) buf.push(code);
    else {
      const c = ch.charCodeAt(0);
      buf.push(c < 256 ? c : 63); // '?' for unmapped
    }
  }
  return Buffer.from(buf);
}

function escapePdf(buf) {
  const out = [];
  for (const b of buf) {
    if (b === 0x28) out.push(0x5c, 0x28);      // \(
    else if (b === 0x29) out.push(0x5c, 0x29);  // \)
    else if (b === 0x5c) out.push(0x5c, 0x5c);  // \\
    else out.push(b);
  }
  return Buffer.from(out);
}

// Helvetica character widths (per 1000 units of font size) - standard PDF metrics
const HELV_WIDTHS = {' ':278,'!':278,'"':355,'#':556,'$':556,'%':889,'&':667,'\'':191,'(':333,')':333,'*':389,'+':584,',':278,'-':333,'.':278,'/':278,'0':556,'1':556,'2':556,'3':556,'4':556,'5':556,'6':556,'7':556,'8':556,'9':556,':':278,';':278,'<':584,'=':584,'>':584,'?':556,'@':1015,'A':667,'B':667,'C':722,'D':722,'E':667,'F':611,'G':778,'H':722,'I':278,'J':500,'K':667,'L':556,'M':833,'N':722,'O':778,'P':667,'Q':778,'R':722,'S':667,'T':611,'U':722,'V':667,'W':944,'X':667,'Y':667,'Z':611,'[':278,'\\':278,']':278,'^':469,'_':556,'`':333,'a':556,'b':556,'c':500,'d':556,'e':556,'f':278,'g':556,'h':556,'i':222,'j':222,'k':500,'l':222,'m':833,'n':556,'o':556,'p':556,'q':556,'r':333,'s':500,'t':278,'u':556,'v':500,'w':722,'x':500,'y':500,'z':500};

const FONTS = require('./pdffonts');

// Width of WinAnsi-encoded bytes in points, using the exact Helvetica metrics.
function encodedWidth(buf, size, bold) {
  const widths = bold ? FONTS.HELVETICA_BOLD_WIDTHS : FONTS.HELVETICA_WIDTHS;
  let w = 0;
  for (const b of buf) w += widths[b];
  return w * size / 1000;
}

// Side bearing (advance box to ink) in points. Digits all use the bearing of '0',
// so numbers in a column line up digit by digit (same as the WARP firmware).
function sideBearing(byte, size, bold, right) {
  const c = (byte >= 0x30 && byte <= 0x39) ? 0x30 : byte;
  const table = bold
    ? (right ? FONTS.HELVETICA_BOLD_RSB : FONTS.HELVETICA_BOLD_LSB)
    : (right ? FONTS.HELVETICA_RSB : FONTS.HELVETICA_LSB);
  return table[c] * size / 1000;
}

function measure(str, size, bold = false) {
  return encodedWidth(toWinAnsi(String(str)), size, bold);
}

function colorOp(color, op) {
  const r = ((color >> 16) & 0xff) / 255;
  const g = ((color >> 8) & 0xff) / 255;
  const b = (color & 0xff) / 255;
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} ${op}`;
}

function textWidth(str, size) {
  let w = 0;
  for (const ch of String(str)) {
    w += (HELV_WIDTHS[ch] || 556);
  }
  return w * size / 1000;
}

class SimplePDF {
  constructor() {
    this.pages = [];
    this.currentPage = null;
    this.images = []; // {data, background}
    this.title = null;
  }

  addPage() {
    this.currentPage = { cmds: [] };
    this.pages.push(this.currentPage);
  }

  text(str, x, y, opts = {}) {
    const font = (opts.bold) ? '/F2' : '/F1';
    const size = opts.size || 9;
    const pdfY = 841.89 - y;
    const escaped = escapePdf(toWinAnsi(String(str)));
    this.currentPage.cmds.push(
      Buffer.from(`BT ${font} ${size} Tf ${x.toFixed(2)} ${pdfY.toFixed(2)} Td (`),
      escaped,
      Buffer.from(`) Tj ET\n`)
    );
  }

  // Draws text at baseline y (distance from the top edge) like pdf_stream_text in the WARP firmware:
  // opts.align 'left' | 'right' | 'center', opts.maxWidth truncates with an ellipsis,
  // left/right alignment puts the ink (not the advance box) at x.
  drawText(str, x, y, opts = {}) {
    const size = opts.size || 9;
    const bold = !!opts.bold;
    const color = opts.color || 0;
    const align = opts.align || 'left';
    const widths = bold ? FONTS.HELVETICA_BOLD_WIDTHS : FONTS.HELVETICA_WIDTHS;

    let buf = [...toWinAnsi(String(str))];
    let width = encodedWidth(buf, size, bold);

    if (opts.maxWidth > 0 && width > opts.maxWidth + 0.01) {
      const ellipsis = widths[0x85] * size / 1000;
      while (buf.length > 0 && (width + ellipsis > opts.maxWidth || buf[buf.length - 1] === 0x20)) {
        width -= widths[buf.pop()] * size / 1000;
      }
      buf.push(0x85);
      width += ellipsis;
    }

    if (align === 'right') {
      x -= width - (buf.length ? sideBearing(buf[buf.length - 1], size, bold, true) : 0);
    } else if (align === 'center') {
      x -= width / 2;
    } else if (buf.length) {
      x -= sideBearing(buf[0], size, bold, false);
    }

    const font = bold ? '/F2' : '/F1';
    const pdfY = 841.89 - y;
    this.currentPage.cmds.push(
      Buffer.from(`BT ${colorOp(color, 'rg')} ${font} ${size} Tf ${x.toFixed(2)} ${pdfY.toFixed(2)} Td (`),
      escapePdf(Buffer.from(buf)),
      Buffer.from(`) Tj ET\n`)
    );
    return width;
  }

  // Word wrap like pdf_stream_text_wrap in the WARP firmware. Returns the number of lines.
  // With opts.draw === false only the lines are counted.
  wrapText(str, x, y, width, leading, opts = {}) {
    const size = opts.size || 9;
    const bold = !!opts.bold;
    const widths = bold ? FONTS.HELVETICA_BOLD_WIDTHS : FONTS.HELVETICA_WIDTHS;
    const buf = [...toWinAnsi(String(str))];
    let lines = 0;
    let start = 0;

    while (start < buf.length) {
      while (start < buf.length && buf[start] === 0x20) start++;
      let lineWidth = 0;
      let lastSpace = -1;
      let i = start;
      for (; i < buf.length && buf[i] !== 0x0a; i++) {
        const cw = widths[buf[i]] * size / 1000;
        if (lineWidth + cw > width && i > start) break;
        if (buf[i] === 0x20) lastSpace = i;
        lineWidth += cw;
      }

      let end, next;
      if (i >= buf.length || buf[i] === 0x0a) { end = i; next = i + 1; }
      else if (lastSpace >= 0) { end = lastSpace; next = lastSpace + 1; }
      else { end = i; next = i; }

      if (opts.draw !== false && end > start) {
        const line = Buffer.from(buf.slice(start, end));
        const lx = x - sideBearing(line[0], size, bold, false);
        this.currentPage.cmds.push(
          Buffer.from(`BT ${colorOp(opts.color || 0, 'rg')} ${bold ? '/F2' : '/F1'} ${size} Tf ${lx.toFixed(2)} ${(841.89 - y - lines * leading).toFixed(2)} Td (`),
          escapePdf(line),
          Buffer.from(`) Tj ET\n`)
        );
      }
      lines++;
      start = next;
    }
    return lines;
  }

  textRight(str, x, y, w, opts = {}) {
    const size = opts.size || 9;
    const strW = textWidth(str, size);
    this.text(str, x + w - strW, y, opts);
  }

  rect(x, y, w, h, fillColor) {
    const PH = 841.89;
    const r = ((fillColor >> 16) & 0xff) / 255;
    const g = ((fillColor >> 8) & 0xff) / 255;
    const b = (fillColor & 0xff) / 255;
    this.currentPage.cmds.push(
      Buffer.from(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg ${x.toFixed(2)} ${(PH-y-h).toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f\n`)
    );
  }

  // opts.background: RGB color the alpha channel is composited onto (e.g. the header bar color).
  addImage(pngPath, opts = {}) {
    const data = require('fs').readFileSync(pngPath);
    const id = this.images.length;
    this.images.push({ data, background: opts.background });
    return id;
  }

  drawImage(imgId, x, y, w, h) {
    const PH = 841.89;
    const name = `Im${imgId}`;
    this.currentPage.cmds.push(
      Buffer.from(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${(PH-y-h).toFixed(2)} cm /${name} Do Q\n`)
    );
  }

  line(x1, y1, x2, y2, width = 0.5, color = 0) {
    const PH = 841.89;
    this.currentPage.cmds.push(
      Buffer.from(`${colorOp(color, 'RG')} ${width} w ${x1.toFixed(2)} ${(PH-y1).toFixed(2)} m ${x2.toFixed(2)} ${(PH-y2).toFixed(2)} l S\n`)
    );
  }

  toBuffer() {
    const objs = [];
    const addObj = (buf) => { objs.push(buf); return objs.length; };

    // 1: Catalog
    addObj(Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'));
    // 2: Pages placeholder
    addObj(null);
    // 3: Helvetica
    addObj(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>'));
    // 4: Helvetica-Bold
    addObj(Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>'));

    // Add image XObjects
    const imgObjIds = [];
    for (const img of this.images) {
      // Parse PNG to get dimensions and raw image data
      const png = parsePNG(img.data, img.background);
      const packed = require('zlib').deflateSync(png.rgb);
      const imgStream = Buffer.concat([
        Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${png.width} /Height ${png.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${packed.length} >>\nstream\n`),
        packed,
        Buffer.from('\nendstream')
      ]);
      imgObjIds.push(addObj(imgStream));
    }

    const pageObjIds = [];
    for (const page of this.pages) {
      const streamBody = Buffer.concat(page.cmds);
      const streamObj = Buffer.concat([
        Buffer.from(`<< /Length ${streamBody.length} >>\nstream\n`),
        streamBody,
        Buffer.from('endstream')
      ]);
      const contentId = addObj(streamObj);

      let xobjStr = '';
      if (imgObjIds.length > 0) {
        xobjStr = ' /XObject << ' + imgObjIds.map((id, i) => `/Im${i} ${id} 0 R`).join(' ') + ' >>';
      }
      const pageObj = Buffer.from(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjStr} >> >>`);
      const pageId = addObj(pageObj);
      pageObjIds.push(pageId);
    }

    objs[1] = Buffer.from(`<< /Type /Pages /Kids [${pageObjIds.map(id => `${id} 0 R`).join(' ')}] /Count ${this.pages.length} >>`);

    const parts = [Buffer.from('%PDF-1.4\n')];
    const offsets = [];
    let pos = parts[0].length;

    for (let i = 0; i < objs.length; i++) {
      const header = Buffer.from(`${i + 1} 0 obj\n`);
      const footer = Buffer.from('\nendobj\n');
      offsets.push(pos);
      parts.push(header, objs[i], footer);
      pos += header.length + objs[i].length + footer.length;
    }

    let info = '';
    if (this.title) {
      const t = Buffer.concat([Buffer.from('<< /Title ('), escapePdf(toWinAnsi(this.title)), Buffer.from(') >>')]);
      const infoId = objs.length + 1;
      const header = Buffer.from(`${infoId} 0 obj\n`);
      const footer = Buffer.from('\nendobj\n');
      parts.push(header, t, footer);
      offsets.push(pos);
      pos += header.length + t.length + footer.length;
      objs.push(t);
      info = ` /Info ${infoId} 0 R`;
    }

    const xrefOffset = pos;
    let xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
    for (const off of offsets) {
      xref += `${String(off).padStart(10, '0')} 00000 n \n`;
    }
    xref += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R${info} >>\nstartxref\n${xrefOffset}\n%%EOF`;
    parts.push(Buffer.from(xref));

    return Buffer.concat(parts);
  }
}

// Minimal PNG parser – extracts width, height, and raw RGB data
// background (optional, 0xRRGGBB): composite RGBA pixels onto this color instead of dropping alpha.
function parsePNG(data, background) {
  // PNG signature check
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  let pos = 8;
  let width, height, bitDepth, colorType;
  const idatChunks = [];

  while (pos < data.length) {
    const len = data.readUInt32BE(pos);
    const type = data.toString('ascii', pos + 4, pos + 8);
    const chunkData = data.slice(pos + 8, pos + 8 + len);

    if (type === 'IHDR') {
      width = chunkData.readUInt32BE(0);
      height = chunkData.readUInt32BE(4);
      bitDepth = chunkData[8];
      colorType = chunkData[9];
    } else if (type === 'IDAT') {
      idatChunks.push(chunkData);
    } else if (type === 'IEND') break;

    pos += 12 + len;
  }

  const zlib = require('zlib');
  const compressed = Buffer.concat(idatChunks);
  const raw = zlib.inflateSync(compressed);

  // Defilter and extract RGB
  const bpp = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 3 ? 1 : 1;
  const stride = width * bpp + 1; // +1 for filter byte
  const rgb = Buffer.alloc(width * height * 3);

  let prevRow = Buffer.alloc(width * bpp);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    const row = Buffer.alloc(width * bpp);
    for (let x = 0; x < width * bpp; x++) {
      const val = raw[y * stride + 1 + x];
      const a = x >= bpp ? row[x - bpp] : 0;
      const b = prevRow[x];
      const c = x >= bpp ? prevRow[x - bpp] : 0;
      if (filter === 0) row[x] = val;
      else if (filter === 1) row[x] = (val + a) & 0xff;
      else if (filter === 2) row[x] = (val + b) & 0xff;
      else if (filter === 3) row[x] = (val + ((a + b) >> 1)) & 0xff;
      else if (filter === 4) { // Paeth
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        row[x] = (val + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 0xff;
      }
    }
    for (let x = 0; x < width; x++) {
      if (bpp >= 3) {
        let r = row[x * bpp], g = row[x * bpp + 1], b = row[x * bpp + 2];
        if (bpp === 4 && background !== undefined) {
          const a = row[x * bpp + 3] / 255;
          r = Math.round(r * a + ((background >> 16) & 0xff) * (1 - a));
          g = Math.round(g * a + ((background >> 8) & 0xff) * (1 - a));
          b = Math.round(b * a + (background & 0xff) * (1 - a));
        }
        rgb[(y * width + x) * 3] = r;
        rgb[(y * width + x) * 3 + 1] = g;
        rgb[(y * width + x) * 3 + 2] = b;
      }
    }
    prevRow = row;
  }

  return { width, height, rgb };
}

module.exports = SimplePDF;
module.exports.toWinAnsi = toWinAnsi;
module.exports.escapePdf = escapePdf;
module.exports.textWidth = textWidth;
module.exports.parsePNG = parsePNG;
module.exports.measure = measure;
