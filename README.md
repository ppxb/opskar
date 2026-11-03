# OpenBot

This checkout targets a Web client and Linux hosts for a private operations workspace.
Agents keep their conversations, workspaces, queues and provider sessions on their host.
The host can run in Docker and use external AI providers.

The mobile application and the macOS and Windows distribution targets have been removed.
The Linux host still uses Electron. Its main process owns the agent services, local database,
browser, IPC boundary and shutdown sequence. The Web client also uses the shared renderer code.
Keep `src/main`, `src/backend`, `src/preload`, `src/renderer` and `packages/ui` together until the
host has a separate runtime. See [platform cleanup](docs/platform-cleanup.md).

## Deployment status

This cleanup does not provide a complete private Web deployment. The account application still
uses Cloudflare Workers, D1 and R2. Its production storage and runtime adapters, private login,
and local Signal configuration need a separate change.

The upstream Docker image runs a host and does not serve the Web client. Its default account
service and Web entry are operated by OpenBot. A release image does not include local source
changes. See [Docker](docs/docker.md), [self-hosted servers](docs/self-hosted-server.md),
[account service](apps/auth-api/README.md), and [Web client](docs/web-client.md).

For the upstream host image, use the supplied Compose file and seccomp profile:

```sh
cd docker
docker compose up -d
docker compose exec openbot openbot login
```

Keep the `/data` volume across container updates. It holds the database, workspaces, provider
sign-ins and encryption keyring. One volume belongs to one running host.

## Development

The dependency versions require Bun 1.4.2 and Node.js 24. Install the locked dependencies first:

```sh
bun install --frozen-lockfile
```

The existing development stack still starts the Electron host. The account application serves
the browser client at `/app`. Use the ports reported by the stack.

```sh
bun run dev
```

### Independent server: storage bootstrap

The independent server can initialize the database, agent store and mailbox without Electron:

```sh
bun run server:dev --data-dir .openbot/server
```

Bun starts this command, but the process uses Node.js 24 and the existing `tsx` loader. The
database uses `node:sqlite`. The installed Bun 1.3.14 cannot load that module; compatibility with
the declared Bun 1.4.2 has not been verified. A change to `bun:sqlite` is separate work.

The command requires an explicit data directory. On its first start, that directory must be empty.
It refuses existing desktop profiles before opening their database. Later starts recognize the
server's owner marker and use an exclusive lock. Do not share the directory with Electron.

The process prints its actual loopback address after both stores have initialized.
`GET /health/ready` reports `stage: "storage"`, the database schema version and
`credentialStorage: "unconfigured" | "ready"`.
Use `--port <port>` to choose a port. No application, account, agent, provider or scheduler routes
are enabled. The Web client is not connected to this entry.
The owner marker is not a replacement for database or credential migration.

All new storage paths belong to the explicit data directory:

| Path under the data directory | Contents |
| --- | --- |
| `openbot.db` | Shared database for agent records, threads and the mailbox. |
| `files/Agents/<agent-id>` | Agent workspaces. |
| `files/Shared` | Shared files. |
| `files/Shared/Transfers` | Attachment transfers. |
| `files/Downloads` | Downloaded files. |
| `avatars/agents` | Agent avatars. |
| `attachment-drafts` | Managed attachment drafts. |

The stores use their existing startup recovery and attachment maintenance. Saved agent IDs,
thread IDs, workspace paths and queue order remain authoritative. AgentService, providers and
queue execution are not started, so pending messages remain queued. The stores are internal
services; adding authenticated application routes is a later step.

Ctrl+C or SIGTERM closes the listener and database, then releases the directory lock. A parent
Node process can request the same shutdown over its private IPC channel. A crash can leave the
lock file behind; startup refuses it. Do not remove that lock until the recorded process has
been confirmed stopped. This step has no automatic crash recovery or takeover.

`bun run test:server-bootstrap` starts real Node child processes and writes its report and test
databases under `.openbot-build/server-bootstrap/`. It never opens the desktop profile.
`bun run test:server-storage` checks agent and mailbox persistence, duplicate message receipts,
directory isolation and initialization failure cleanup. Its artifacts are under
`.openbot-build/server-storage/`.

### Independent server credentials

Set `OPSKAR_CREDENTIAL_KEY_FILE` to a private key file supplied by your secret manager or deployment
system. The file must contain the canonical base64 encoding of 32 random bytes, with an optional
trailing newline. It must be outside the server data directory, including after symbolic links
are resolved. The server reads this file; it never generates, replaces or rotates it.

On Linux, use a regular file readable only by the service user, such as mode `0400` or `0600`.
On Windows, restrict its NTFS ACL to the service account; this implementation does not check ACLs.
Keep the key separately from data backups. Existing ciphertext cannot be recovered without it.

Without a configured key and without saved credentials, storage still starts and reports the
credential capability as `unconfigured`. A configured key must be valid. Saved credentials with
a missing or wrong key, an unreadable envelope, or failed authentication stop startup without
replacing the file. `ready` means that credential storage is available, not that a provider has
accepted a key or signed in.

Provider keys use `opskar-provider-credentials-v1.json` in the data directory. This must be a
regular file; a credential path that is a directory or symbolic link is refused. Each encrypted
value uses AES-256-GCM with a fresh 12-byte nonce, a 16-byte tag, and a versioned header. Authentication
binds the value to its provider identifier, so swapping encrypted provider entries is refused.
This does not prevent deleting an entire entry or replaying older ciphertext for the same provider.
Keep the data directory private. No credential read/write HTTP routes are provided yet.

The shared store remains compatible with the desktop's existing envelope and operating-system
cipher. The Node host uses its own file and does not import or decrypt desktop credentials.
`bun run test:server-credentials` uses synthetic values and real Node processes. Its report is
`.openbot-build/server-credentials/report.json`; no secret values enter the report.

## Commands

| Command | Use |
| --- | --- |
| `bun run dev` | Start the existing host development stack. |
| `bun run dev:api` | Start the account application and Web entry. |
| `bun run server:dev --data-dir <directory>` | Start the independent storage bootstrap on loopback. |
| `bun run test:server-bootstrap` | Check the Node bootstrap, shutdown and data preservation. |
| `bun run test:server-storage` | Check agent and queue persistence without starting execution. |
| `bun run test:server-credentials` | Check encrypted credentials, restart, corruption and redaction. |
| `bun run dev:status` | Show this checkout's development processes. |
| `bun run dev:stop` | Stop this checkout's development stack. |
| `bun run typecheck:node` | Check host, backend, preload and script types. |
| `bun run typecheck:renderer` | Check the shared renderer and UI types. |
| `bun run typecheck:api` | Check the account and Web application types. |
| `bun run test:related -- <source>` | Run related tests with one worker. |
| `bun run test:desktop -- <path>` | Run one existing host or renderer test file. |
| `bun run package:linux` | Build the unpacked Linux x64 host. |
| `bun run package:linux:arm64` | Build the unpacked Linux arm64 host. |
| `bun run verify:package:linux` | Verify an existing Linux package. |
| `bun run dist:linux` | Build the Linux x64 AppImage used by the container recipe. |
| `bun run dist:linux:arm64` | Build the Linux arm64 AppImage. |

Build and package commands are not routine checks. Run only focused checks locally, one at a
time. The historical `desktop` check names also cover code that the Linux host needs.
Git commits do not run repository hooks. Dependency installation does not install hooks;
run the required checks explicitly.
See [check design notes](docs/development-checks.md).

## Repository structure

- `apps/auth-api`: Web client, account API and current Cloudflare adapters.
- `remote/api`: Signal and event relays; `remote/compose.yaml` also runs TURN.
- `src/backend`: providers, agents, SQLite, queues, routines and workflows.
- `src/main`: Electron host services, IPC, operating-system adapters and lifecycle.
- `src/preload`: validated renderer bridge.
- `src/renderer`: shared application composition, Web client and host renderer pages.
- `packages`: shared UI, contracts, translations, logging and client code.
- `docker`: Linux host image and Compose configuration.

See the [workspace map](docs/architecture/structure.md#workspace-map).

## Security

Preserve the Electron sandbox, context isolation, navigation rules and IPC sender checks.
An agent can run commands and change files with its granted permissions. Use separate,
restricted credentials for inspection, code changes and production deployment.

Database migrations and released Team API adapters remain intact. Mobile protocol handlers
remain available for released clients, although this checkout no longer builds a mobile app.
See [security](SECURITY.md) and [contribution rules](CONTRIBUTING.md#security-sensitive-changes).

## Privacy

Local storage does not keep a model request inside the private network. Prompts, selected code,
logs and tool results can be sent to an external AI provider. Review [PRIVACY.md](PRIVACY.md)
before connecting production systems.

## License

The license remains [PolyForm Noncommercial 1.0.0](LICENSE). The license names the contact for
commercial use.
