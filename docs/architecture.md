# Architecture and data model

## Component boundary

`dsh-honcho-memory` is a DSH host adapter. It does not contain or start the
Honcho server.

```text
DeepSeek Harness
  └─ dsh-honcho-memory
       └─ bundled dsh-honcho-memory-core
            └─ Honcho v3 HTTP API
                 ├─ API server
                 ├─ PostgreSQL + pgvector
                 ├─ Redis / work queue
                 └─ deriver and configured model providers
```

The bundled core uses native `fetch` and has no runtime dependencies. It maps
the Honcho v3 workspace, peer, session, message, conclusion, representation,
peer-card, context, search, dialectic, queue, and dream endpoints. The DSH layer
only translates DSH lifecycle events and tool calls.

## Directional memory

Honcho conclusions have an observer and an observed peer. The defaults are:

```text
deepseek -> user
```

Do not reuse one assistant peer ID for several agents. If multiple clients use
the same Honcho workspace, give each assistant a distinct peer ID so their
representations remain directional.

## Canonical shared knowledge

The optional shared layer uses:

```text
shared-knowledge -> user              # durable user facts and preferences
shared-knowledge -> shared-knowledge  # project and general knowledge
```

Ordinary transcripts remain in the local assistant session. Only explicit,
self-contained conclusions should be promoted to the canonical observer.
Other agent clients are not configured by this DSH package; they must point to
the same backend/workspace and implement the same convention themselves.

## Safety properties

- system-injected memory and known tool/plugin payloads are excluded from capture;
- long messages are split before submission;
- writes are serialized per plugin instance;
- read-time similarity deduplication does not mutate Honcho;
- English and predominantly CJK text use different conservative similarity rules;
- search results are round-robin merged across local, shared, and message sources;
- tidy is dry-run unless given the exact confirmation token;
- dream requires explicit confirmation because it consumes backend model resources.

## Upstream boundary

This project does not fork the Honcho server, Honcho MCP, official Codex
integration, or the Hermes memory provider. It is a community DSH adapter built
against the public Honcho v3 API.

- [Honcho](https://github.com/plastic-labs/honcho)
- [Honcho MCP](https://github.com/plastic-labs/honcho/tree/main/mcp)
- [Official Codex integration](https://github.com/plastic-labs/codex-honcho)
- [Official Hermes guide](https://github.com/plastic-labs/honcho/blob/main/docs/v3/guides/integrations/hermes.mdx)
