### Added

- Added an independent Node server entry for storage bootstrap. It uses a dedicated data directory,
  reports database readiness on loopback, refuses a second process and existing desktop profiles,
  and closes storage on normal shutdown. Agents and the Web client are not connected yet.
