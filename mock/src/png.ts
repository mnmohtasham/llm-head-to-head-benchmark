import { deflateSync } from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A small deterministic generator, so the same seed always paints the same picture. */
function random(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

/**
 * A PNG that depends only on its seed and size: a diagonal gradient between two seeded colours
 * with a few seeded circles, like a stand-in for a generated image.
 */
export function seededPng(seed: number, width: number, height: number): Buffer {
  const next = random(seed);
  const colour = () => [next() * 255, next() * 255, next() * 255] as const;
  const [a, b] = [colour(), colour()];
  const circles = Array.from({ length: 5 }, () => ({
    x: next() * width,
    y: next() * height,
    r: (0.08 + next() * 0.2) * Math.min(width, height),
    c: colour(),
  }));
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const t = (x / width + y / height) / 2;
      let rgb = [0, 1, 2].map((i) => (a[i] ?? 0) * (1 - t) + (b[i] ?? 0) * t);
      for (const circle of circles) {
        if ((x - circle.x) ** 2 + (y - circle.y) ** 2 < circle.r ** 2) rgb = [...circle.c];
      }
      const at = row + 1 + x * 3;
      raw[at] = rgb[0] ?? 0;
      raw[at + 1] = rgb[1] ?? 0;
      raw[at + 2] = rgb[2] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
