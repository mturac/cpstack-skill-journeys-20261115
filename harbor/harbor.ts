import { resolve } from 'node:path';
import { readCsvFile } from './src/input.ts';
import { WorkLog } from './src/work-log.ts';
import type { ImportResult, InspectResult } from './src/work-log.ts';
import { startServer } from './src/web.ts';

const help = `Harbor saves local work-log CSV batches without duplicate retries.

Usage:
  node harbor.ts help
  node harbor.ts import <batch> <file> [--json]
  node harbor.ts inspect <batch> [--json]
  node harbor.ts serve [port]

CSV header: id,minutes,label
Each id must be unique within its batch. Minutes must be an integer 0..1440.
Limits: 1 MiB, 10000 rows, batch id 1..128 UTF-8 bytes.
Same id and entries replay the original receipt, regardless of row order.
Different entries under the same batch id return a conflict without overwriting.
HARBOR_DB overrides the default .harbor/work-log.sqlite path.
Exit codes: 0 success, 2 invalid/conflict/missing, 3 busy/storage.
`;
type Result = ImportResult | InspectResult;
function printResult(result: Result, json: boolean): void {
  const success = result.kind === 'imported' || result.kind === 'replayed' || result.kind === 'found';
  let output: string;
  if (json) output = JSON.stringify(result);
  else {
    switch (result.kind) {
      case 'imported': case 'replayed': case 'found':
        output = `${result.kind} ${result.batch.id} ${result.batch.entries.length} ${result.batch.totalMinutes}`;
        if (result.kind === 'found') output += `\n${JSON.stringify(result.batch.entries, null, 2)}`;
        break;
      case 'absent': output = 'absent. No saved batch with this id.'; break;
      case 'invalid': case 'conflict': case 'busy': case 'storage':
        output = `${result.kind}. ${result.message}`;
        if (result.kind === 'conflict') output += `\nExisting receipt: ${JSON.stringify(result.batch)}`;
        break;
      default: { const exhaustive: never = result; output = exhaustive; }
    }
  }
  (success ? process.stdout : process.stderr).write(output + '\n');
  process.exitCode = success ? 0 : result.kind === 'busy' || result.kind === 'storage' ? 3 : 2;
}
function main(): void {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const positional = args.filter(arg => arg !== '--json');
  const [command, batch, file] = positional;
  if (command === 'help' || command === '--help' || command === undefined) { process.stdout.write(help); return; }
  const workLog = new WorkLog(process.env.HARBOR_DB ?? resolve('.harbor/work-log.sqlite'));
  if (command === 'import' && positional.length === 3 && batch !== undefined && file !== undefined) {
    let csv: string;
    try { csv = readCsvFile(file); }
    catch (error) {
      printResult({ kind: 'invalid', message: error instanceof Error ? `Cannot read CSV. ${error.message}` : 'Cannot read CSV.' }, json);
      return;
    }
    printResult(workLog.importBatch({ batch, csv }), json); return;
  }
  if (command === 'inspect' && positional.length === 2 && batch !== undefined) {
    printResult(workLog.inspect(batch), json); return;
  }
  if (command === 'serve' && positional.length <= 2 && !json) {
    const port = batch === undefined ? 4173 : Number(batch);
    if (!/^\d+$/.test(batch ?? '4173') || !Number.isInteger(port) || port < 0 || port > 65535) {
      printResult({ kind: 'invalid', message: 'Port must be an integer from 0 to 65535.' }, false); return;
    }
    const server = startServer(workLog, port);
    server.on('listening', () => {
      const address = server.address();
      if (address && typeof address !== 'string') process.stdout.write(`Harbor listening at http://127.0.0.1:${address.port}\n`);
    });
    server.on('error', () => { process.stderr.write('storage. Could not start the local server.\n'); process.exitCode = 3; });
    return;
  }
  printResult({ kind: 'invalid', message: 'Unknown command or arguments. Run node harbor.ts help.' }, json);
}
main();
