# A product design document and UI prototype in the Web App's public docs

- **Date:** 2026-09-17
- **Type:** docs
- **Scope:** `web`, `docs`

[中文版](2026-09-17-product-design-doc.zh.md)

`packages/web/public/docs/product-design.html` is one self-contained page (no external
dependencies, dark mode included) that answers what the product is, how it runs, and what each
screen does: a reading guide, the product overview, the object model and execution model, the
process and storage architecture, six runtime sequences (a request, the reconnect ladder,
compaction, resume, inbound messaging, context assembly), a module-by-module operations
manual, sixteen static prototypes, the role matrix, a glossary and appendices.

## Details

- The prototypes are redrawn from the real layout, navigation and Chinese copy, so they read as
  documentation of the shipped UI rather than a wish list; every credential, session id and
  number in them is demo data.
- Facts that are easy to get wrong are stated with their source: the plugin library holds 12
  packages (data, not code, resolved by the core loader), the built-in toolset is 7 tools, and
  the four `stop_reason` values carry their detail on `error_code`.
- Appendix E collects the places where the repository's prose and its code disagree, with the
  code treated as authoritative, so the next reader meets the discrepancy as a written note
  instead of a surprise.
- Living under `public/` means the page ships with the Web App and is served at
  `/docs/product-design.html` on the next Web build; it is not wired into the docs site.
