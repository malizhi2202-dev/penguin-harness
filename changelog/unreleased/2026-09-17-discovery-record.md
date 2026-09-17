# The next-investment discovery record, in the repository

- **Date:** 2026-09-17
- **Type:** process
- **Scope:** `discovery`

[中文版](2026-09-17-discovery-record.zh.md)

`discovery/penguin-next-investment/` keeps the record of one read-only discovery round: a fact
list assembled from the repository and the live data root, a breakdown into four sub-topics, and
for each sub-topic the five stages the round ran (brainstorm, competitive or upstream recon,
conclusion, panel verdict, review record), plus the round's roadmap.

## Details

- Every claim in the record cites either a file and line, a source file in the data root, or a
  document fetched from a first-party source, so a later reader can re-derive it instead of
  trusting it.
- The roadmap ends in a change list ordered evidence-first. Two of its items are no longer
  pending and were delivered as their own changes — the agenthub bump and the Request
  prefix fingerprint — while the rest remain a queue: being listed there is not a commitment.
- The record carries a dated status section beside that list, naming each item's state and the
  commit that delivered it, so a list written before the work cannot be misread as eight open
  items when two of them shipped.
- Only one sub-topic passed the review gate, and the record says so rather than presenting all
  four conclusions as equally settled.
- This is a process record, not product documentation: it is a snapshot of what one round
  concluded on one day, and the product design document is the artifact that gets maintained.
