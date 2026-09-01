const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { parsePNG } = require('../simplepdf');

describe('parsePNG', () => {
  // --- Tests with real PNG files ---

  const pngFiles = ['warp_logo.png', 'icon.png', 'logo.png']
    .map(f => ({ name: f, path: path.join(__dirname, '..', f) }))
    .filter(f => fs.existsSync(f.path));

  describe.each(pngFiles)('real file: $name', ({ name, path: filePath }) => {
    let result;

    beforeAll(() => {
      const data = fs.readFileSync(filePath);
      result = parsePNG(data);
    });

    it('returns an object with width, height, rgb fields', () => {
      expect(result).toHaveProperty('width');
      expect(result).toHaveProperty('height');
      expect(result).toHaveProperty('rgb');
    });

    it('width and height are positive integers', () => {
      expect(Number.isInteger(result.width)).toBe(true);
      expect(Number.isInteger(result.height)).toBe(true);
      expect(result.width).toBeGreaterThan(0);
      expect(result.height).toBeGreaterThan(0);
    });

    it('rgb is a Buffer', () => {
      expect(Buffer.isBuffer(result.rgb)).toBe(true);
    });

    it('rgb.length === width * height * 3', () => {
      expect(result.rgb.length).toBe(result.width * result.height * 3);
    });
  });

  // --- Programmatic minimal PNG for controlled testing ---

  /**
   * Creates a minimal valid PNG buffer with the given pixel data and filter type.
   * Pixels is a flat array of [R, G, B, ...] values, row by row.
   */
  function createMinimalPNG(width, height, pixels, filterType = 0) {
    // PNG signature
    const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

    // IHDR chunk: width(4) + height(4) + bitDepth(1) + colorType(1) + compression(1) + filter(1) + interlace(1) = 13 bytes
    const ihdrData = Buffer.alloc(13);
    ihdrData.writeUInt32BE(width, 0);
    ihdrData.writeUInt32BE(height, 4);
    ihdrData[8] = 8;  // bit depth
    ihdrData[9] = 2;  // color type: RGB
    ihdrData[10] = 0; // compression
    ihdrData[11] = 0; // filter method
    ihdrData[12] = 0; // interlace
    const ihdr = makeChunk('IHDR', ihdrData);

    // Build raw scanlines with filter bytes
    const rawLines = [];
    for (let y = 0; y < height; y++) {
      const filterByte = Buffer.from([filterType]);
      const rowPixels = Buffer.from(pixels.slice(y * width * 3, (y + 1) * width * 3));

      if (filterType === 0) {
        // None: raw pixels
        rawLines.push(filterByte, rowPixels);
      } else if (filterType === 1) {
        // Sub: each byte = raw - left (mod 256)
        const filtered = Buffer.alloc(width * 3);
        for (let x = 0; x < width * 3; x++) {
          const a = x >= 3 ? rowPixels[x - 3] : 0;
          filtered[x] = (rowPixels[x] - a) & 0xff;
        }
        rawLines.push(filterByte, filtered);
      } else if (filterType === 2) {
        // Up: each byte = raw - above (mod 256)
        const filtered = Buffer.alloc(width * 3);
        const prevRow = y > 0
          ? Buffer.from(pixels.slice((y - 1) * width * 3, y * width * 3))
          : Buffer.alloc(width * 3);
        for (let x = 0; x < width * 3; x++) {
          filtered[x] = (rowPixels[x] - prevRow[x]) & 0xff;
        }
        rawLines.push(filterByte, filtered);
      }
    }

    const rawData = Buffer.concat(rawLines);
    const compressed = zlib.deflateSync(rawData);
    const idat = makeChunk('IDAT', compressed);

    // IEND chunk
    const iend = makeChunk('IEND', Buffer.alloc(0));

    return Buffer.concat([signature, ihdr, idat, iend]);
  }

  function makeChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeB = Buffer.from(type, 'ascii');
    const crcInput = Buffer.concat([typeB, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, typeB, data, crc]);
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  describe('programmatic PNG - filter type 0 (None)', () => {
    const width = 2;
    const height = 2;
    // 2x2 image: red, green, blue, white
    const pixels = [
      255, 0, 0,    0, 255, 0,
      0, 0, 255,    255, 255, 255,
    ];

    it('returns correct width and height', () => {
      const png = createMinimalPNG(width, height, pixels, 0);
      const result = parsePNG(png);
      expect(result.width).toBe(2);
      expect(result.height).toBe(2);
    });

    it('rgb.length === width * height * 3', () => {
      const png = createMinimalPNG(width, height, pixels, 0);
      const result = parsePNG(png);
      expect(result.rgb.length).toBe(2 * 2 * 3);
    });

    it('rgb data matches input pixels', () => {
      const png = createMinimalPNG(width, height, pixels, 0);
      const result = parsePNG(png);
      expect([...result.rgb]).toEqual(pixels);
    });
  });

  describe('programmatic PNG - filter type 1 (Sub)', () => {
    const width = 3;
    const height = 1;
    const pixels = [10, 20, 30, 40, 50, 60, 70, 80, 90];

    it('correctly defilters Sub filter', () => {
      const png = createMinimalPNG(width, height, pixels, 1);
      const result = parsePNG(png);
      expect(result.width).toBe(3);
      expect(result.height).toBe(1);
      expect(result.rgb.length).toBe(9);
      expect([...result.rgb]).toEqual(pixels);
    });
  });

  describe('programmatic PNG - filter type 2 (Up)', () => {
    const width = 2;
    const height = 2;
    const pixels = [
      100, 150, 200,  50, 75, 100,
      110, 160, 210,  60, 85, 110,
    ];

    it('correctly defilters Up filter', () => {
      const png = createMinimalPNG(width, height, pixels, 2);
      const result = parsePNG(png);
      expect(result.width).toBe(2);
      expect(result.height).toBe(2);
      expect(result.rgb.length).toBe(2 * 2 * 3);
      expect([...result.rgb]).toEqual(pixels);
    });
  });

  describe('1x1 pixel PNG', () => {
    it('handles single pixel correctly', () => {
      const pixels = [128, 64, 32];
      const png = createMinimalPNG(1, 1, pixels, 0);
      const result = parsePNG(png);
      expect(result.width).toBe(1);
      expect(result.height).toBe(1);
      expect(result.rgb.length).toBe(3);
      expect([...result.rgb]).toEqual(pixels);
    });
  });
});
