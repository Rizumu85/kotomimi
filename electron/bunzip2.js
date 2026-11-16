const fs = require('fs');

// Bzip2 uses the most significant bit first, including in its CRC.
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let crc = i << 24;
  for (let bit = 0; bit < 8; bit++) crc = (crc << 1) ^ (crc < 0 ? 0x04c11db7 : 0);
  crcTable[i] = crc >>> 0;
}

async function bunzip2(source, destination) {
  const input = fs.openSync(source, 'r');
  let output;
  try {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let available = 0, offset = 0, bits = 0, bitCount = 0;
    function read(n) {
      while (bitCount < n) {
        if (offset === available) {
          available = fs.readSync(input, buffer, 0, buffer.length, null);
          offset = 0;
          if (!available) throw new Error('Truncated bzip2 file.');
        }
        bits = (bits << 8) | buffer[offset++];
        bitCount += 8;
      }
      bitCount -= n;
      return (bits >>> bitCount) & ((1 << n) - 1);
    }
    const readCRC = () => (read(16) * 65536 + read(16)) >>> 0;
    if (read(24) !== 0x425a68) throw new Error('Not a bzip2 file.');
    const level = read(8) - 48;
    if (level < 1 || level > 9) throw new Error('Invalid bzip2 block size.');
    const blockSize = level * 100000;
    output = fs.openSync(destination, 'w');
    const written = Buffer.allocUnsafe(64 * 1024);
    let used = 0, combinedCRC = 0;
    function flush() {
      let from = 0;
      while (from < used) from += fs.writeSync(output, written, from, used - from);
      used = 0;
    }

    for (;;) {
      const magic = read(24), tail = read(24);
      if (magic === 0x177245 && tail === 0x385090) {
        if (readCRC() !== combinedCRC) throw new Error('Bzip2 combined CRC mismatch.');
        return;
      }
      if (magic !== 0x314159 || tail !== 0x265359) throw new Error('Invalid bzip2 block header.');
      const expectedCRC = readCRC();
      if (read(1)) throw new Error('Randomised bzip2 blocks are not supported.');
      const original = read(24);

      const alphabet = [];
      const groups = read(16);
      for (let group = 0; group < 16; group++) {
        if (!(groups & (0x8000 >>> group))) continue;
        const present = read(16);
        for (let i = 0; i < 16; i++) if (present & (0x8000 >>> i)) alphabet.push(group * 16 + i);
      }
      if (!alphabet.length) throw new Error('Empty bzip2 alphabet.');
      const alphabetSize = alphabet.length + 2;
      const tableCount = read(3), selectorCount = read(15);
      if (tableCount < 2 || tableCount > 6 || selectorCount < 1 || selectorCount > 18002) {
        throw new Error('Invalid bzip2 Huffman table count.');
      }
      const order = Array.from({ length: tableCount }, (_, i) => i);
      const selectors = [];
      for (let i = 0; i < selectorCount; i++) {
        let rank = 0;
        while (read(1)) if (++rank >= tableCount) throw new Error('Invalid bzip2 table selector.');
        const [table] = order.splice(rank, 1);
        order.unshift(table);
        selectors.push(table);
      }

      // Canonical Huffman tables: first code and symbol offset at each length.
      const tables = [];
      for (let i = 0; i < tableCount; i++) {
        const lengths = [], counts = new Uint16Array(21);
        let length = read(5);
        for (let symbol = 0; symbol < alphabetSize; symbol++) {
          for (;;) {
            if (length < 1 || length > 20) throw new Error('Invalid bzip2 Huffman code length.');
            if (!read(1)) break;
            length += read(1) ? -1 : 1;
          }
          lengths.push(length);
          counts[length]++;
        }
        const first = [], starts = [], symbols = [];
        let code = 0;
        for (let length = 1; length <= 20; length++) {
          first[length] = code;
          starts[length] = symbols.length;
          for (let symbol = 0; symbol < alphabetSize; symbol++) if (lengths[symbol] === length) symbols.push(symbol);
          if (code + counts[length] > 2 ** length) throw new Error('Invalid bzip2 Huffman table.');
          code = (code + counts[length]) * 2;
        }
        tables.push({ first, starts, symbols, counts, min: Math.min(...lengths) });
      }
      let selector = 0, remaining = 0, table;
      function nextSymbol() {
        if (!remaining) {
          if (selector === selectors.length) throw new Error('Missing bzip2 table selector.');
          table = tables[selectors[selector++]];
          remaining = 50;
        }
        remaining--;
        let length = table.min, code = read(length);
        while (code >= table.first[length] + table.counts[length]) {
          if (++length > 20) throw new Error('Invalid bzip2 Huffman code.');
          code = code * 2 + read(1);
        }
        const index = code - table.first[length];
        if (index < 0) throw new Error('Invalid bzip2 Huffman code.');
        return table.symbols[table.starts[length] + index];
      }

      // Move-to-front, with RUNA/RUNB encoding repeats of the first byte.
      const last = new Uint8Array(blockSize);
      const frequencies = new Uint32Array(256);
      let size = 0, symbol = nextSymbol();
      while (symbol !== alphabetSize - 1) {
        if (symbol < 2) {
          let run = 0, weight = 1;
          do {
            run += (symbol + 1) * weight;
            if (size + run > blockSize) throw new Error('Bzip2 block exceeds its size.');
            weight *= 2;
            symbol = nextSymbol();
          } while (symbol < 2);
          last.fill(alphabet[0], size, size + run);
          frequencies[alphabet[0]] += run;
          size += run;
        } else {
          if (size === blockSize) throw new Error('Bzip2 block exceeds its size.');
          const [byte] = alphabet.splice(symbol - 1, 1);
          alphabet.unshift(byte);
          last[size++] = byte;
          frequencies[byte]++;
          symbol = nextSymbol();
        }
      }
      if (original >= size) throw new Error('Invalid bzip2 BWT pointer.');

      // Inverse Burrows-Wheeler: link each byte to its position in the sorted column.
      const starts = new Uint32Array(256), next = new Uint32Array(size);
      let total = 0;
      for (let i = 0; i < 256; i++) { starts[i] = total; total += frequencies[i]; }
      for (let i = 0; i < size; i++) next[starts[last[i]]++] = i;
      let position = next[original], previous = -1, repeats = 0, crc = 0xffffffff;
      for (let i = 0; i < size; i++) {
        let byte = last[position], count = 1;
        position = next[position];
        // The final run-length layer: four equal bytes are followed by an extra count.
        if (repeats === 4) {
          count = byte;
          byte = previous;
          repeats = 0;
        } else {
          repeats = byte === previous ? repeats + 1 : 1;
          previous = byte;
        }
        while (count--) {
          written[used++] = byte;
          crc = (crc << 8) ^ crcTable[((crc >>> 24) ^ byte) & 255];
          if (used === written.length) {
            flush();
            // A highly repetitive block can expand far beyond its encoded block size.
            await new Promise((resolve) => setImmediate(resolve));
          }
        }
      }
      if (repeats === 4) throw new Error('Truncated bzip2 run.');
      crc = (~crc) >>> 0;
      if (crc !== expectedCRC) throw new Error('Bzip2 block CRC mismatch.');
      combinedCRC = (((combinedCRC << 1) | (combinedCRC >>> 31)) ^ crc) >>> 0;
      flush();
      await new Promise((resolve) => setImmediate(resolve));
    }
  } finally {
    try { if (output !== undefined) fs.closeSync(output); }
    finally { fs.closeSync(input); }
  }
}

module.exports = bunzip2;
