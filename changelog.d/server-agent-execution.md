### Added

- Added explicit Node Agent execution through a configured OpenCode 2 runtime. The local Web
  workspace can create Agents, send tasks, show results and stop turns. Messages, workspaces and
  thread identities remain available after restart, with the existing durable send deduplication.
- Added authenticated live-update notices and isolated OpenCode service shutdown. Browser tools,
  scheduled/channel work and interactive question forms remain disabled in this execution mode.
