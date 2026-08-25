# Contributing

Thanks for your interest in improving IPQuery. This project is MIT-licensed
and accepts patches from the community.

## Ground Rules

- Be respectful. We follow the Contributor Covenant.
- Small, focused pull requests are easier to review than large ones.
- Match the existing code style. The repo runs `tsc --noEmit` as the lint
  command; please keep it green.
- New behavior ships with tests. We use `vitest`; unit tests live next to
  `src/`, integration tests under `test/`.

## Development Setup

```bash
make install        # npm install
make build          # tsc + copy schema
make migrate        # apply DB schema
make test-unit      # fast, no DB
make test-int       # requires a running MySQL
make test-web       # web-only unit + integration
make e2e            # end-to-end
```

MySQL is required for integration and e2e tests. Bring up a local MySQL
however you prefer — `make docker-up` uses `docker compose` if you have
it installed, or point `DB_*` env vars at any existing MySQL instance.

## Pull Request Process

1. Open a PR against `main`. Include a one-line summary and a short "why".
2. Reference any issue this PR closes.
3. Ensure CI is green: `npx tsc --noEmit && npm test`.
4. Be patient with review. We may ask for a rename, a test, or a small
   refactor. Reviews are conversations, not gatekeeping.

## Commit Messages

We follow a lightweight conventional-commit style:

```
feat(scope): short summary
fix(scope): short summary
docs(scope): short summary
refactor(scope): short summary
test(scope): short summary
```

The scope is the area of the codebase (e.g. `etl`, `admin`, `lookup`,
`web`). Body explains the why, not the what.

## Reporting Bugs

Open an issue and include:

- What you did, what you expected, what happened.
- The commit hash or release tag.
- Output of `node dist/cli.js --version` and `node --version`.
- A minimal reproducer if possible.

For security issues, see `SECURITY.md` — do not open a public issue.

## License

By submitting a patch, you agree to license your contribution under the
MIT License (see `LICENSE`). The project does not currently require a
CLA; if a CLA is added in the future, existing contributions will be
grandfathered under their original MIT terms.
