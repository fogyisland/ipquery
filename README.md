# IPQuery

IP geolocation aggregator over **MaxMind GeoLite2**, **ip2region**, and **DB-IP**. Code under MIT; data files downloaded at runtime and **never redistributed** by this repository.

See [`docs/superpowers/specs/`](docs/superpowers/specs/) for design and [`docs/superpowers/plans/`](docs/superpowers/plans/) for the implementation plan.

## Quick start

```bash
# 1. Get a free MaxMind license key
#    https://www.maxmind.com/en/geolite2/signup
# 2. Configure
cp .env.example .env
# Edit .env, set MAXMIND_LICENSE_KEY

# 3. Run
make docker-up           # mysql + app
# OR
make install build run    # local node + uses local MySQL
```

The first run downloads data sources and populates the database (~10 min). Subsequent runs take the daily cron.

## Endpoints

- `GET /lookup?ip=8.8.8.8` — geolocation lookup
- `GET /healthz` — liveness probe
- `GET /stats` — last ETL run summary

## Data sources & licenses

| Source | License | Notes |
|---|---|---|
| [MaxMind GeoLite2](https://www.maxmind.com/en/geolite2) | GeoLite2 EULA (free, no redistribution) | User registers and sets `MAXMIND_LICENSE_KEY`. |
| [ip2region](https://github.com/lionsoul2014/ip2region) | Apache-2.0 | Attribution preserved in NOTICE. |
| [DB-IP](https://db-ip.com/db/download/ip-to-city) | CC-BY 4.0 | Attribution required in derivative UI. |

This repository contains **no data files**. You are responsible for downloading and complying with each source's license.

## Architecture

ETL pipeline → MySQL → Fastify. See [`docs/superpowers/specs/2026-08-13-ip-aggregator-design.md`](docs/superpowers/specs/2026-08-13-ip-aggregator-design.md) for the full design.

## Development

```bash
make test-unit    # fast
make test-int     # requires docker compose up mysql
make lint
```

## Limitations

- MaxMind parser uses a sparse-probe MVP. Full tree-walking iterator is post-MVP work.
- ip2region parser reads the JSON-export form, not the binary .xdb. Future work.
- Single-process, single-host. No horizontal scaling.
- IPv6 support is functional but coverage is uneven across sources.

## License

MIT for code in this repository.
