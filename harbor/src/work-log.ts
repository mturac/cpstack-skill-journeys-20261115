import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Brand<T, Name extends string> = T & { readonly __brand: Name };
export type BatchId = Brand<string, 'BatchId'>;
export type EntryId = Brand<string, 'EntryId'>;
export type Minutes = Brand<number, 'Minutes'>;
export type Entry = Readonly<{ id: EntryId; minutes: Minutes; label: string }>;
export type Batch = Readonly<{ id: BatchId; entries: readonly Entry[]; totalMinutes: number }>;
type Failure<K extends string> = Readonly<{ kind: K; message: string }>;
export type ImportResult =
  | Readonly<{ kind: 'imported' | 'replayed'; batch: Batch }>
  | Readonly<{ kind: 'conflict'; message: string; batch: Batch }>
  | Failure<'invalid' | 'busy' | 'storage'>;
export type InspectResult =
  | Readonly<{ kind: 'found'; batch: Batch }>
  | Readonly<{ kind: 'absent' }>
  | Failure<'invalid' | 'busy' | 'storage'>;
export type Imported = ImportResult;
export type Inspected = InspectResult;
export const MAX_CSV_BYTES = 1024 * 1024;
export const MAX_ROWS = 10000;

type ParsedCsv = { kind: 'valid'; entries: readonly Entry[] } | Failure<'invalid'>;
type CsvState = 'start' | 'unquoted' | 'quoted' | 'closed';

function isBatchId(value: string): value is BatchId {
  return value.isWellFormed() && value.trim().length > 0 && Buffer.byteLength(value) <= 128;
}
function isEntryId(value: string): value is EntryId {
  return value.isWellFormed() && value.trim().length > 0;
}
function isMinutes(value: number): value is Minutes {
  return Number.isInteger(value) && value >= 0 && value <= 1440;
}
function invalid(message: string): Failure<'invalid'> { return { kind: 'invalid', message }; }

function parseCsv(csv: string): ParsedCsv {
  if (!csv.isWellFormed()) return invalid('CSV contains invalid Unicode.');
  if (Buffer.byteLength(csv) > MAX_CSV_BYTES) return invalid('CSV exceeds 1 MiB.');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let state: CsvState = 'start';
  const endField = () => { row.push(field); field = ''; state = 'start'; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < csv.length; i++) {
    const c = csv[i];
    if (state === 'quoted') {
      if (c === '"') {
        if (csv[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else field += c;
      continue;
    }
    if (c === ',') { endField(); continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r') {
        if (csv[i + 1] !== '\n') return invalid('Use LF or CRLF record endings.');
        i++;
      }
      endRow();
      if (rows.length > MAX_ROWS + 1) return invalid('CSV exceeds 10000 data rows.');
      continue;
    }
    if (state === 'closed') return invalid('Unexpected text after a quoted field.');
    if (c === '"') {
      if (state !== 'start') return invalid('A quote must begin a field.');
      state = 'quoted';
    } else { field += c; state = 'unquoted'; }
  }
  if (state === 'quoted') return invalid('Unclosed quoted field.');
  if (row.length > 0 || field.length > 0 || state !== 'start') endRow();
  const header = rows.shift();
  if (!header || header.length !== 3 || header[0] !== 'id' || header[1] !== 'minutes' || header[2] !== 'label') {
    return invalid('CSV header must be id,minutes,label.');
  }
  if (rows.length > MAX_ROWS) return invalid('CSV exceeds 10000 data rows.');
  const ids = new Set<string>();
  const entries: Entry[] = [];
  for (const [index, columns] of rows.entries()) {
    const [id, rawMinutes, label] = columns;
    if (columns.length !== 3 || id === undefined || rawMinutes === undefined || label === undefined) {
      return invalid(`Data row ${index + 1} must contain three fields.`);
    }
    if (!isEntryId(id)) return invalid(`Data row ${index + 1} needs a nonempty id.`);
    if (ids.has(id)) return invalid(`Data row ${index + 1} repeats an id.`);
    const minutes = Number(rawMinutes);
    if (!/^\d+$/.test(rawMinutes) || !isMinutes(minutes)) return invalid(`Data row ${index + 1} needs integer minutes from 0 to 1440.`);
    ids.add(id);
    entries.push({ id, minutes, label });
  }
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { kind: 'valid', entries };
}

function canonical(entries: readonly Entry[]): string {
  return JSON.stringify(entries.map(entry => [entry.id, entry.minutes, entry.label]));
}
function receipt(id: BatchId, entries: readonly Entry[]): Batch {
  return { id, entries, totalMinutes: entries.reduce((sum, entry) => sum + entry.minutes, 0) };
}
function readPayload(payload: unknown): readonly Entry[] {
  if (typeof payload !== 'string') throw new Error('Stored payload is not text.');
  const decoded: unknown = JSON.parse(payload);
  if (!Array.isArray(decoded) || decoded.length > MAX_ROWS) throw new Error('Stored batch is invalid.');
  const entries: Entry[] = [];
  const ids = new Set<string>();
  for (const value of decoded) {
    const tuple: unknown = value;
    if (!Array.isArray(tuple) || tuple.length !== 3) throw new Error('Stored entry is invalid.');
    const id: unknown = tuple[0];
    const minutes: unknown = tuple[1];
    const label: unknown = tuple[2];
    if (typeof id !== 'string' || !isEntryId(id) || typeof minutes !== 'number' || !isMinutes(minutes)
      || typeof label !== 'string' || !label.isWellFormed() || ids.has(id)) throw new Error('Stored entry is invalid.');
    ids.add(id);
    entries.push({ id, minutes, label });
  }
  if (canonical(entries) !== payload) throw new Error('Stored payload is not canonical.');
  return entries;
}
function storageFailure(error: unknown): Failure<'busy' | 'storage'> {
  if (error instanceof Error && 'errcode' in error && typeof error.errcode === 'number'
    && ((error.errcode & 255) === 5 || (error.errcode & 255) === 6)) {
    return { kind: 'busy', message: 'Database is busy. Retry the same batch and CSV.' };
  }
  return { kind: 'storage', message: 'Storage operation failed. Inspect or retry the same batch and CSV.' };
}

export class WorkLog {
  private readonly file: string;
  constructor(file: string) { this.file = file; }

  importBatch(input: Readonly<{ batch: string; csv: string }>): ImportResult {
    const id = input.batch;
    if (!isBatchId(id)) return invalid('Batch id must contain 1 to 128 UTF-8 bytes and non-whitespace text.');
    const parsed = parseCsv(input.csv);
    if (parsed.kind === 'invalid') return parsed;
    const payload = canonical(parsed.entries);
    return this.withDatabase(db => {
      db.exec('BEGIN IMMEDIATE');
      const existing = db.prepare('SELECT payload FROM batches WHERE batch = ?').get(id);
      if (existing) {
        const batch = receipt(id, readPayload(existing.payload));
        db.exec('COMMIT');
        return existing.payload === payload
          ? { kind: 'replayed', batch }
          : { kind: 'conflict', message: 'Batch id already contains different entries. Use a new batch id.', batch };
      }
      db.prepare('INSERT INTO batches (batch, payload) VALUES (?, ?)').run(id, payload);
      db.exec('COMMIT');
      return { kind: 'imported', batch: receipt(id, parsed.entries) };
    });
  }

  inspect(batch: string): InspectResult {
    if (!isBatchId(batch)) return invalid('Batch id must contain 1 to 128 UTF-8 bytes and non-whitespace text.');
    return this.withDatabase(db => {
      const existing = db.prepare('SELECT payload FROM batches WHERE batch = ?').get(batch);
      return existing ? { kind: 'found', batch: receipt(batch, readPayload(existing.payload)) } : { kind: 'absent' };
    });
  }

  private withDatabase<T>(operation: (db: DatabaseSync) => T): T | Failure<'busy' | 'storage'> {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      const db = new DatabaseSync(this.file);
      try {
        db.exec('PRAGMA busy_timeout = 250; PRAGMA synchronous = FULL;');
        if (process.platform === 'darwin') db.exec('PRAGMA fullfsync = ON;');
        db.exec('CREATE TABLE IF NOT EXISTS batches (batch TEXT PRIMARY KEY, payload TEXT NOT NULL) STRICT;');
        return operation(db);
      } finally {
        try { if (db.isTransaction) db.exec('ROLLBACK'); }
        finally { db.close(); }
      }
    } catch (error) { return storageFailure(error); }
  }
}
