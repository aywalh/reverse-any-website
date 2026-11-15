// A ZIP writer built on the Node standard library.
//
// Why not adm-zip or archiver: this repo has exactly one dependency
// (Playwright), and that is a feature, not an accident. An archive format whose
// layout has not changed since 1989 does not justify a second one.
//
// It writes the simplest valid form: one local header per file, followed by
// the central directory. No ZIP64, no encryption, no comments — for archives
// under 4 GB with a few dozen files that is entirely sufficient, and every
// unzipper understands it.
import { deflateRawSync } from 'node:zlib';

// CRC-32, as ZIP requires. Build the table once, then it is a single byte pass.
const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

const crc32 = buf => {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};

// MS-DOS timestamp: 2-second resolution, years since 1980. Older than the
// format itself and still what belongs here.
const dosTime = d => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = d => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

/**
 * @param {{name: string, data: Buffer|string}[]} files  Paths with "/" as separator.
 * @param {Date} [when]
 * @returns {Buffer}
 */
export function zip(files, when = new Date()) {
  const time = dosTime(when), date = dosDate(when);
  const parts = [], central = [];
  let offset = 0;

  for (const f of files) {
    const name = Buffer.from(String(f.name).replace(/\\/g, '/'), 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const packed = deflateRawSync(raw);
    // When compressing gains nothing — already compressed PNGs, WebM — it only
    // costs time and makes the file bigger. Store it raw then.
    const useDeflate = packed.length < raw.length;
    const body = useDeflate ? packed : raw;
    const method = useDeflate ? 8 : 0;
    const sum = crc32(raw);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);          // version needed
    local.writeUInt16LE(0x0800, 6);      // bit 11: file name is UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(sum, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);          // no extra field
    parts.push(local, name, body);

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);             // made by
    cd.writeUInt16LE(20, 6);             // version needed
    cd.writeUInt16LE(0x0800, 8);
    cd.writeUInt16LE(method, 10);
    cd.writeUInt16LE(time, 12);
    cd.writeUInt16LE(date, 14);
    cd.writeUInt32LE(sum, 16);
    cd.writeUInt32LE(body.length, 20);
    cd.writeUInt32LE(raw.length, 24);
    cd.writeUInt16LE(name.length, 28);
    cd.writeUInt16LE(0, 30);             // Extra
    cd.writeUInt16LE(0, 32);             // comment
    cd.writeUInt16LE(0, 34);             // start disk
    cd.writeUInt16LE(0, 36);             // internal attributes
    cd.writeUInt32LE(0, 38);             // external attributes
    cd.writeUInt32LE(offset, 42);        // offset of the local header
    central.push(cd, name);

    offset += local.length + name.length + body.length;
  }

  const cdBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);               // this disk
  end.writeUInt16LE(0, 6);               // disk where the directory starts
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cdBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);              // no archive comment

  return Buffer.concat([...parts, cdBuf, end]);
}
