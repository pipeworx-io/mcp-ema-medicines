# @pipeworx/ema-medicines

European Medicines Agency medicines register — every medicine authorised for the EU market through the centralised procedure, plus the committee opinions still awaiting a European Commission decision — the EMA's herbal-medicine inventory (plant/botanical substances the Committee on Herbal Medicinal Products (HMPC) has assessed, with links to each herb's EU herbal monograph and assessment-report PDFs) — and seven sibling XLSX reports from the same download-medicine-data page: shortages, direct healthcare professional communications (DHPC), referrals, periodic safety update single assessments (PSUSA), orphan designations, paediatric investigation plans, and post-authorisation procedures.

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1856+ live data sources. This is an independent, unofficial integration — not affiliated with, endorsed by, or published by the upstream provider.

## Tools

- `ema_recent_approvals(from?, to?, month?, category?, limit?)` — new EU marketing authorisations in a date window. Answers "which drugs did the EMA approve in July 2026".
- `ema_chmp_opinions(opinion_status?, since?, category?, include_decided?, limit?)` — medicines the CHMP (human) or CVMP (veterinary) has recommended for or against approval and the Commission has not yet decided. Answers "what did the CHMP recommend this month".
- `ema_medicine_search(query, status?, category?, orphan_only?, limit?)` — search by brand name, INN / active substance, therapeutic area, indication text, ATC code or authorisation holder.
- `ema_medicine(name)` — the full published record for one medicine, by brand name or EMA product number.
- `ema_recent_updates(since?, status?, category?, limit?)` — register entries that changed most recently, including withdrawals and suspensions.
- `herb_search(name?, latin?, botanical?, therapeutic_area?, status?, limit?)` — search the EMA herbal-medicines inventory (plant/herb substances) by common name, Latin/botanical name, therapeutic area, or HMPC assessment status. Answers "which herbs has the EMA assessed for sleep disorders", "is there an EU herbal monograph for chamomile".
- `herb(latin_name?, common_name?)` — the full inventory record for one herb, plus `monograph_url` and `assessment_report_url` scraped (link extraction only) from the herb's EMA page. Answers "what is the EMA monograph link for valerian root".
- `herb_monograph_status(latin)` — HMPC assessment status, code/label, and the outcome of the European assessment for one herb by Latin name; explains why well-established-use vs traditional-use is NOT a field the register carries (see below).
- `ema_shortages(query?, status?, since?, limit?)` — EU medicine shortages: status (ongoing/resolved/discontinued), forms/strengths affected, alternatives availability, start-of-shortage date. The EU counterpart of the FDA shortages tool.
- `ema_dhpc(query?, dhpc_type?, since?, category?, limit?)` — Direct Healthcare Professional Communications: urgent EU-wide safety alerts to prescribers (adverse events, quality defects, shortages, safety signals).
- `ema_referrals(query?, status?, safety_only?, category?, since?, limit?)` — EU referral procedures (Article 31/20/107i and related) — safety and scientific reviews of a medicine or substance class.
- `ema_psusa(query?, outcome?, since?, limit?)` — Periodic Safety Update Report Single Assessments: the EU-wide joint pharmacovigilance review per active substance.
- `ema_orphan_designations(query?, status?, since?, limit?)` — EU orphan medicinal product designations for rare-disease treatments (Positive/Withdrawn/Expired/Negative).
- `ema_pip(query?, decision_type?, since?, limit?)` — Paediatric Investigation Plans: the agreed/waived plan for studying a medicine in children.
- `ema_post_authorisation(query?, status?, category?, since?, limit?)` — post-marketing variations and label-change activity for centrally authorised medicines.

## Auth

Keyless.

## Data sources

- <https://www.ema.europa.eu/en/documents/report/medicines-output-medicines-report_en.xlsx> — the whole register as one XLSX, regenerated daily around 18:00 CET. Listed at <https://www.ema.europa.eu/en/medicines/download-medicine-data> alongside ten sibling reports (orphan designations, shortages, referrals, post-authorisation, DHPC, herbal, PSUSA, paediatric plans, MRLs).
- <https://www.ema.europa.eu/en/documents/report/medicines-output-herbal_medicines-report_en.xlsx> — the herbal-medicines inventory, same file family, regenerated daily. 251 data rows collapse to 204 distinct herbs (a handful of rows repeat identically 2-4x in the sheet; `herb_search`/`herb` dedup on the per-herb page URL). Each row carries a per-herb page URL (`https://www.ema.europa.eu/en/medicines/herbal/<latin-name-slug>`) whose "Documents" section links the monograph and assessment-report PDFs that `herb` scrapes.
- Seven sibling reports, same file family and daily regeneration, listed on the same download page:
  - `medicines-output-shortages-report_en.xlsx` (`ema_shortages`)
  - `medicines-output-dhpc-report_en.xlsx` (`ema_dhpc`)
  - `medicines-output-referrals-report_en.xlsx` (`ema_referrals`)
  - `medicines-output-periodic_safety_update_report_single_assessments-report_en.xlsx` (`ema_psusa`) — **note the filename is NOT `medicines-output-psusa-report_en.xlsx`**; that guess 404s.
  - `medicines-output-orphan_designations-report_en.xlsx` (`ema_orphan_designations`)
  - `medicines-output-paediatric_investigation_plans-report_en.xlsx` (`ema_pip`)
  - `medicines-output-post_authorisation-report_en.xlsx` (`ema_post_authorisation`)
  - Deliberately **not** built: `medicines-output-maximum_residue_limits-report_en.xlsx` (veterinary residue limits, out of scope for this pack) and `medicines-output-opinions_outside_eu-report_en.xlsx` (niche Article 58 scientific opinions on non-EU products).

### Things worth knowing before you touch this

- **Sheet layout is not row 1.** Sheet `Medicine`: row 1 is a provenance banner, rows 2–8 are blank, **row 9 is the header** (39 columns), rows 10+ are records. The header row uses **inline strings, not shared strings** — a parser that only resolves shared strings reads the header as blank.
- **Self-closing cells are a trap.** `<c r="E10" s="1"/>` is an empty cell. A greedy attribute match in the cell regex swallows the `/` and runs on to the *next* cell's `</c>`, silently shifting every value in the row by one column. `src/xlsx.ts` uses a lazy match for exactly this reason.
- **Use `Marketing authorisation date` for "new approvals", not `European Commission decision date`.** The Commission decision date also moves on post-authorisation variations — 80–141 rows a month — while genuine initial authorisations run 4–12 a month. Filtering on the wrong one answers a different question without looking wrong.
- **The committees meet monthly**, so "what did the CHMP recommend this month" lands on an empty window most of the time. When `since` filters everything out, `ema_chmp_opinions` returns the outstanding opinions and states in `window_note` that none were adopted in the window asked for — the question is about the pipeline, not the calendar.
- **`Opinion status` alone does not mean "pending".** Authorised and withdrawn products keep their historical opinion fields. Pending means `Medicine status` starts with `Opinion`; `ema_chmp_opinions` applies that by default and exposes `include_decided` to widen it.
- **EMA rate-limits bursts** and answers a 429 with ~40 KB of HTML rather than JSON — reproduced at five sequential requests. A per-call download is not viable, so the pack holds one parsed copy for six hours and the Cloudflare edge cache absorbs repeats on top of that. If a refresh fails while an earlier copy is in hand, the earlier copy is served rather than an error.
- **Dates are `DD/MM/YYYY` upstream** and are converted to ISO on the way out.
- **`data.europa.eu` is not a route to this data.** The EMA datasets are still listed there but frozen at `modified: 2019-01-09`, and every distribution URL 404s against the pre-redesign `/sites/default/files/Medicines_output_*.xlsx` path.
- The register covers the **EU centralised procedure only** — nationally authorised products are not in it.

### The 7 sibling reports — things worth knowing

- **The PSUSA filename does not match its tool/report name.** It is `medicines-output-periodic_safety_update_report_single_assessments-report_en.xlsx`, not `medicines-output-psusa-report_en.xlsx` — the latter guess 404s. Verified by fetching `en/medicines/download-medicine-data` and grepping the actual `<a href>` list rather than guessing the pattern from the other reports' names.
- **`post_authorisation`'s URL column is `AA`, out of alphabetical order** with the rest of the header row (`A, AA, B, C, ...Z`). The generic loader reads whatever column letter the sheet XML actually uses per header cell, so this is harmless — but do not "fix" it by assuming A..Z order if you ever hand-edit the field map.
- **`orphan_designations` has no `Category` column at all** (the register is human-only) — unlike `dhpc`, `referrals` and `post_authorisation`, which are a Human/Veterinary mix and take a `category` filter.
- **A rare EMA source-data artifact**, not a parser bug: PSUSA's own export occasionally splits one comma-containing active-substance string into two adjacent shared-string cells with a stray embedded `&quot;` (~0.2% of rows, e.g. `dienogest` / `ethinylestradiol (prolonged-release tablet)"` as two separate cells) — those rows still parse, just with a slightly garbled `category`/`substances_in_scope` value. Not worth a special case for a handful of rows.
- Each report gets its own `ReportSpec` (URL, column-header → field map, date fields) fed through one generic `loadReport()`/`reportDataset()` pair — same row-9-is-the-header parsing and same one-download-per-six-hours cache as the main register and the herbal inventory, just parameterised instead of copy-pasted seven times.
- All seven probed live 2026-09-13 with real current rows (e.g. shortages: Eskazole/Zentel ongoing since 2026; DHPC: a Jentadueto quality-defect notice dated 2026-08-20; orphan designations: a satralizumab positive designation dated 2026-06-22).

### Herbal tools — things worth knowing

- **Same sheet layout, different columns.** Row 1 banner, **row 9 is the header**, rows 10+ records. Columns: Latin name, Combination, English common name, Botanical name, Therapeutic area, Status, Outcome of European assessment, Additional information, three date columns, and `Herbal medicine URL` (the per-herb page).
- **The sheet repeats some herbs' rows identically.** Fragariae folium appears 4 times with byte-identical values across every column; `loadHerbal()` dedups on the per-herb page URL (204 distinct herbs from 251 data rows, verified 2026-09-07).
- **The per-herb page URL slug is the LATIN name**, not the common name (`valerianae-radix`, not `valerian-root`) — a couple of herbs get a `-0` suffix (`taraxaci-officinalis-radix-0`) for reasons EMA doesn't document.
- **`herb` scrapes links, not prose.** A herb's EMA page lists every revision's documents as plain relative `href`s under `/en/documents/<category>/<filename>_en.pdf`. The path category tells you the document type (`herbal-monograph` = the monograph, `herbal-report` = the assessment report — the only two categories `herb` reads); the filename prefix tells you its currency (`final-` beats `draft-` beats anything starting `superseded`). `herb` picks the best-ranked link per category. It does **not** read the page's prose sections — the FAQ-style "well-established use" / "traditional use" explainer text lives there but scraping it is out of scope for this pack.
- **The register does not carry a well-established-use vs traditional-use field, at all.** Checked every distinct value of `Outcome of European assessment` across the full 2026-09-07 sheet: `European Union herbal monograph`, `European Union herbal monograph;European Union list entry`, `European Union list entry`, `Public statement` — none of the four say which use category applies. That classification is set **per-indication inside the monograph document itself** (Article 10a "well-established use" vs Article 16a "traditional use"), and a single herb can carry both for different indications — valerian root's monograph, for instance, is well-established use for mild nervous tension and sleep, and traditional use for mild mental stress. `herb_monograph_status` returns `use_classification: null` with a note explaining this, rather than guessing from prose.
- **A herb without a finalised assessment can still have a final monograph.** Assessment `status` (F/P/C/D/R) tracks the periodic-review cycle, not first publication — `Taraxaci officinalis radix` carries `R: Rapporteur assigned` (an ongoing *review*) but its page already has a `final-` monograph and assessment report from years earlier. Rank on the filename prefix, never on the register's `status` field.
- **An early-stage herb may have no assessment report yet.** `Cannabis flos` (`D: Draft under discussion`) has only a `draft-public-statement-*.pdf` under `herbal-monograph` and nothing at all under `herbal-report` — `herb` returns `assessment_report_url: null` rather than erroring.

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "ema-medicines": {
      "url": "https://gateway.pipeworx.io/ema-medicines/mcp"
    }
  }
}
```

### What this endpoint actually serves

`tools/list` at `https://gateway.pipeworx.io/ema-medicines/mcp` returns the tools in the table
above **plus the shared Pipeworx meta-tools** — `ask_pipeworx`,
`discover_tools`, `search_within`, `remember`/`recall` and the rest of the
gateway-wide set. So the tool count you see is larger than this table: a
single-pack endpoint currently lists roughly 30 shared tools alongside the
pack's own. The connection's `initialize` response states its exact scope, and
is the authoritative answer for a given day.

This is deliberate, not multiplexing by accident. The meta-tools are what let a
scoped connection answer a question this pack does not cover — via
`ask_pipeworx`, which routes across the whole catalog — without you adding a
second MCP server. There is currently no way to mount a pack endpoint without
them; if the extra schemas cost you more context than the routing is worth,
connect to the full gateway once rather than to several pack endpoints.

Or connect to the full Pipeworx gateway to get every pack's tools listed
directly, instead of just this one's:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

Both URLs reach the same gateway and the same 1856+ data sources. The
only difference is which pack's tools are listed **directly**; `ask_pipeworx`
reaches all of them from either one.

## No MCP client? Call it over HTTP

```bash
curl -X POST https://gateway.pipeworx.io/v1/tools/ema_recent_approvals \
  -H 'Content-Type: application/json' \
  -d '{"month":"2026-07"}'
```

No account needed for the first calls. Inspect any tool: `GET https://gateway.pipeworx.io/v1/tools/ema_recent_approvals`. Find one: `POST https://gateway.pipeworx.io/v1/tools/search_packs` with `{"query":"..."}`.

## Run it from npm

`@pipeworx/mcp-ema-medicines` is a local stdio bridge to the Pipeworx gateway: your MCP client
starts it with `npx`, and it forwards every call to the same
`https://gateway.pipeworx.io/ema-medicines/mcp` endpoint shown above. It needs network access;
there is no offline mode.

```json
{
  "mcpServers": {
    "ema-medicines": {
      "command": "npx",
      "args": ["-y", "@pipeworx/mcp-ema-medicines"]
    }
  }
}
```

Without a key it calls anonymously, capped at 50 calls a day. A free account
raises that to 200 a day: get a key at https://pipeworx.io/signup and add
`"env": { "PIPEWORX_API_KEY": "<your key>" }` to the server entry.
The key is sent as a Bearer token, the same way a hosted connection sends it,
so calls are metered and billed exactly as they are there.

It lists **only** this pack's tools by default. Set `PIPEWORX_META_TOOLS=1` to
also list `ask_pipeworx` and the other gateway-wide tools.

Behind an HTTPS proxy: Node's built-in `fetch` does not read `HTTPS_PROXY` by
default. Newer Node releases honour it when `NODE_USE_ENV_PROXY=1` is set; check
your Node version's documentation.

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English —
this works on the pack endpoint above as well as on the full gateway:

```
ask_pipeworx({ question: "your question about Ema Medicines data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
