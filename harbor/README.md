# Harbor

Save a local work-log CSV batch and recover its receipt after a retry or restart.

## Import and inspect a batch

Use Node 26.11.1 or later. The application has no production dependencies.

1. Run `node harbor.ts help` from this directory.
2. Run `node harbor.ts import monday examples/day.csv`.
   The output is `imported monday 2 45`.
3. Repeat the import command.
   The output is `replayed monday 2 45`.
4. Run `node harbor.ts inspect monday`.
   The output starts with `found monday 2 45` and lists the saved entries.
5. To start a new batch, use a new id in the import command.

The default database is `.harbor/work-log.sqlite`, relative to your current directory.
Set `HARBOR_DB` to use another file. Keep the same path when you restart.

```sh
HARBOR_DB=/tmp/harbor-example.sqlite node harbor.ts import monday examples/day.csv
HARBOR_DB=/tmp/harbor-example.sqlite node harbor.ts inspect monday --json
```

If the process stops before you see a receipt, inspect the batch or retry the same command.
A saved batch returns `replayed`. An unfinished transaction leaves no partial batch.
If an id already contains different entries, Harbor returns `conflict` and the existing receipt.
Use a new batch id for the changed entries.
If the database is busy, wait briefly and retry the same id and CSV.
A storage error can leave the outcome uncertain. Inspect or retry the same input before starting a new batch.

## Use the browser

1. Run `node harbor.ts serve`.
2. Open the printed `http://127.0.0.1:4173` address.
3. Enter a batch id and paste a CSV into **CSV entries**.
4. Click **Save batch**. The receipt lists the saved entries and total minutes.
5. Bookmark the receipt URL. Reload the page to inspect the saved batch.
6. Stop the server with Ctrl+C. Restart with the same `HARBOR_DB` and open the bookmarked URL.

Use `node harbor.ts serve 4180` for another port, or `serve 0` for an available port.
The server listens only on `127.0.0.1`. Open the printed address exactly.
The import form accepts requests from that origin.

## CSV rules

Use the header and columns in this order.

```csv
id,minutes,label
r1,15,plan
r2,30,"review, edits"
```

Each row id must contain non-whitespace text and be unique within the batch.
Minutes must contain decimal digits and represent an integer from 0 to 1440.
Labels may be empty. Quoted fields support commas, doubled quotes, and embedded line endings.
Records accept LF or CRLF endings. A blank data row is invalid.
A header without data creates an empty receipt with zero minutes.

Input must be valid UTF-8 without a byte-order mark.
A batch id contains 1 to 128 UTF-8 bytes and non-whitespace text.
CSV input is limited to 1 MiB and 10,000 data rows.
Spaces in ids and labels are preserved.
Row order, CSV quoting, and leading zeroes in minutes do not change the receipt identity.
Changes to ids, labels, or numeric minutes produce a conflict under an existing batch id.

## Command results

Add `--json` to `import` or `inspect` for a JSON result.
Success goes to stdout. Errors and missing batches go to stderr.

- Exit 0 means `imported`, `replayed`, or `found`.
- Exit 2 means `invalid`, `conflict`, or `absent`.
- Exit 3 means `busy` or `storage`.

## Develop locally

Run `npm ci --ignore-scripts` to install the pinned development dependencies.
Run `npm test`, `npm run typecheck`, and `npm run build`.
Run the compiled application with `node dist/harbor.js help`.
Build output and database files are ignored by Git.

`src/work-log.ts` exports `WorkLog` and the named result types.
`new WorkLog(file).importBatch({ batch, csv })` returns a receipt or a typed error.
`new WorkLog(file).inspect(batch)` reads the saved receipt.
`tools/legacy-report.ts` is a compatibility caller of that same API.
Run `node tools/legacy-report.ts monday` with the same `HARBOR_DB` to read a total.

Each batch is one immutable SQLite row. A short `BEGIN IMMEDIATE` transaction compares the complete normalized payload before it inserts.
Totals are derived from that row. There is no separate total counter or application lock.
Connections use a 250 ms busy timeout and synchronous FULL. macOS also enables fullfsync.
SQLite owns rollback after process interruption. Actual power-loss behavior is outside the local test evidence.
