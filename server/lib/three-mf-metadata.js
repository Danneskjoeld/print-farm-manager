const fs = require('fs');
const zlib = require('zlib');

const MAX_ENTRY_BYTES = 4 * 1024 * 1024;

function readZipEntry(filePath, wantedName) {
  const zip = fs.readFileSync(filePath);
  const eocd = zip.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);

  for (let i = 0; i < entryCount && offset + 46 <= zip.length; i++) {
    if (zip.readUInt32LE(offset) !== 0x02014b50) break;
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const uncompressedSize = zip.readUInt32LE(offset + 24);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');

    if (name.toLowerCase() === wantedName.toLowerCase()) {
      if (uncompressedSize > MAX_ENTRY_BYTES || localOffset + 30 > zip.length) return null;
      const localNameLength = zip.readUInt16LE(localOffset + 26);
      const localExtraLength = zip.readUInt16LE(localOffset + 28);
      const dataStart = localOffset + 30 + localNameLength + localExtraLength;
      const compressed = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return compressed;
      if (method === 8) return zlib.inflateRawSync(compressed, { maxOutputLength: MAX_ENTRY_BYTES });
      return null;
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return null;
}

function parseDuration(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return Math.round(Number(raw));
  let seconds = 0;
  let found = false;
  for (const [pattern, multiplier] of [[/(\d+(?:\.\d+)?)\s*h/i, 3600], [/(\d+(?:\.\d+)?)\s*m/i, 60], [/(\d+(?:\.\d+)?)\s*s/i, 1]]) {
    const match = raw.match(pattern);
    if (match) { seconds += Number(match[1]) * multiplier; found = true; }
  }
  return found ? Math.round(seconds) : null;
}

function parseSliceInfo(xml) {
  if (!xml) return {};
  const plateMatch = String(xml).match(/<plate\b[^>]*>([\s\S]*?)<\/plate>/i);
  const plate = plateMatch ? plateMatch[1] : String(xml);
  const metadata = {};
  for (const match of plate.matchAll(/<metadata\b[^>]*key=["']([^"']+)["'][^>]*value=["']([^"']*)["'][^>]*\/?\s*>/gi)) {
    metadata[match[1].toLowerCase()] = match[2];
  }
  const prediction = Number(metadata.prediction);
  const weight = Number(metadata.weight);
  return {
    est_print_secs: Number.isFinite(prediction) && prediction > 0 ? Math.round(prediction) : null,
    material_grams: Number.isFinite(weight) && weight > 0 ? weight : null,
  };
}

function parseGcodeHeader(text) {
  if (!text) return {};
  const source = String(text);
  const time = source.match(/;\s*(?:total estimated time|model printing time|estimated printing time[^:=]*)\s*[:=]\s*([^;\r\n]+)/i);
  const weight = source.match(/;\s*(?:total filament (?:weight|used)\s*\[g\]|filament used\s*\[g\])\s*[:=]\s*([\d.,\s]+)/i);
  let material = null;
  if (weight) {
    const values = weight[1].split(',').map(v => Number(v.trim())).filter(Number.isFinite);
    if (values.length) material = values.reduce((sum, value) => sum + value, 0);
  }
  return { est_print_secs: time ? parseDuration(time[1]) : null, material_grams: material };
}

function extract3mfMetadata(filePath) {
  const sliceInfo = readZipEntry(filePath, 'Metadata/slice_info.config');
  const fromXml = parseSliceInfo(sliceInfo && sliceInfo.toString('utf8'));
  if (fromXml.est_print_secs && fromXml.material_grams) return fromXml;
  const plateGcode = readZipEntry(filePath, 'Metadata/plate_1.gcode');
  const fromGcode = parseGcodeHeader(plateGcode && plateGcode.toString('utf8'));
  return {
    est_print_secs: fromXml.est_print_secs || fromGcode.est_print_secs || null,
    material_grams: fromXml.material_grams || fromGcode.material_grams || null,
  };
}

module.exports = { extract3mfMetadata, parseSliceInfo, parseGcodeHeader, parseDuration };
