# IPQuery

IP geolocation aggregator. See `docs/superpowers/specs/` for design and `docs/superpowers/plans/` for the implementation plan.

## Quick start

```bash
docker compose up -d mysql
cp .env.example .env
# Edit .env to set MAXMIND_LICENSE_KEY
npm install
npm run build
node dist/cli.js update
node dist/cli.js serve
```