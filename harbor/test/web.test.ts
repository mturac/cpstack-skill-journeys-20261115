import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startServer } from '../src/web.ts';
import { MAX_CSV_BYTES, WorkLog } from '../src/work-log.ts';

function editorValue(html: string): string {
  const value = /<textarea[^>]*name="csv"[^>]*>([\s\S]*?)<\/textarea>/.exec(html)?.[1];
  assert.notEqual(value, undefined);
  return (value ?? '').replace(/&(amp|lt|gt|quot|#39);/g, entity => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[entity] ?? entity);
}

test('saved receipt page keeps equivalent CSV so Save again replays and conflicts retain attempted edits', async t => {
  const file = join(mkdtempSync(join(tmpdir(), 'harbor-web-')), 'work-log.sqlite');
  const workLog = new WorkLog(file);
  const server = startServer(workLog, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (batch: string, csv: string) => fetch(`${origin}/import`, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ batch, csv }), redirect: 'manual',
  });
  const csv = 'id,minutes,label\nu1,79,"Review, ""quoted""\nnext <tag>&"\nu2,21,Plan\nu3,0,Pause\n';
  const saved = await post('browser-acceptance', csv);
  assert.equal(saved.status, 303);
  const location = saved.headers.get('location');
  assert.ok(location);
  const receiptPage = await fetch(new URL(location, origin));
  assert.equal(receiptPage.status, 200);
  const html = await receiptPage.text();
  assert.match(html, /3 entries, 100 minutes/);
  const restored = editorValue(html);
  const retry = await post('browser-acceptance', restored);
  assert.equal(retry.status, 303, await retry.text());
  assert.match(retry.headers.get('location') ?? '', /notice=replayed/);
  const changed = restored.replace('79', '80');
  const conflict = await post('browser-acceptance', changed);
  assert.equal(conflict.status, 409);
  const conflictHtml = await conflict.text();
  assert.equal(editorValue(conflictHtml), changed);
  assert.match(conflictHtml, /class="status error"/);
  const inspected = workLog.inspect('browser-acceptance');
  assert.equal(inspected.kind, 'found');
  if (inspected.kind !== 'found') assert.fail('Receipt disappeared.');
  assert.equal(inspected.batch.totalMinutes, 100);
});


test('HTTP rejects foreign origins, unexpected hosts, malformed encoding, and oversized bodies without a saved batch', async t => {
  const workLog = new WorkLog(join(mkdtempSync(join(tmpdir(), 'harbor-boundary-')), 'work-log.sqlite'));
  const server = startServer(workLog, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const foreign = await fetch(`${origin}/import`, {
    method: 'POST', headers: { Origin: 'https://example.com' },
    body: new URLSearchParams({ batch: 'rejected', csv: 'id,minutes,label\na,1,x' }),
  });
  assert.equal(foreign.status, 403);
  const hostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(origin, { headers: { Host: 'example.com' } }, response => {
      response.resume();
      response.on('end', () => resolve(response.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(hostStatus, 403);
  for (const body of ['batch=rejected&csv=%FF', 'batch=rejected&csv=' + 'x'.repeat(MAX_CSV_BYTES * 3 + 2048)]) {
    const response = await fetch(`${origin}/import`, {
      method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body,
    });
    assert.equal(response.status, 400);
    await response.text();
  }
  assert.deepEqual(workLog.inspect('rejected'), { kind: 'absent' });
});

function browserFormValue(html: string): string {
  return editorValue(html).replace(/\r\n?/g, '\n').replace(/\n/g, '\r\n');
}

test('saving an unedited receipt page replays a stored multi-line label whatever line endings it holds', async t => {
  const workLog = new WorkLog(join(mkdtempSync(join(tmpdir(), 'harbor-newline-')), 'work-log.sqlite'));
  const server = startServer(workLog, 0);
  t.after(() => { server.closeAllConnections(); server.close(); });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const post = (batch: string, csv: string) => fetch(`${origin}/import`, {
    method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ batch, csv }), redirect: 'manual',
  });
  const labels = { lf: 'alpha\nbeta', crlf: 'alpha\r\nbeta', cr: 'alpha\rbeta', mixed: 'alpha\nbeta\r\ngamma\rdelta' };
  for (const [batch, label] of Object.entries(labels)) {
    await t.test(batch, async () => {
      const stored = workLog.importBatch({ batch, csv: `id,minutes,label\nk1,10,"${label}"\nk2,5,solo\n` });
      if (stored.kind !== 'imported') assert.fail(`Setup import returned ${stored.kind}.`);
      const unchanged = { kind: 'found', batch: stored.batch };
      const submitted = browserFormValue(await (await fetch(`${origin}/?batch=${batch}`)).text());
      if (batch === 'lf') {
        assert.equal(new URLSearchParams({ batch, csv: submitted }).toString(),
          'batch=lf&csv=id%2Cminutes%2Clabel%0D%0A%22k1%22%2C%2210%22%2C%22alpha%0D%0Abeta%22%0D%0A%22k2%22%2C%225%22%2C%22solo%22',
          'form value differs from the body Chromium 145 sent for this batch');
      }
      const retry = await post(batch, submitted);
      assert.equal(retry.status, 303, await retry.text());
      assert.match(retry.headers.get('location') ?? '', /notice=replayed/);
      assert.deepEqual(workLog.inspect(batch), unchanged);
      for (const [from, to] of [['"10"', '"11"'], ['"k2"', '"k9"'], ['alpha', 'alpha!']] as const) {
        const edited = await post(batch, submitted.replace(from, to));
        assert.equal(edited.status, 409, `${from} to ${to}`);
        await edited.text();
        assert.deepEqual(workLog.inspect(batch), unchanged);
      }
    });
  }
  const crlfUnderLfId = workLog.importBatch({ batch: 'lf', csv: 'id,minutes,label\nk1,10,"alpha\r\nbeta"\nk2,5,solo\n' });
  assert.equal(crlfUnderLfId.kind, 'conflict');
});
