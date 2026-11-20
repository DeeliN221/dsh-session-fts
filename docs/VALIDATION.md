# Validation: layered search 0.2.0-zzl.1

## Repository and artifact

Maintained fork: https://github.com/DeeliN221/dsh-session-fts . Community upstream: https://github.com/xuhuaiqu/dsh-session-fts . Runtime candidate: 80db8c2; subsequent validation-only commits do not alter shipped runtime code. The package is `dsh-session-fts-0.2.0-zzl.1.tgz`, installed through `dsh plugin --profile web add` with dependency build scripts disabled. Native runtime imports and actual model inference succeeded without those scripts on macOS arm64.

## Functional evidence

`pnpm test` passes the lexical, cache, revision indexing, browser component behavior and semantic worker tests. Semantic integration exercises real sqlite-vec with deterministic embeddings through a test module loader. Coverage includes Chinese phrase recall, metadata filters, empty role selection, bounded LRU eviction/invalidation, foreign database preservation, persistent index reopen, unchanged revision skips, incomplete scan reporting, stale browser response cancellation, pagination, locale/status reporting, vector model identity changes, source deletions/edits, native filtering before top-k, bounded queue and worker teardown.

`pnpm run check` validates the Host, Client and worker JavaScript syntax. The real model smoke passed with `SEMANTIC_MODEL=/Users/xbugs/.dsh/models/Xenova/multilingual-e5-small SEMANTIC_MODEL_CACHE=/Users/xbugs/.dsh/models node tests/semantic-smoke.js`: a Chinese query about eating apples ranked the English fruit message above the English network message using the actual q8 multilingual-e5-small model on CPU. Initial remote warmup failed on direct network access; preloading the model through the system HTTP proxy and selecting its local directory resolved it. No alternate model endpoint was used.

## Running Web application

The plugin is active at the existing https://mac.xbugs.site/ application. Its authenticated status endpoint reports lexical indexing complete without errors and semantic indexing progressing with the local model. Live title/fulltext/semantic requests returned HTTP 200 with successful results; only aggregate counts were recorded. Browser checks verified the sidebar entry, mode buttons, title/fulltext no-match states, loading/progress status, and a 390px viewport whose search page scrollWidth equals clientWidth. Desktop and narrow interaction checks used the existing supported host, not a replacement server. A screenshot was captured locally, but image inspection was unavailable in the agent runtime; visual pixel review and exhaustive keyboard/theme testing remain unverified.

The original sidebar title input remains available. This plugin adds a separate search page; it does not replace that input. Existing unrelated sidebar import errors observed in host logs predate the search plugin and are outside this change.

## Performance

See [the measurement conditions and raw samples](LAYERED-SEARCH.md#验证). The targeted optimization reduces FTS result materialization: only current-page snippets load full text. The same broad-match synthetic query is about four times faster, with roughly half the peak RSS. Caching is bounded by entries and bytes. Local benchmark numbers exclude browser/transport and semantic model inference; the live smoke timings are single observations, not latency guarantees. Semantic native exact KNN remains linear in eligible vectors despite running off the Host thread.

## Operational notes

The current profile depended on two missing temporary sidebar archives. Installation restored those archives from the already-installed identical package contents before adding this plugin. The search package itself lives under the persistent DSH plugins directory. Profile changes are limited to adding this bundle and selecting the preloaded local semantic model. Original Session logs are untouched.
