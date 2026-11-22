# Second-round acceptance — 2026-11-20

This candidate preserves the first-round runtime implementation. Its new version identifies expanded cross-device/native-tool evidence, not an extra daemon, API, or a claimed fix to installed DSH core. First-round commits and packages remain archived.

## What is verified

Two physical devices participated: macOS `xbugsmba.local` (Node v26.6.0) and the NAS container (Node v24.11.1). Each ran actual DSH Cordis/AgentLoop, native JSONL persistence, session-query, FTS and memory plugins. A deterministic LlmAdapter produced model responses; no paid/provider model was called. The NAS owned the isolated central SQLite worker. Loopback ephemeral ports were connected by temporary SSH forwarding; this is an actual network path, not a production network benchmark.

Both devices produced the same session id and user-event seq. Different device/user identities retained distinct evidence IDs. Matching workspace names did not authorize remote access. Explicit device/cwd mappings enabled retrieval; workspace/time restrictions, same-device current-session exclusion, cross-user denial, disconnected local-only fallback, authentication failure without fallback, reconnect outbox delivery, replay idempotence, absence of recursive capture, and cooldown/no duplicate injection were checked. Other-user ingestion is separately confirmed as accepted before asserting that another principal cannot find it (see user-isolation.json).

Real pre-step session-reference events were persisted on both endpoints. Their device/session/seq/evidenceId matched the originating endpoint's human FTS HTTP search. This verifies the human HTTP service contract, not production browser login or navigation. The custom FTS tool and the native session-query tools are separate providers.

## Native NAS failure and scoped core candidate

A read-only production SDK probe found a corrupt cold archive in an unrelated workspace. Native SQLite search cold-decodes every persisted candidate before filtering. A request-scoped cold-read patch reproduces and fixes this failure mechanism in an isolated real SDK fixture, using the actual native tool registrations. Corruption inside the requested scope still fails; unauthorized reads remain rejected. Non-target persisted rows remain indexed and cursor pagination works. Production runtime is not patched. The original production error cause chain was not available, so the found bad archive is not claimed to be its only cause.

The source patch needs upstream review, target-version typecheck and full core regression before a real runtime release. A JavaScript-equivalent patch and executable SDK regression are included in the evidence bundle. This plugin version alone does not fix native `session_search`.

## Reproduction and evidence locations

Canonical delivery root: `/data/workspace/state/dsh-plugin-consolidation-20261120-1306/search/`.

- `FOLLOWUP_REPORT.md`: final measurements, status, commits, scope, remaining limits.
- `followup/MEASUREMENT_PLAN.md`: frozen before measurements.
- `followup/core-validation.json`: original/candidate native tool results; source and executable patches adjacent.
- `followup/dual-device-raw.json`, `dual-device-result.json`, `user-isolation.json`: per-call outcomes and same-evidence assertions.
- `followup/performance-*.json`: retained per-query latency arrays and cold/semantic measurements. Early fixture failures are retained and excluded from final successful-run percentiles.
- `followup/NAS_MINIMAL_CONFIG.md`: exact providers, isolated config, maintenance and rollback.

Fresh-process cold, local wrapped retrieval, local human HTTP, and Mac→SSH→NAS central paths are measured separately. The corpus and sample counts are declared in the measurement plan. Remote latency includes actual transport; it is not comparable to an in-process cache lookup. Performance fixture events use the native event shape; the independent two-device acceptance uses actual emitted events.

## Remaining limits

No production switch, worker restart, live GUI/login test, merge, publish, source retirement, archive repair, long-duration soak, full-production-scale corpus, or multi-producer shared-state run. The semantic test uses a pre-existing offline model cache; it does not time a download. Old CLI/importers remain for corpora and devices not covered by shared native capture. Old configuration and data paths are preserved for rollback.
