/**
 * QR CODE ENCODER — a tiny, dependency-free QR generator (byte mode).
 * ══════════════════════════════════════════════════════════════════
 * GOLAZO renders a Solana Pay deposit QR with ZERO new packages (the brief bans
 * `npm install`). `react-native-svg` is already a guaranteed dep and draws the
 * module matrix this module produces. There is no `react-native-qrcode-svg` in
 * the tree, so we generate the matrix ourselves.
 *
 * Scope: enough of the ISO/IEC 18004 spec to encode a UTF-8 string in BYTE mode
 * at a chosen error-correction level, auto-picking the smallest version (1–40)
 * that fits. That covers Solana Pay URIs (typically 60–130 bytes) comfortably.
 *
 * Output: a square boolean matrix (`true` = dark module). The <QRCode> component
 * paints it. Everything here is pure + synchronous + web-safe.
 *
 * Implementation notes / provenance: the Galois-field tables, format/version
 * bit strings, alignment-pattern centres and capacity tables are the canonical
 * QR constants. Kept self-contained and commented so it's auditable.
 */

export type ECLevel = "L" | "M" | "Q" | "H";

// ── Galois field GF(256) with primitive polynomial 0x11d ─────────────────────
const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function initGF() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const gfMul = (a: number, b: number): number =>
  a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]];

/** Reed–Solomon generator polynomial of degree `n`. */
function rsGenerator(n: number): number[] {
  let poly = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= gfMul(poly[j]!, EXP[i]);
      next[j + 1] ^= poly[j]!;
    }
    poly = next;
  }
  return poly;
}

/** Reed–Solomon error-correction codewords for one block. */
function rsEncode(data: number[], ecLen: number): number[] {
  const gen = rsGenerator(ecLen);
  const res = new Array<number>(ecLen).fill(0);
  for (const d of data) {
    const factor = d ^ res[0]!;
    res.shift();
    res.push(0);
    if (factor !== 0) {
      for (let i = 0; i < gen.length; i++) res[i] ^= gfMul(gen[i]!, factor);
    }
  }
  return res;
}

// ── Capacity + block tables (byte-mode data codewords / EC structure) ────────
// Per version (1..40) and EC level: [ecCodewordsPerBlock, numBlocksGroup1,
// dataCwGroup1, numBlocksGroup2, dataCwGroup2]. Group2 sizes are group1+1.
// Source: ISO 18004 Table 9 (error correction characteristics).
const EC_TABLE: Record<ECLevel, number[][]> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
    [20, 4, 81, 0, 0],
    [24, 2, 92, 2, 93],
    [26, 4, 107, 0, 0],
    [30, 3, 115, 1, 116],
    [22, 5, 87, 1, 88],
    [24, 5, 98, 1, 99],
    [28, 1, 107, 5, 108],
    [30, 5, 120, 1, 121],
    [28, 3, 113, 4, 114],
    [28, 3, 107, 5, 108],
    [28, 4, 116, 4, 117],
    [28, 2, 111, 7, 112],
    [30, 4, 121, 5, 122],
    [30, 6, 117, 4, 118],
    [26, 8, 106, 4, 107],
    [28, 10, 114, 2, 115],
    [30, 8, 122, 4, 123],
    [30, 3, 117, 10, 118],
    [30, 7, 116, 7, 117],
    [30, 5, 115, 10, 116],
    [30, 13, 115, 3, 116],
    [30, 17, 115, 0, 0],
    [30, 17, 115, 1, 116],
    [30, 13, 115, 6, 116],
    [30, 12, 121, 7, 122],
    [30, 6, 121, 14, 122],
    [30, 17, 122, 4, 123],
    [30, 4, 122, 18, 123],
    [30, 20, 117, 4, 118],
    [30, 19, 118, 6, 119],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
    [30, 1, 50, 4, 51],
    [22, 6, 36, 2, 37],
    [22, 8, 37, 1, 38],
    [24, 4, 40, 5, 41],
    [24, 5, 41, 5, 42],
    [28, 7, 45, 3, 46],
    [28, 10, 46, 1, 47],
    [26, 9, 43, 4, 44],
    [26, 3, 44, 11, 45],
    [26, 3, 41, 13, 42],
    [26, 17, 42, 0, 0],
    [28, 17, 46, 0, 0],
    [28, 4, 47, 14, 48],
    [28, 6, 45, 14, 46],
    [28, 8, 47, 13, 48],
    [28, 19, 46, 4, 47],
    [28, 22, 45, 3, 46],
    [28, 3, 45, 23, 46],
    [28, 21, 45, 7, 46],
    [28, 19, 47, 10, 48],
    [28, 2, 46, 29, 47],
    [28, 10, 46, 23, 47],
    [28, 14, 46, 21, 47],
    [28, 14, 46, 23, 47],
    [28, 12, 47, 26, 48],
    [28, 6, 47, 34, 48],
    [28, 29, 46, 14, 47],
    [28, 13, 46, 32, 47],
    [28, 40, 47, 7, 48],
    [28, 18, 47, 31, 48],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
    [28, 4, 22, 4, 23],
    [26, 4, 20, 6, 21],
    [24, 8, 20, 4, 21],
    [20, 11, 16, 5, 17],
    [30, 5, 24, 7, 25],
    [24, 15, 19, 2, 20],
    [28, 1, 22, 15, 23],
    [28, 17, 22, 1, 23],
    [26, 17, 21, 4, 22],
    [30, 15, 24, 5, 25],
    [28, 17, 22, 6, 23],
    [30, 7, 24, 16, 25],
    [30, 11, 24, 14, 25],
    [30, 11, 24, 16, 25],
    [30, 7, 24, 22, 25],
    [28, 28, 22, 6, 23],
    [30, 8, 23, 26, 24],
    [30, 4, 24, 31, 25],
    [30, 1, 23, 37, 24],
    [30, 15, 24, 25, 25],
    [30, 42, 24, 1, 25],
    [30, 10, 24, 35, 25],
    [30, 29, 24, 19, 25],
    [30, 44, 24, 7, 25],
    [30, 39, 24, 14, 25],
    [30, 46, 24, 10, 25],
    [30, 49, 24, 10, 25],
    [30, 48, 24, 14, 25],
    [30, 43, 24, 22, 25],
    [30, 34, 24, 34, 25],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
    [24, 3, 12, 8, 13],
    [28, 7, 14, 4, 15],
    [22, 12, 11, 4, 12],
    [24, 11, 12, 5, 13],
    [24, 11, 12, 7, 13],
    [30, 3, 15, 13, 16],
    [28, 2, 14, 17, 15],
    [28, 2, 14, 19, 15],
    [26, 9, 13, 16, 14],
    [28, 15, 15, 10, 16],
    [30, 19, 16, 6, 17],
    [24, 34, 13, 0, 0],
    [30, 16, 15, 14, 16],
    [30, 30, 16, 2, 17],
    [30, 22, 15, 13, 16],
    [30, 33, 16, 4, 17],
    [30, 12, 15, 28, 16],
    [30, 11, 15, 31, 16],
    [30, 19, 15, 26, 16],
    [30, 23, 15, 25, 16],
    [30, 23, 15, 28, 16],
    [30, 19, 15, 35, 16],
    [30, 11, 15, 46, 16],
    [30, 59, 16, 1, 17],
    [30, 22, 15, 41, 16],
    [30, 2, 15, 64, 16],
    [30, 24, 15, 46, 16],
    [30, 42, 15, 32, 16],
    [30, 10, 15, 67, 16],
    [30, 20, 15, 61, 16],
  ],
};

/** Alignment-pattern centre coordinates per version (index = version-1). */
const ALIGN_POS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
  [6, 30, 54],
  [6, 32, 58],
  [6, 34, 62],
  [6, 26, 46, 66],
  [6, 26, 48, 70],
  [6, 26, 50, 74],
  [6, 30, 54, 78],
  [6, 30, 56, 82],
  [6, 30, 58, 86],
  [6, 34, 62, 90],
  [6, 28, 50, 72, 94],
  [6, 26, 50, 74, 98],
  [6, 30, 54, 78, 102],
  [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110],
  [6, 30, 58, 86, 114],
  [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122],
  [6, 30, 54, 78, 102, 126],
  [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134],
  [6, 34, 60, 86, 112, 138],
  [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150],
  [6, 24, 50, 76, 102, 128, 154],
  [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162],
  [6, 26, 54, 82, 110, 138, 166],
  [6, 30, 58, 86, 114, 142, 170],
];

const EC_FORMAT_BITS: Record<ECLevel, number> = {
  L: 0b01,
  M: 0b00,
  Q: 0b11,
  H: 0b10,
};

/** Total data codewords available for (version, ecLevel). */
function dataCodewords(version: number, ec: ECLevel): number {
  const [ecPerBlock, g1, dc1, g2, dc2] = EC_TABLE[ec][version - 1]!;
  return g1 * dc1 + g2 * dc2;
}

/** Smallest version (1..40) whose byte-mode capacity fits `byteLen`. */
function pickVersion(byteLen: number, ec: ECLevel): number {
  for (let v = 1; v <= 40; v++) {
    const capacity = dataCodewords(v, ec);
    const lenBits = v <= 9 ? 8 : 16; // byte-mode char-count indicator width
    // 4 mode bits + length bits + 8 bits/byte, rounded up to whole codewords.
    const needed = Math.ceil((4 + lenBits + byteLen * 8) / 8);
    if (needed <= capacity) return v;
  }
  throw new Error("QR: data too long for byte mode (max version 40).");
}

// ── Bit buffer ───────────────────────────────────────────────────────────────
class BitBuffer {
  bits: number[] = [];
  put(value: number, length: number) {
    for (let i = length - 1; i >= 0; i--) this.bits.push((value >>> i) & 1);
  }
}

/** UTF-8 encode without depending on TextEncoder (RN web parity). */
function utf8Bytes(str: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < str.length; i++) {
    let c = str.charCodeAt(i);
    if (c < 0x80) out.push(c);
    else if (c < 0x800) {
      out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      const c2 = str.charCodeAt(++i);
      c = 0x10000 + ((c & 0x3ff) << 10) + (c2 & 0x3ff);
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
    } else {
      out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return out;
}

const PAD_BYTES = [0xec, 0x11];

/** Build the final interleaved data+EC codeword stream for the symbol. */
function buildCodewords(
  bytes: number[],
  version: number,
  ec: ECLevel,
): number[] {
  const bb = new BitBuffer();
  bb.put(0b0100, 4); // byte mode
  bb.put(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) bb.put(b, 8);

  const totalData = dataCodewords(version, ec);
  const capacityBits = totalData * 8;
  // Terminator (up to 4 zero bits).
  for (let i = 0; i < 4 && bb.bits.length < capacityBits; i++) bb.bits.push(0);
  // Pad to a byte boundary.
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);

  // Pad codewords alternating 0xEC / 0x11.
  const dataCw: number[] = [];
  for (let i = 0; i < bb.bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bb.bits[i + j]!;
    dataCw.push(v);
  }
  for (let i = 0; dataCw.length < totalData; i++)
    dataCw.push(PAD_BYTES[i % 2]!);

  // Split into blocks, compute EC per block.
  const [ecPerBlock, g1, dc1, g2, dc2] = EC_TABLE[ec][version - 1]!;
  const blocks: { data: number[]; ec: number[] }[] = [];
  let offset = 0;
  for (let i = 0; i < g1; i++) {
    const data = dataCw.slice(offset, offset + dc1);
    offset += dc1;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }
  for (let i = 0; i < g2; i++) {
    const data = dataCw.slice(offset, offset + dc2);
    offset += dc2;
    blocks.push({ data, ec: rsEncode(data, ecPerBlock) });
  }

  // Interleave data codewords, then EC codewords.
  const result: number[] = [];
  const maxData = Math.max(...blocks.map((b) => b.data.length));
  for (let i = 0; i < maxData; i++)
    for (const b of blocks) if (i < b.data.length) result.push(b.data[i]!);
  for (let i = 0; i < ecPerBlock; i++)
    for (const b of blocks) result.push(b.ec[i]!);
  return result;
}

// ── Matrix construction ──────────────────────────────────────────────────────
type Grid = (boolean | null)[][];

function newGrid(size: number): Grid {
  return Array.from({ length: size }, () =>
    new Array<boolean | null>(size).fill(null),
  );
}

function placeFinder(g: Grid, r: number, c: number) {
  for (let dr = -1; dr <= 7; dr++) {
    for (let dc = -1; dc <= 7; dc++) {
      const rr = r + dr;
      const cc = c + dc;
      if (rr < 0 || cc < 0 || rr >= g.length || cc >= g.length) continue;
      const inner = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6;
      const isDark =
        inner &&
        (dr === 0 ||
          dr === 6 ||
          dc === 0 ||
          dc === 6 ||
          (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
      g[rr]![cc] = inner ? isDark : false; // separator ring = light
    }
  }
}

function placeAlignment(g: Grid, version: number) {
  const centres = ALIGN_POS[version - 1]!;
  for (const r of centres) {
    for (const c of centres) {
      // Skip ones overlapping the finder patterns.
      if (g[r]![c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const ring = Math.max(Math.abs(dr), Math.abs(dc));
          g[r + dr]![c + dc] = ring !== 1; // dark border + dark centre, light ring at 1
        }
      }
    }
  }
}

function placeTiming(g: Grid) {
  for (let i = 8; i < g.length - 8; i++) {
    if (g[6]![i] === null) g[6]![i] = i % 2 === 0;
    if (g[i]![6] === null) g[i]![6] = i % 2 === 0;
  }
}

/** Reserve format/version-info regions so data placement skips them. */
function reserveFormat(g: Grid): boolean[][] {
  const size = g.length;
  const reserved = Array.from({ length: size }, () =>
    new Array<boolean>(size).fill(false),
  );
  for (let i = 0; i < 9; i++) {
    reserved[8]![i] = true;
    reserved[i]![8] = true;
  }
  for (let i = 0; i < 8; i++) {
    reserved[8]![size - 1 - i] = true;
    reserved[size - 1 - i]![8] = true;
  }
  g[size - 8]![8] = true; // dark module (always set)
  if (size >= 45) {
    // version info blocks (v >= 7)
    for (let i = 0; i < 6; i++)
      for (let j = 0; j < 3; j++) {
        reserved[i]![size - 11 + j] = true;
        reserved[size - 11 + j]![i] = true;
      }
  }
  return reserved;
}

const MASKS: ((r: number, c: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
];

function placeData(
  g: Grid,
  reserved: boolean[][],
  codewords: number[],
  mask: number,
) {
  const size = g.length;
  const maskFn = MASKS[mask]!;
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  let col = size - 1;
  let upward = true;
  while (col > 0) {
    if (col === 6) col--; // skip the vertical timing column
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i;
      for (let dc = 0; dc < 2; dc++) {
        const c = col - dc;
        if (g[row]![c] !== null || reserved[row]![c]) continue;
        let bit = 0;
        if (bitIdx < totalBits) {
          const byte = codewords[bitIdx >> 3]!;
          bit = (byte >> (7 - (bitIdx & 7))) & 1;
          bitIdx++;
        }
        const masked = maskFn(row, c) ? bit ^ 1 : bit;
        g[row]![c] = masked === 1;
      }
    }
    upward = !upward;
    col -= 2;
  }
}

function formatBits(ec: ECLevel, mask: number): number {
  const data = (EC_FORMAT_BITS[ec] << 3) | mask;
  // BCH(15,5) remainder of (data << 10) mod the format generator.
  let bits = data << 10;
  const g = 0b10100110111;
  for (let i = 14; i >= 10; i--) if ((bits >> i) & 1) bits ^= g << (i - 10);
  // 15-bit format string = data<<10 | remainder, XOR the standard mask pattern.
  return (((data << 10) | (bits & 0x3ff)) ^ 0b101010000010010) & 0x7fff;
}

function placeFormat(g: Grid, ec: ECLevel, mask: number) {
  const size = g.length;
  const bits = formatBits(ec, mask);
  const get = (i: number) => (bits >> i) & 1;
  // Around top-left finder.
  for (let i = 0; i <= 5; i++) g[8]![i] = get(i) === 1;
  g[8]![7] = get(6) === 1;
  g[8]![8] = get(7) === 1;
  g[7]![8] = get(8) === 1;
  for (let i = 9; i <= 14; i++) g[14 - i]![8] = get(i) === 1;
  // Around the other two finders.
  for (let i = 0; i <= 7; i++) g[size - 1 - i]![8] = get(i) === 1;
  for (let i = 8; i <= 14; i++) g[8]![size - 15 + i] = get(i) === 1;
}

function versionBits(version: number): number {
  let bits = version << 12;
  const g = 0b1111100100101;
  for (let i = 17; i >= 12; i--) if ((bits >> i) & 1) bits ^= g << (i - 12);
  return (version << 12) | bits;
}

function placeVersion(g: Grid, version: number) {
  if (version < 7) return;
  const size = g.length;
  const bits = versionBits(version);
  for (let i = 0; i < 18; i++) {
    const on = ((bits >> i) & 1) === 1;
    const r = Math.floor(i / 3);
    const c = i % 3;
    g[r]![size - 11 + c] = on;
    g[size - 11 + c]![r] = on;
  }
}

// ── Mask penalty scoring (choose the lowest-penalty mask) ────────────────────
function penalty(g: Grid): number {
  const size = g.length;
  let score = 0;
  // Rule 1: runs of 5+ same-colour modules.
  for (let r = 0; r < size; r++) {
    for (const dir of [0, 1]) {
      let run = 1;
      let prev = dir === 0 ? g[r]![0] : g[0]![r];
      for (let i = 1; i < size; i++) {
        const cur = dir === 0 ? g[r]![i] : g[i]![r];
        if (cur === prev) {
          run++;
          if (run === 5) score += 3;
          else if (run > 5) score++;
        } else {
          run = 1;
          prev = cur;
        }
      }
    }
  }
  // Rule 2: 2x2 blocks.
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = g[r]![c];
      if (v === g[r]![c + 1] && v === g[r + 1]![c] && v === g[r + 1]![c + 1])
        score += 3;
    }
  // Rule 3: finder-like 1:1:3:1:1 patterns (approximate, both directions).
  const pat1 = [
    true,
    false,
    true,
    true,
    true,
    false,
    true,
    false,
    false,
    false,
    false,
  ];
  const pat2 = [
    false,
    false,
    false,
    false,
    true,
    false,
    true,
    true,
    true,
    false,
    true,
  ];
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size - 10; c++) {
      let m1 = true;
      let m2 = true;
      for (let k = 0; k < 11; k++) {
        if (g[r]![c + k] !== pat1[k]) m1 = false;
        if (g[r]![c + k] !== pat2[k]) m2 = false;
      }
      if (m1 || m2) score += 40;
      let n1 = true;
      let n2 = true;
      for (let k = 0; k < 11; k++) {
        if (g[c + k]![r] !== pat1[k]) n1 = false;
        if (g[c + k]![r] !== pat2[k]) n2 = false;
      }
      if (n1 || n2) score += 40;
    }
  // Rule 4: dark-module proportion.
  let dark = 0;
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++) if (g[r]![c]) dark++;
  const ratio = (dark * 100) / (size * size);
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
  return score;
}

/**
 * Encode `text` into a QR module matrix.
 * @returns `boolean[][]` where true = a dark module.
 */
export function encodeQR(text: string, ec: ECLevel = "M"): boolean[][] {
  const bytes = utf8Bytes(text);
  const version = pickVersion(bytes.length, ec);
  const size = version * 4 + 17;
  const codewords = buildCodewords(bytes, version, ec);

  // Build a base grid with all the function patterns (mask-independent).
  const base = newGrid(size);
  placeFinder(base, 0, 0);
  placeFinder(base, 0, size - 7);
  placeFinder(base, size - 7, 0);
  placeAlignment(base, version);
  placeTiming(base);
  const reserved = reserveFormat(base);

  // Try all 8 masks, keep the lowest penalty.
  let best: { grid: Grid; mask: number; score: number } | null = null;
  for (let mask = 0; mask < 8; mask++) {
    const g: Grid = base.map((row) => row.slice());
    placeData(g, reserved, codewords, mask);
    placeFormat(g, ec, mask);
    placeVersion(g, version);
    const filled = g.map((row) => row.map((v) => v === true));
    const score = penalty(filled);
    if (!best || score < best.score) best = { grid: g, mask, score };
  }

  return best!.grid.map((row) => row.map((v) => v === true));
}
