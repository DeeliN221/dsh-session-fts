# Session full-text search

Search every earlier session on this machine by content.

- **Local only.** A derived SQLite FTS5 index lives at `~/.dsh/session-fts.sqlite`. Nothing leaves the machine, and deleting the file only makes the plugin rebuild it from the session logs.
- **Chinese text works.** Each CJK character is indexed as its own token and a query matches consecutive characters, so `全文搜索` finds the literal substring inside a sentence. Latin words match by word and prefix (`sqlite` also finds `sqlite3`).
- **Time range.** Today, last 7 / 30 / 90 days, all time, or custom dates. Default: last 30 days.
- **Filters.** Workspace, author (me / assistant / tool output), subagent sessions, relevance or recency order.
- **Agent tool.** `session_fts_search` searches the current workspace by default (`scope: "all"` for every workspace) and skips the current session.

Open it from **Session search** in the left sidebar. Selecting a result opens that session.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `path` | `~/.dsh/session-fts.sqlite` | Absolute index path |
| `indexToolOutput` | `false` | Also index tool calls and results (larger, noisier) |
| `defaultDays` | `30` | Agent tool range when no dates are given; `0` = all time |
| `maxResults` | `20` | Sessions per page |
| `maxDocChars` | `20000` | Characters indexed per message |
| `includeSubagents` | `false` | Include subagent sessions by default |

Changing `indexToolOutput` or `maxDocChars` rebuilds the index.

## Limitations

- A result opens the session, not the exact message.
- User messages are indexed only when a person wrote them; injected context (skill catalogs, runtime context) is skipped. Reasoning is never indexed.
