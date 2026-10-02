'use strict';
// Minimal ZIP reader — the Dartmouth factor files are single-entry, deflate-compressed
// zips, so Node's zlib is enough: locate the entry through the central directory
// (robust to data descriptors) and inflate it. Pure; throws on anything malformed.
const zlib = require('node:zlib');

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const EOCD_MIN_LEN = 22;
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

function findEocd(buf) {
  for (let i = buf.length - EOCD_MIN_LEN; i >= 0; i--) {
    if (buf.readUInt32LE(i) === SIG_EOCD) return i;
  }
  throw new Error('zip-inflate: not a zip archive (no end-of-central-directory record)');
}

// Returns { name, text } for the first central-directory entry (latin1 text).
function unzipFirstEntry(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < EOCD_MIN_LEN) throw new Error('zip-inflate: buffer too small to be a zip archive');
  const eocd = findEocd(buf);
  const cd = buf.readUInt32LE(eocd + 16);
  if (cd + 46 > buf.length || buf.readUInt32LE(cd) !== SIG_CENTRAL) throw new Error('zip-inflate: central directory missing or corrupt');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const nameLen = buf.readUInt16LE(cd + 28);
  const localOff = buf.readUInt32LE(cd + 42);
  const name = buf.toString('latin1', cd + 46, cd + 46 + nameLen);
  if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== SIG_LOCAL) throw new Error('zip-inflate: local file header missing or corrupt');
  const localNameLen = buf.readUInt16LE(localOff + 26);
  const localExtraLen = buf.readUInt16LE(localOff + 28);
  const start = localOff + 30 + localNameLen + localExtraLen;
  const data = buf.subarray(start, start + compSize);
  if (method === METHOD_DEFLATE) return { name, text: zlib.inflateRawSync(data).toString('latin1') };
  if (method === METHOD_STORED) return { name, text: data.toString('latin1') };
  throw new Error(`zip-inflate: unsupported compression method ${method}`);
}

module.exports = { unzipFirstEntry };
