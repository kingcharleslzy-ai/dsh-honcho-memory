# Operations, health checks, and rollback

## Backend health

For the official local Docker default:

```bash
curl http://127.0.0.1:8000/health
```

Expected response:

```json
{"status":"ok"}
```

An HTTP health response only proves the API process is reachable. After DSH is
configured, use `memory_status` and a small write/read test to verify the queue
and deriver:

1. call `memory_status` and record the workspace and peer IDs;
2. store a disposable, distinctive fact with `memory_store`;
3. find it with `memory_search`;
4. confirm queue pending/in-progress counts eventually return to zero;
5. delete test data only if you have separately listed and backed up its exact ID.

If conclusions, summaries, or representations never appear, inspect the Honcho
deriver and model-provider logs. A healthy API with a stopped deriver is not a
working memory system.

## Upgrade

Use the DSH plugin manager for the target profile, then restart DSH using the
same service manager or terminal command used for the original installation.
One common installation form is:

```bash
dsh plugin --profile web add dsh-honcho-memory@0.5.2
```

Before relying on an upgrade, test the plugin tree in a disposable profile or
temporary DSH instance if your deployment supports it.

Versions through 0.5.1 shipped environment-specific defaults. Before upgrading
an installation that omitted explicit configuration, record its current
`baseUrl`, `workspace`, and peer IDs and add them to the profile patch. The
adapter does not migrate or rename existing Honcho data.

## Rollback

Install a known version explicitly, restart DSH, and run `memory_status` again:

```bash
dsh plugin --profile web add dsh-honcho-memory@VERSION
```

Rolling back the DSH adapter does not delete Honcho workspaces, sessions,
messages, or conclusions. Newer canonical data may remain stored even if an
older adapter does not query it.

## Network and privacy

- Prefer localhost, a private network, VPN, or authenticated HTTPS.
- Do not expose an unauthenticated self-hosted Honcho port to the public internet.
- The DSH process must be able to reach `baseUrl`; browser reachability alone is
  not sufficient.
- The plugin sends captured DSH messages to the configured Honcho endpoint.
- Honcho may call external model providers configured for embeddings, summaries,
  derivation, and dialectic. Review those providers before storing sensitive data.
