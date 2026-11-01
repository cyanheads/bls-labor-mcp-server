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

The mirror harvests every survey in the catalog's survey list — OE included, whatever `BLS_CATALOG_INCLUDE_OES` says — so it covers CM and CI too (about 55 MB of `cm.data.*` / `ci.data.*` files).

An incremental refresh reads only files published after the mirror's last one. A mirror bootstrapped before CM and CI joined therefore picks each file up at its next BLS publication; until then those series come from the live API when fallback is on.

## Live fallback

Until the bootstrap completes, requests fall back to the live API (unless `BLS_OBSERVATIONS_MIRROR_FALLBACK_LIVE=false`). When a live fallback fails — quota exhausted, BLS unreachable — the series the mirror served are still returned, and `enrichment.notice` names each unserved SeriesID with the failure's reason and recovery.

## Calculations

Mirror rows carry no BLS calculations. With `calculations: true`, a mirror-served series comes back without calculation fields, `enrichment.calculationsApplied` is `false`, and the notice names it.

## Upgrading an existing mirror

A mirror bootstrapped before sentinel rows were stored is missing the periods BLS publishes with its `-` missing-value marker. Opening such a mirror clears its sync checkpoint once, so the next refresh re-reads every LABSTAT file and fills them in. No operator action is needed beyond letting that refresh run, which takes as long as a full read. The mirror keeps serving throughout.
