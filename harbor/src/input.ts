import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { MAX_CSV_BYTES } from './work-log.ts';

export function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
}
export function readCsvFile(file: string): string {
  const fd = openSync(file, 'r');
  try {
    if (!fstatSync(fd).isFile()) throw new Error('CSV input must be a regular file.');
    const bytes = Buffer.alloc(MAX_CSV_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = readSync(fd, bytes, length, bytes.length - length, null);
      if (read === 0) break;
      length += read;
    }
    if (length > MAX_CSV_BYTES) throw new Error('CSV exceeds 1 MiB.');
    return decodeUtf8(bytes.subarray(0, length));
  } finally { closeSync(fd); }
}
