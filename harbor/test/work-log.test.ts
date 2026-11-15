import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { MAX_CSV_BYTES, WorkLog } from '../src/work-log.ts';

function fixture(): { file: string; workLog: WorkLog } {
  const file = join(mkdtempSync(join(tmpdir(), 'harbor-test-')), 'work-log.sqlite');
  return { file, workLog: new WorkLog(file) };
}
const csv = 'id,minutes,label\nr1,15,plan\nr2,30,"review, edits"\n';

test('import, restart, normalized retry, and conflict keep one original receipt', () => {
  const { file, workLog } = fixture();
  const imported = workLog.importBatch({ batch: 'monday', csv });
  assert.equal(imported.kind, 'imported');
  if (imported.kind !== 'imported') assert.fail('Import did not succeed.');
  assert.equal(imported.batch.totalMinutes, 45);
  assert.deepEqual(imported.batch.entries, [
    { id: 'r1', minutes: 15, label: 'plan' }, { id: 'r2', minutes: 30, label: 'review, edits' },
  ]);
  const restarted = new WorkLog(file);
  const replay = restarted.importBatch({ batch: 'monday', csv: 'id,minutes,label\r\n"r2",030,"review, edits"\r\nr1,15,"plan"\r\n' });
  assert.deepEqual(replay, { kind: 'replayed', batch: imported.batch });
  const conflict = restarted.importBatch({ batch: 'monday', csv: csv.replace('r1,15', 'r1,16') });
  assert.equal(conflict.kind, 'conflict');
  if (conflict.kind !== 'conflict') assert.fail('Changed content must conflict.');
  assert.deepEqual(conflict.batch, imported.batch);
  assert.deepEqual(new WorkLog(file).inspect('monday'), { kind: 'found', batch: imported.batch });
  assert.equal(restarted.importBatch({ batch: 'tuesday', csv }).kind, 'imported');
});

test('quoted commas, escaped quotes, multiline fields, whitespace, and Unicode survive inspection', () => {
  const { workLog } = fixture();
  const result = workLog.importBatch({ batch: ' unicode ', csv: 'id,minutes,label\r\n" a ",0,"line one\r\nline two, ""quoted"" 🌊"\r\nz,1440,\r\n' });
  assert.equal(result.kind, 'imported');
  if (result.kind !== 'imported') assert.fail('Valid quoted CSV rejected.');
  assert.deepEqual(result.batch.entries, [
    { id: ' a ', minutes: 0, label: 'line one\r\nline two, "quoted" 🌊' },
    { id: 'z', minutes: 1440, label: '' },
  ]);
  assert.deepEqual(workLog.inspect(' unicode '), { kind: 'found', batch: result.batch });
});

test('invalid CSV and batch ids never create a batch', () => {
  const { workLog } = fixture();
  const invalidCsv = [
    '', 'id,minutes,wrong\na,1,x',
    'id,minutes,label\n\n', 'id,minutes,label\n,1,x',
    'id,minutes,label\na,1,x\na,2,y', 'id,minutes,label\na,1.5,x',
    'id,minutes,label\na,-1,x', 'id,minutes,label\na,1441,x',
    'id,minutes,label\na,NaN,x', 'id,minutes,label\na,,x',
    'id,minutes,label\na,1,"unclosed', 'id,minutes,label\na,1,"x"trailing',
    'id,minutes,label\na,1,x"', 'id,minutes,label\ra,1,x',
    'id,minutes,label\na,1,x,extra', 'id,minutes,label\n\ud800,1,x',
  ];
  for (const [index, input] of invalidCsv.entries()) {
    const batch = `invalid-${index}`;
    assert.equal(workLog.importBatch({ batch, csv: input }).kind, 'invalid', JSON.stringify(input));
    assert.deepEqual(workLog.inspect(batch), { kind: 'absent' });
  }
  for (const batch of ['', '   ', 'x'.repeat(129), '🌊'.repeat(33), '\ud800']) {
    assert.equal(workLog.importBatch({ batch, csv }).kind, 'invalid');
    assert.equal(workLog.inspect(batch).kind, 'invalid');
  }
});

test('CSV size and row limits accept the boundary and reject the next value', () => {
  const { workLog } = fixture();
  const prefix = 'id,minutes,label\na,1,';
  assert.equal(workLog.importBatch({ batch: 'size-limit', csv: prefix + 'x'.repeat(MAX_CSV_BYTES - Buffer.byteLength(prefix)) }).kind, 'imported');
  assert.equal(workLog.importBatch({ batch: 'too-large', csv: prefix + 'x'.repeat(MAX_CSV_BYTES - Buffer.byteLength(prefix) + 1) }).kind, 'invalid');
  const rows = Array.from({ length: 10000 }, (_, index) => `r${index},1,x`).join('\n');
  assert.equal(workLog.importBatch({ batch: 'row-limit', csv: `id,minutes,label\n${rows}` }).kind, 'imported');
  assert.equal(workLog.importBatch({ batch: 'too-many', csv: `id,minutes,label\n${rows}\nlast,1,x` }).kind, 'invalid');
});

test('header-only batch is an empty durable receipt', () => {
  const { file, workLog } = fixture();
  const result = workLog.importBatch({ batch: 'empty', csv: 'id,minutes,label\n' });
  assert.equal(result.kind, 'imported');
  if (result.kind !== 'imported') assert.fail('Empty batch rejected.');
  assert.equal(result.batch.totalMinutes, 0);
  assert.deepEqual(result.batch.entries, []);
  assert.deepEqual(new WorkLog(file).inspect('empty'), { kind: 'found', batch: result.batch });
});

test('a held database write returns busy and a later identical retry succeeds', () => {
  const { file, workLog } = fixture();
  assert.deepEqual(workLog.inspect('locked'), { kind: 'absent' });
  const lock = new DatabaseSync(file);
  try {
    lock.exec('BEGIN IMMEDIATE');
    assert.equal(workLog.importBatch({ batch: 'locked', csv }).kind, 'busy');
    lock.exec('ROLLBACK');
    assert.equal(workLog.importBatch({ batch: 'locked', csv }).kind, 'imported');
    assert.equal(workLog.importBatch({ batch: 'locked', csv }).kind, 'replayed');
  } finally { lock.close(); }
});

test('unavailable storage returns a typed result', () => {
  const { file, workLog } = fixture();
  assert.deepEqual(workLog.inspect('missing'), { kind: 'absent' });
  const unavailable = new WorkLog(join(file, 'cannot-be-a-file.sqlite'));
  assert.equal(unavailable.importBatch({ batch: 'monday', csv }).kind, 'storage');
  assert.equal(unavailable.inspect('monday').kind, 'storage');
});
