# Every Request records the prefix it handed the model

- **Date:** 2026-09-17
- **Type:** feature
- **Scope:** `core`, `docs`

[中文版](2026-09-17-request-prefix-fingerprint.zh.md)

`request_begin` carries a fingerprint of the prefix that Request sent: a sha256 over the
fingerprinted records, a second hash over the fixed head alone (`session_meta` plus the
tool-list record), the number of records covered, the serialization's length, whether the
Request extends the previous one byte for byte, and the thinking level it carried.

## Details

- The block is stamped in one place by the builder and every field is optional: an old reader
  sees the payload it always did, and old Traces replay unchanged.
- A compaction Request is stamped as well, and deliberately does not become the baseline a
  later turn Request is measured against — a compaction that fails leaves the previous
  context current, and the next turn still extends the prefix that was live before it.
- Only payloads are fingerprinted: the envelope's `timestamp` never reaches the model, so
  including it would report a prefix rewrite whenever a message was rebuilt.
- The engine's own count of what it has sent advances only on a committed Request, so a
  retried attempt — which commits nothing — never counts its input twice.
