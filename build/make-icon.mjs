// Genera el icono de la app a partir del pixel art de abajo.
// Node solo: nada de dependencias de imagen. Correr con `node build/make-icon.mjs`.
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Un monitor con cara y el destello arriba. 16x16 para que cada pixel sea
// deliberado y siga leyendose a 16px en la barra de tareas.
const ART = [
  '....S...........',
  '....S......S....',
  '..SSSSS...SSS...',
  '....S......S....',
  '........S.......',
  '.##############.',
  '.##############.',
  '.####o####o####.',
  '.####o####o####.',
  '.####o####o####.',
  '.##############.',
  '.##############.',
  '.......##.......',
  '.......##.......',
  '....########....',
  '................'
];

const COLORS = {
  '.': [0, 0, 0, 0],
  S: [56, 189, 248, 255], // destello celeste
  '#': [37, 99, 235, 255], // cuerpo azul
  o: [8, 15, 35, 255] // ojos
};

function crcTable() {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const TABLE = crcTable();

function crc32(buf) {
  let c = -1;
  for (const b of buf) c = TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** PNG RGBA sin filtros: el pixel art no comprime mejor con ellos. */
function png(size) {
  const scale = size / ART.length;
  const rows = [];
  for (let y = 0; y < size; y++) {
    const line = Buffer.alloc(1 + size * 4); // byte 0 = filtro "none"
    const art = ART[Math.floor(y / scale)];
    for (let x = 0; x < size; x++) {
      const [r, g, b, a] = COLORS[art[Math.floor(x / scale)]] ?? COLORS['.'];
      line.set([r, g, b, a], 1 + x * 4);
    }
    rows.push(line);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bits por canal
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.concat(rows), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * ICO con cada tamaño guardado como PNG, que es lo que Windows espera desde
 * Vista. El instalador y el ejecutable usan este archivo; el 256 es el que
 * exige electron-builder y los chicos evitan que Windows reescale el grande
 * para la barra de tareas, que es donde el pixel art se ensucia.
 */
function ico(sizes) {
  const images = sizes.map((size) => ({ size, data: png(size) }));
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2); // tipo: icono
  header.writeUInt16LE(images.length, 4);

  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, data }) => {
    const e = Buffer.alloc(16);
    e[0] = size >= 256 ? 0 : size; // 0 significa 256
    e[1] = size >= 256 ? 0 : size;
    e.writeUInt16LE(1, 4); // planos
    e.writeUInt16LE(32, 6); // bits por pixel
    e.writeUInt32BE(0, 8);
    e.writeUInt32LE(data.length, 8);
    e.writeUInt32LE(offset, 12);
    offset += data.length;
    return e;
  });

  return Buffer.concat([header, ...entries, ...images.map((i) => i.data)]);
}

const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(join(here, 'icon.png'), png(256));
writeFileSync(join(here, 'icon-512.png'), png(512));
writeFileSync(join(here, 'icon.ico'), ico([16, 32, 48, 64, 128, 256]));
console.log('icon.png 256, icon-512.png 512, icon.ico (16-256)');
