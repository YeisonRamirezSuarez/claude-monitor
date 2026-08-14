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

const here = dirname(fileURLToPath(import.meta.url));
for (const size of [256, 512]) {
  const file = join(here, size === 256 ? 'icon.png' : `icon-${size}.png`);
  writeFileSync(file, png(size));
  console.log(file, size + 'x' + size);
}
