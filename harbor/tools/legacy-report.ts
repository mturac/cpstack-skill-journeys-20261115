import { WorkLog } from '../src/work-log.ts';

const workLog = new WorkLog(process.env.HARBOR_DB ?? '.harbor/work-log.sqlite');
const result = workLog.inspect(process.argv[2] ?? 'monday');
if (result.kind === 'found') process.stdout.write(`${result.batch.id}: ${result.batch.totalMinutes} minutes\n`);
else { process.stderr.write(`${result.kind}\n`); process.exitCode = 2; }
