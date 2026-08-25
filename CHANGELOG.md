# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-08-19

### Added

- **Core API**: `GET /lookup`, `GET /lookup/:ip`, `GET /stats`, `GET /healthz`
- **Data sources**: MaxMind GeoLite2 (City + ASN), ip2region (free), DB-IP (city)
- **ETL pipeline**: scheduled daily refresh with progress tracking and admin trigger
- **User auth**: email + password, verification, password reset, sessions in MySQL
- **API Keys**: per-user tokens with rate-limit uplift; revocable
- **Admin console**: users, ETL runs, API keys, query log, audit log, query stats, settings
- **Web console**: dashboard, history, keys, profile (i18n: zh-CN, en-US)
- **CSRF, rate limits, session lockouts**: see README "CSRF, sessions, rate limits"

### Notes

- This is the first tagged release. Pre-commit history is not backfilled.
- Data files are not bundled; the user must register a MaxMind license key.

[0.1.0]: https://example.com/ipquery/releases/tag/v0.1.0
