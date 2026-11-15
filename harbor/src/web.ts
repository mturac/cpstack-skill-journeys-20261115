import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { decodeUtf8 } from './input.ts';
import { MAX_CSV_BYTES, WorkLog } from './work-log.ts';
import type { Batch, ImportResult, InspectResult } from './work-log.ts';

type VisibleResult = ImportResult | InspectResult;
const example = 'id,minutes,label\nr1,15,plan\nr2,30,"review, edits"\n';
const MAX_FORM_BYTES = MAX_CSV_BYTES * 3 + 2048;
function escape(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character);
}
function summary(result: VisibleResult | undefined): string {
  if (!result) return '';
  switch (result.kind) {
    case 'found': case 'imported': case 'replayed':
      return `${result.kind} ${result.batch.id}. ${result.batch.entries.length} entries, ${result.batch.totalMinutes} minutes.`;
    case 'absent': return 'No saved batch with this id.';
    case 'invalid': case 'conflict': case 'busy': case 'storage': return `${result.kind}. ${result.message}`;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
function batchCsv(batch: Batch): string {
  return 'id,minutes,label\n' + batch.entries.map(entry =>
    [entry.id, String(entry.minutes), entry.label].map(value => `"${value.replace(/"/g, '""')}"`).join(',')
  ).join('\n');
}
// A browser submits every textarea line break as CRLF, whichever of LF, CRLF, or CR the page held.
function browserWireText(text: string): string {
  return text.replace(/\r\n|\r|\n/g, '\r\n');
}
function acceptBrowserRoundTrip(result: ImportResult, submitted: string): ImportResult {
  return result.kind === 'conflict' && submitted === browserWireText(batchCsv(result.batch))
    ? { kind: 'replayed', batch: result.batch }
    : result;
}
function page(batch: string, csv: string, result?: VisibleResult, notice?: string): string {
  const saved = result && 'batch' in result ? result.batch : undefined;
  const failed = result && result.kind !== 'found' && result.kind !== 'imported' && result.kind !== 'replayed';
  const rows = saved?.entries.map(entry => `<tr><td>${escape(entry.id)}</td><td>${entry.minutes}</td><td class="label">${escape(entry.label)}</td></tr>`).join('') ?? '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Harbor | Work log</title><style>
  :root{font-family:system-ui,sans-serif;color:#173132;background:#f2f5f0}*{box-sizing:border-box}body{margin:0}main{max-width:1040px;margin:40px auto;padding:0 24px}header{border-bottom:1px solid #cad6ca;padding-bottom:24px;margin-bottom:28px}h1{font-size:42px;letter-spacing:-2px;margin:0}p{line-height:1.5;color:#46605c}.eyebrow{font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#47726a}.grid{display:grid;grid-template-columns:1fr 1fr;gap:24px}section{background:#fff;border:1px solid #d5ded3;border-radius:12px;padding:24px}h2{font-size:21px;margin:0 0 18px}label{display:block;font-weight:600;margin:16px 0 7px}input,textarea,button{font:inherit}input,textarea{width:100%;padding:12px;border:1px solid #a9bdb2;border-radius:6px}textarea{min-height:245px;font-family:ui-monospace,monospace;font-size:13px;line-height:1.6;resize:vertical}button{background:#1a6657;border:0;color:white;padding:12px 18px;border-radius:6px;cursor:pointer;margin-top:14px;font-weight:600}button:hover{background:#124e42}input:focus,textarea:focus,button:focus{outline:3px solid #9cd6be;outline-offset:2px}.hint{font-size:13px}.status{padding:14px;background:#e7f3e9;border-radius:6px;overflow-wrap:anywhere}.status.error{background:#fff0e7;color:#813c19;border:1px solid #ecc5ae}.empty{padding:24px 0;color:#627971}table{border-collapse:collapse;width:100%;font-size:14px;margin-top:20px}td,th{text-align:left;border-bottom:1px solid #e0e8df;padding:10px 6px;overflow-wrap:anywhere}.label{white-space:pre-wrap}.table-wrap{overflow-x:auto}footer{font-size:13px;color:#627971;margin-top:24px}@media(max-width:720px){main{margin:24px auto;padding:0 16px}.grid{grid-template-columns:1fr}section{padding:20px}h1{font-size:36px}}
  </style></head><body><main><header><div class="eyebrow">Local work log</div><h1>Harbor</h1><p>Save a CSV batch. Retry with the same id whenever you need to.<br>Identical entries keep one receipt. Different entries need a new batch id.</p></header>
  <div class="grid"><section><h2>Import a batch</h2><form method="post" action="/import"><label for="batch">Batch id</label><input id="batch" name="batch" value="${escape(batch)}" required placeholder="monday"><p class="hint">Use a memorable id, up to 128 UTF-8 bytes.</p><label for="csv">CSV entries</label><textarea id="csv" name="csv" required spellcheck="false">${escape(csv)}</textarea><p class="hint">Header id,minutes,label. Up to 1 MiB and 10,000 rows. Minutes must be an integer from 0 to 1440.</p><button type="submit">Save batch</button></form></section>
  <section><h2>Saved receipt</h2><form method="get" action="/"><label for="inspect-batch">Inspect a batch</label><input id="inspect-batch" name="batch" value="${escape(batch)}" required placeholder="monday"><button type="submit">Inspect batch</button></form>
  ${result ? `<p class="status${failed ? ' error' : ''}" role="status">${escape(notice ? `${notice}. ${summary(result)}` : summary(result))}</p>` : '<p class="empty">Import a batch or enter its id to see the saved entries.</p>'}
  ${saved ? `<div class="table-wrap"><table><thead><tr><th scope="col">Id</th><th scope="col">Minutes</th><th scope="col">Label</th></tr></thead><tbody>${rows}</tbody></table></div>` : ''}</section></div><footer>Stored on this computer. Bookmark the receipt URL to return after a restart.</footer></main></body></html>`;
}
function send(response: ServerResponse, status: number, html: string): void {
  response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
  response.end(html);
}
function statusFor(result: VisibleResult): number {
  switch (result.kind) {
    case 'imported': case 'replayed': case 'found': return 200;
    case 'absent': return 404;
    case 'invalid': return 400;
    case 'conflict': return 409;
    case 'busy': return 503;
    case 'storage': return 500;
    default: { const exhaustive: never = result; return exhaustive; }
  }
}
async function readForm(request: IncomingMessage): Promise<{ batch: string; csv: string }> {
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const input of request) {
    const chunk: unknown = input;
    if (!Buffer.isBuffer(chunk)) throw new Error('Invalid request body.');
    length += chunk.length;
    if (length > MAX_FORM_BYTES) { chunks.length = 0; continue; }
    chunks.push(chunk);
  }
  if (length > MAX_FORM_BYTES) throw new Error('Form exceeds the input limit.');
  const raw = decodeUtf8(Buffer.concat(chunks));
  const fields = new Map<string, string>();
  for (const pair of raw.split('&')) {
    const separator = pair.indexOf('=');
    if (separator < 0) throw new Error('Invalid form field.');
    const name = decodeURIComponent(pair.slice(0, separator).replace(/\+/g, ' '));
    const value = decodeURIComponent(pair.slice(separator + 1).replace(/\+/g, ' '));
    if ((name !== 'batch' && name !== 'csv') || fields.has(name)) throw new Error('Invalid or repeated form field.');
    fields.set(name, value);
  }
  const batch = fields.get('batch');
  const csv = fields.get('csv');
  if (batch === undefined || csv === undefined) throw new Error('Batch id and CSV are required.');
  return { batch, csv };
}
export function startServer(workLog: WorkLog, port: number): Server {
  const server = createServer((request, response) => {
    void handle(request, response).catch(() => {
      if (!response.headersSent) send(response, 400, page('', example, { kind: 'invalid', message: 'Invalid or oversized request body. Nothing was saved.' }));
      else response.end();
    });
  });
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const address = server.address();
    if (!address || typeof address === 'string') { response.writeHead(503); response.end(); return; }
    const authority = `127.0.0.1:${address.port}`;
    const origin = `http://${authority}`;
    if (request.headers.host !== authority) { response.writeHead(403); response.end('Unexpected Host.'); return; }
    const url = new URL(request.url ?? '/', origin);
    if (request.method === 'GET' && url.pathname === '/') {
      const batch = url.searchParams.get('batch') ?? '';
      const notice = url.searchParams.get('notice');
      const result = batch ? workLog.inspect(batch) : undefined;
      send(response, result ? statusFor(result) : 200, page(batch, result?.kind === 'found' ? batchCsv(result.batch) : example, result,
        notice === 'imported' || notice === 'replayed' ? notice : undefined));
      return;
    }
    if (request.method === 'POST' && url.pathname === '/import') {
      if (request.headers.origin !== origin) { response.writeHead(403); response.end('Unexpected Origin.'); return; }
      if (request.headers['content-type']?.split(';')[0] !== 'application/x-www-form-urlencoded') {
        response.writeHead(415); response.end('Use the import form.'); return;
      }
      const form = await readForm(request);
      const result = acceptBrowserRoundTrip(workLog.importBatch(form), form.csv);
      if (result.kind === 'imported' || result.kind === 'replayed') {
        response.writeHead(303, { Location: `/?${new URLSearchParams({ batch: result.batch.id, notice: result.kind })}` });
        response.end();
      } else send(response, statusFor(result), page(form.batch, form.csv, result));
      return;
    }
    response.writeHead(404); response.end('Not found.');
  }
  server.requestTimeout = 10000;
  server.headersTimeout = 10000;
  server.listen(port, '127.0.0.1');
  return server;
}
