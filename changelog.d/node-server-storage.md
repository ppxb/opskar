### Added

- Initialize agent and mailbox storage in the independent Node host, using one database and
  workspace paths inside its dedicated data directory. Keep pending requests stored without
  starting providers or queue execution.
