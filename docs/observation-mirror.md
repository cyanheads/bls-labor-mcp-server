# Observation mirror

An opt-in local mirror serves `bls_get_series` and `bls_get_latest` from an embedded SQLite store of the LABSTAT observation files instead of the BLS API, which removes the 500-queries/day cap for high-volume workloads. It is off by default.

## Setup

1. Set `BLS_OBSERVATIONS_MIRROR_ENABLED=true`.
2. Run the one-time bootstrap out-of-band. It downloads the full LABSTAT observation set and can take a while:

   ```sh
   node dist/services/bls-observations/subprocess.js --init
   ```

| Variable | Description | Default |
|:---|:---|:---|
| `BLS_OBSERVATIONS_MIRROR_ENABLED` | Route observation fetches through the mirror. | `false` |
| `BLS_OBSERVATIONS_MIRROR_PATH` | SQLite store path. In containers, mount a persistent volume here. | `.mirror/bls-observations.db` |
| `BLS_OBSERVATIONS_MIRROR_REFRESH_CRON` | Incremental refresh schedule, UTC (HTTP transport only). | `0 6 * * 1` (Monday 06:00) |
| `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE` | Fall back to the live API when the mirror is not ready or lacks a series; `false` enforces mirror-only. | `true` |

## Coverage

The mirror harvests the catalog's surveys less the catalog-only ones — OE included, whatever `BLS_CATALOG_INCLUDE_OES` says — so it covers CM and CI too (about 55 MB of `cm.data.*` / `ci.data.*` files). SM, LE, EI, SU, IP, BD, LU, and EE are catalog-only: searchable, but their data files total 1.78 GB, so their observations come from the live API.

Files come from each survey's directory listing (`{base}/{abbr}/`). Every linked `{abbr}.data.*` file is read under its served name (URL-encoded; spaces become `%20`), which is how PC is mirrored. A listing with no data files logs a warning and counts toward exit code 2.

An incremental refresh reads only files published after the mirror's checkpoint. The checkpoint advances once, at the end of a run that read every listing and every listed file, to the newest `Last-Modified` among the files read. Any unread file (non-200, transport error, timeout, a data file without the header) holds it, and the next run re-downloads the files newer than it; unchanged files cost only their headers. A survey added to the list later reaches an existing mirror at its next BLS publication, until which its series come from the live API when fallback is on. An initial run that was resumed stores no checkpoint.

Every sync also reads each survey's `{abbr}.footnote` table (EC has none, a 404 is quiet) into the store before the data pass. Observation footnote codes are decoded from it at read time. A failed table keeps the stored copy, logs the warning `LABSTAT footnote table unread; any stored copy stays in use`, and is not an unread file: it neither holds the checkpoint nor changes the exit code.

## Harvest runs

The harvest runs in a subprocess, which exits 0 on a clean run, 2 when it completed with gaps, and 1 when it failed or was aborted. The parent logs 2 at warning as a degraded run; the next scheduled run re-reads, with no extra retry. Response headers have 30 s and a body may stall for 60 s, with no whole-file deadline. Files stream in pages of 5,000 rows, so memory stays bounded. Requests retry up to 3 attempts, only on 408, 429, 500, 502, 503, 504, network errors, and timeouts; a 403 or 404 fails on the first try. The runner's and ingester's log records are JSON lines on the subprocess's stdout, relayed by the parent.

## Live fallback

Until the bootstrap completes, requests fall back to the live API (unless `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=false`). When a live fallback fails — quota exhausted, BLS unreachable — the series the mirror served are still returned, and `enrichment.notice` names each unserved SeriesID with the failure's reason and recovery.

## Calculations

Mirror rows carry no BLS calculations. With `calculations: true`, a mirror-served series comes back without calculation fields, `enrichment.calculationsApplied` is `false`, and the notice names it.

## Upgrading an existing mirror

A mirror created by an earlier release can be missing the periods BLS publishes with its `-` missing-value marker, and files its discovery did not list (all 71 PC files, 10 CE files, `wp.data.80i.ConstructnInputs`, `jt.data.8.UnemployedPerJobOpeningRatio`). Opening a mirror at an earlier schema version clears its checkpoint and any interrupted init's resume cursor once (schema v3), so the next refresh re-reads every listed file. An interrupted init restarts rather than resumes. Stored rows stay and the mirror keeps serving throughout. No operator action is needed beyond letting that refresh run, which takes as long as a full read.

Footnote text arrives with the next sync of any kind (schema v4 adds the `bls_footnotes` table, with no reset); until then footnote codes stay bare.
