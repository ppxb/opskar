### Added

- Added a local Web console for password access, encrypted OpenAI-compatible Provider settings,
  and a connection test with cancellation. The console uses Node.js 24 and shared SolidJS controls.
- Reused the existing workspace frame, sidebar and message components to read real Agent records
  and conversation pages from the local Node database. Selection, history paging, refresh and
  sign-out are available. Agent execution remains a later step.
