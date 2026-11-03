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

## Commands

| Command | Use |
| --- | --- |
| `bun run dev` | Start the existing host development stack. |
| `bun run dev:api` | Start the account application and Web entry. |
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
