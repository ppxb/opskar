### Added

- Added encrypted provider credential storage to the independent Node host, using a private key
  file supplied by the operator. Missing or incorrect keys and modified ciphertext stop startup
  without replacing saved credentials. Status output contains no secret values.
