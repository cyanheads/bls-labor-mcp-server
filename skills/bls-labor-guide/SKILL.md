---
name: bls-labor-guide
description: Resolve BLS SeriesIDs and compare published US labor and price observations with bls_* tools. Use for inflation, unemployment, payroll, wage, productivity, or regional trend analysis requiring compatible series, coverage checks, or DataCanvas SQL.
license: Apache-2.0
metadata:
  author: "cyanheads"
  version: "1.0"
---

## Scope

Use BLS for published US labor, employment, price, compensation, and productivity statistics. An observation is a measurement for its stated period, not a live reading or forecast. A free API key is optional; keyless calls have smaller daily, batch, and history allowances.

## Identifiers

Survey abbreviations come from `bls_list_surveys`. Resolve concepts with `bls_search_series` and retain the returned SeriesID and decoded meaning together; do not construct an ID by guessing its positional codes. Search also accepts a known SeriesID for exact lookup.

For a survey outside the offline index, obtain its SeriesID from an authoritative BLS source before fetching: listing the survey does not make its series searchable here. Dataframe names come from `bls_get_series`'s `dataset.name`, `bls_dataframe_describe`, or `bls_dataframe_query`'s `registered_as`.

## Gates

- Before selecting a search hit, check its subject, geography, seasonal adjustment, and publication frequency. A title can appear at several frequencies. The `area` search is a substring filter, not a geocoder; numeric fragments can match unrelated IDs. Confirm the returned area rather than trusting the filter alone.
- Before concluding that BLS lacks a series, check whether its survey is indexed, follow available search pages, and inspect capped-result notices. Narrow a capped search instead of treating its count as exhaustive. A catalog snapshot can miss new series; its first and last years do not prove continuous coverage or discontinuation.
- Before comparing observations, establish compatible geography, units, frequency, and seasonal treatment from the returned metadata and series meaning. A CPI index level is not a percent inflation rate; a change already encoded in a series is not its underlying level. If units remain unknown, resolve them from BLS before labeling or combining the values.
- Before calculating, check availability and footnotes. The raw `-` value is missing, never zero. Keep missing periods visible when computing changes or rolling windows; twelve rows are not necessarily twelve consecutive months.
- Before calling a history complete, reconcile returned SeriesIDs, observations, served-year metadata, and notices with the requested scope. Process explicitly deferred IDs separately. An empty result, partial upstream failure, or reduced window does not establish a zero value.
- Before using BLS calculations, inspect which calculation fields actually returned. Survey capability flags predict support; they do not supply missing calculations. Mirror-served observations may have none. Compute the requested change from suitable observations when needed, rather than treating absent calculations as zero.
- Keep annual-summary rows M13, Q05, and S03 separate from regular months, quarters, and half-years. BLS computes these summaries; they are not extra periods and are not necessarily arithmetic means for percent-change series.

## Core chain

Discover the survey only when the topic is unclear, resolve and verify the SeriesID, then choose latest or history. For one current-value question, use `bls_get_latest` and report its observation period. For several current values, batch history is more quota-efficient than a separate latest request per series; ensure the chosen history window includes the needed periods.

## Workflows

For trends, request explicit history windows and reconcile the served bounds before joining the pieces. Longer histories need multiple windows within the deployment's allowance. Compare matching periods across series rather than assuming their newest observations share a date. Distinguish an index level, net change, and percent change in the answer.

Large results are staged as a DataCanvas table when canvas is enabled, and the response carries `dataset.name`. Call `bls_dataframe_describe` with that name for the staged table and column names before writing SQL, then `bls_dataframe_query` with a read-only query. Use the actual returned table name in SQL. Tables expire at their reported expiry. With canvas disabled, full results return inline.

Use a single SELECT statement, optionally with CTEs, joins, aggregates, or window functions. Query only described dataframe tables, not system catalogs or external files. For observation arithmetic, use `value_numeric` and keep regular-period rows separate with `is_annual_average`. Partition windows by SeriesID and order by year and period; verify cadence and gaps before interpreting row-based offsets as calendar changes.

Materialize an intermediate query result when subsequent analysis needs the full result beyond its inline preview. Inspect truncation notices and distinguish returned rows from the complete registered table. Choose a fresh intermediate name if one is already taken; do not assume a drop tool is available. Dataframe SQL does not consume BLS API quota.
