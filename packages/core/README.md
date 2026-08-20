# dsh-honcho-memory-core

Host-neutral Honcho v3 client and memory engine used by `dsh-honcho-memory`.

The package keeps Honcho's official peer/session/message/conclusion model intact.
It adds two client-side policies:

- perspective-safe recall: assistant-specific conclusions remain isolated;
- shared knowledge: durable facts can be published under a canonical
  `shared-knowledge` observer and queried by every host without pretending that
  all assistants are the same peer.

The package has no runtime dependencies and uses the platform `fetch` API.
Destructive conclusion cleanup is always dry-run unless an explicit confirmation
token is supplied.
