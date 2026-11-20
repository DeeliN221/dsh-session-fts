# Shared session retrieval v1 — opt-in candidate

This integration leaves `retrievalMode: legacy` as the memory default. Install both candidate packages into a separate profile, give FTS a **new absolute index path**, and configure the same explicit `userId`, `deviceId`, and `profile` for both. FTS refuses incompatible index identity instead of rewriting an old database. Native archives remain authoritative and unchanged.

FTS options example (plugin configuration object):
```js
{ userId: 'my-user', deviceId: 'mac', profile: 'integration',
  path: '/isolated/state/session-fts-v2.sqlite', sourceId: '/isolated/native-archive',
  refreshIntervalMs: 0 }
```

Memory options example (plugin configuration object):
```js
{ memory: {
  retrievalMode: 'shared', userId: 'my-user', deviceId: 'mac', profile: 'integration',
  stateDir: '/isolated/state/memory',
  centralUrl: 'http://existing-central:8787', tokenFile: '/private/device-tokens.json',
  workspaceMappings: {
    '/local/repo': [{ deviceId: 'work', cwd: '/remote/repo' }]
  }
} }
```
`stateDir` gets a deterministic `shared-<identity hash>` subdirectory. One active producer must own each shared-state directory; give independently running profiles separate directories. The legacy outbox is neither consumed nor deleted. Do not put bearer tokens in version control.

## Contract and authorization

The Cordis `sessionRetrieval` service binds identity at registration. `search(request, principal, signal)` takes query, mode, scope (`workspace` or explicit `all`), cwd, from/to, limit, and excludeSessionId. Time bounds accept epoch milliseconds or timezone-qualified ISO values. Only adapter configuration authorizes remote workspace mappings; a matching cwd on another device grants nothing. A remote result is rechecked for user/profile, configured device/cwd, time, current local session, stable evidence id, and duplicate id. Evidence identity is SHA256(JSON([userId,deviceId,profile,sessionId,seq])). Provenance, workspace and timestamp remain explicit reference fields. Legacy central rows keep their previous IDs and `seq:null`; no native seq is fabricated.

FTS owns the existing local search implementation, human API, tool, lexical worker, revision cache and semantic worker. Memory supplies a remote adapter and consumes that same local search implementation on outage. A successful central response, including no hits, does not query another database. Authentication failures fail closed. Transport failure selects local FTS; results are never unioned across local/central databases. Central keeps its existing endpoint and schema, adds nullable seq, and runs SQLite in a bounded worker, without another daemon.

## Bounds and lifecycle

Automatic shared recall: 1800 ms total deadline, remote up to 800 ms, 2 concurrent requests; at most 5 rendered hits, 1200 characters per snippet and 4800 characters per context. Shared query results carry stable references. The original archive remains available for failed or unfinished turns and tool evidence; local tool-output indexing stays explicit. Ordinary topics make no recall query and one turn admits recall only once.

Lexical startup reconciliation and session events remain active. Default metadata reconciliation stays at 60 seconds for other writers; set `refreshIntervalMs:0` for a sole event-driven owner. It checks stamps before reading logs. Semantic inference starts only after a semantic query. Append refreshes use a persisted cursor; destructive lexical changes invalidate the semantic generation. Interrupted partial chunks are removed before retry, with cross-process writer fencing preserved.

Shared memory replays native events beyond durable per-session checkpoints at startup, coalesces live sessions, and retries failed capture/outbox work every 30 seconds. Only direct user and visible model text is synchronized; injected references are excluded. Durable outbox precedes checkpoints. Overflow fails without dropping old rows; native replay recovers later. Central IDs make retries idempotent.

## Cutover and rollback gates

1. Back up central DB consistently and preserve old local FTS/memory DB paths and original package versions.
2. Start the candidate in isolation. Confirm native-event coverage, device/workspace boundaries, identical human/automatic event IDs, offline fallback, package contents and archive replay.
3. Only enable shared mode for the covered native DSH corpus. Keep the legacy CLI/importers for Codex/OpenCode/other unserved corpora and any device/profile not yet validated. Do not globally disable their jobs.
4. Roll back by restoring prior packages/configuration and `retrievalMode:legacy`, pointing back at retained old paths. The additive central seq column is readable by the old central implementation (tested on a fixture copy). Restore the backup for a byte-for-byte central rollback. Never delete native archives.

The delivered evidence covers one Mac and simulated authenticated devices. An actual second-device profile run and live production GUI cutover require separately allocated resources and are not claimed as passed.
