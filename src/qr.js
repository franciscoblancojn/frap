// Generador de códigos QR propio (sin dependencias; FRAP no usa CDN ni npm). Modo byte (UTF-8), corrección de errores
// nivel M, versión automática (1–40) y la máscara con menor penalización, según ISO/IEC 18004.
// Uso: FrapQR.matrix('https://…') → array de filas de booleanos (true = módulo oscuro), sin zona de silencio.
// Script clásico (funciona en file://): expone window.FrapQR (y module.exports para los tests en Node).
(function (root) {
  'use strict';
  // bloques de corrección por nivel (L, M, Q, H) y versión; índice 0 sin uso
  const ECC_PER_BLOCK = {
    L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };
  const NUM_BLOCKS = {
    L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };
  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  const getBit = (x, i) => ((x >>> i) & 1) !== 0;
  function rawDataModules(ver) {
    let r = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const na = Math.floor(ver / 7) + 2;
      r -= (25 * na - 10) * na - 55;
      if (ver >= 7) r -= 36;
    }
    return r;
  }
  const dataCodewords = (ver, ecl) => Math.floor(rawDataModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver];
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const size = ver * 4 + 17;
    const step = ver === 32 ? 26 : Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const out = [6];
    for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
    return out;
  }

  // ----- Reed-Solomon sobre GF(256), polinomio 0x11D -----
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11d);
      z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xff;
  }
  function rsDivisor(degree) {
    const r = new Array(degree).fill(0);
    r[degree - 1] = 1;
    let rootv = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < r.length; j++) {
        r[j] = gfMul(r[j], rootv);
        if (j + 1 < r.length) r[j] ^= r[j + 1];
      }
      rootv = gfMul(rootv, 0x02);
    }
    return r;
  }
  function rsRemainder(data, divisor) {
    const r = divisor.map(() => 0);
    for (const b of data) {
      const factor = b ^ r.shift();
      r.push(0);
      divisor.forEach((coef, i) => { r[i] ^= gfMul(coef, factor); });
    }
    return r;
  }

  function utf8(text) {
    const s = unescape(encodeURIComponent(String(text)));
    const out = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i));
    return out;
  }

  /** Matriz del QR para `text`. opts.ecl: 'L'|'M'|'Q'|'H' (por defecto M). */
  function matrix(text, opts = {}) {
    const ecl = opts.ecl && ECC_PER_BLOCK[opts.ecl] ? opts.ecl : 'M';
    const bytes = utf8(text);
    // versión mínima que entra (modo byte: 4 bits de modo + 8/16 de longitud + 8 por byte)
    let ver = 1;
    for (; ver <= 40; ver++) {
      const ccBits = ver <= 9 ? 8 : 16;
      if (4 + ccBits + bytes.length * 8 <= dataCodewords(ver, ecl) * 8) break;
    }
    if (ver > 40) throw new Error('Texto demasiado largo para un QR');
    const size = ver * 4 + 17;
    // ----- bits de datos -----
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    put(0x4, 4);
    put(bytes.length, ver <= 9 ? 8 : 16);
    for (const b of bytes) put(b, 8);
    const cap = dataCodewords(ver, ecl) * 8;
    put(0, Math.min(4, cap - bits.length));
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
    const data = [];
    for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }
    // ----- corrección de errores e intercalado -----
    const numBlocks = NUM_BLOCKS[ecl][ver];
    const eccLen = ECC_PER_BLOCK[ecl][ver];
    const rawCodewords = Math.floor(rawDataModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);
    const divisor = rsDivisor(eccLen);
    const blocks = [];
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }
    const codewords = [];
    for (let i = 0; i < blocks[0].length; i++) {
      for (let j = 0; j < blocks.length; j++) if (i !== shortLen - eccLen || j >= numShort) codewords.push(blocks[j][i]);
    }
    // ----- patrones fijos -----
    const mod = Array.from({ length: size }, () => new Array(size).fill(false));
    const fn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setF = (x, y, dark) => { mod[y][x] = dark; fn[y][x] = true; };
    for (let i = 0; i < size; i++) { setF(6, i, i % 2 === 0); setF(i, 6, i % 2 === 0); }
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
        const d = Math.max(Math.abs(dx), Math.abs(dy));
        const x = cx + dx, y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) setF(x, y, d !== 2 && d !== 4);
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
    const al = alignmentPositions(ver);
    for (let i = 0; i < al.length; i++) for (let j = 0; j < al.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setF(al[i] + dx, al[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
    const drawFormat = (mask) => {
      const d = (FORMAT_BITS[ecl] << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const b = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setF(8, i, getBit(b, i));
      setF(8, 7, getBit(b, 6)); setF(8, 8, getBit(b, 7)); setF(7, 8, getBit(b, 8));
      for (let i = 9; i < 15; i++) setF(14 - i, 8, getBit(b, i));
      for (let i = 0; i < 8; i++) setF(size - 1 - i, 8, getBit(b, i));
      for (let i = 8; i < 15; i++) setF(8, size - 15 + i, getBit(b, i));
      setF(8, size - 8, true);
    };
    drawFormat(0); // reserva el espacio (se rehace con la máscara elegida)
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
      const b = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const bit = getBit(b, i);
        const a = size - 11 + (i % 3), c = Math.floor(i / 3);
        setF(a, c, bit); setF(c, a, bit);
      }
    }
    // ----- datos en zigzag -----
    let bi = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
        const x = right - j;
        const up = ((right + 1) & 2) === 0;
        const y = up ? size - 1 - vert : vert;
        if (!fn[y][x] && bi < codewords.length * 8) { mod[y][x] = getBit(codewords[bi >>> 3], 7 - (bi & 7)); bi++; }
      }
    }
    // ----- máscara -----
    const maskFn = [
      (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
    ];
    const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x]; };
    const penalty = () => {
      let p = 0;
      const lineScore = (get) => {
        for (let a = 0; a < size; a++) {
          let run = 1;
          for (let b = 1; b < size; b++) {
            if (get(a, b) === get(a, b - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1;
          }
          // patrón parecido a un buscador: 1011101 con 4 claros a un lado
          for (let b = 0; b + 10 < size; b++) {
            const seq = []; for (let k = 0; k < 11; k++) seq.push(get(a, b + k) ? 1 : 0);
            const s = seq.join('');
            if (s === '10111010000' || s === '00001011101') p += 40;
          }
        }
      };
      lineScore((y, x) => mod[y][x]);
      lineScore((x, y) => mod[y][x]);
      for (let y = 0; y + 1 < size; y++) for (let x = 0; x + 1 < size; x++) {
        const c = mod[y][x];
        if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
      }
      let dark = 0;
      for (const row of mod) for (const c of row) if (c) dark++;
      const total = size * size;
      p += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return p;
    };
    let best = 0, bestP = Infinity;
    for (let m = 0; m < 8; m++) {
      applyMask(m); drawFormat(m);
      const p = penalty();
      if (p < bestP) { bestP = p; best = m; }
      applyMask(m); // deshace (xor)
    }
    applyMask(best);
    drawFormat(best);
    return mod;
  }

  const api = { matrix };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FrapQR = api;
})(typeof window !== 'undefined' ? window : this);
