.PHONY: help install build test test-unit test-int test-web e2e lint run update serve status clean docker-up docker-down migrate migrate-status create-admin

help:
	@echo "make install        - npm install"
	@echo "make build          - tsc + copy schema"
	@echo "make test           - all tests"
	@echo "make test-unit      - unit tests only"
	@echo "make test-int       - integration tests (requires MySQL)"
	@echo "make test-web       - integration + unit tests"
	@echo "make e2e            - end-to-end tests"
	@echo "make lint           - tsc --noEmit"
	@echo "make run            - serve with --once"
	@echo "make update         - one ETL pass"
	@echo "make status         - show last ETL run"
	@echo "make migrate        - run pending DB migrations"
	@echo "make migrate-status - show applied/pending migrations"
	@echo "make create-admin   - create admin user (reads ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_NAME from env)"
	@echo "make docker-up      - bring up MySQL + app"
	@echo "make docker-down"
	@echo "make clean          - dist + coverage + data"

install:; npm install
build:;  npm run build
test:;   npm test
test-unit:; npm test -- test/unit
test-int:; npm test -- test/integration
test-web:; npm test -- test/integration test/unit
e2e:; npm test -- test/e2e
lint:;   npm run lint
run:;    node dist/cli.js serve --once
update:; node dist/cli.js update
status:; node dist/cli.js status
migrate:; node dist/cli.js migrate
migrate-status:; node dist/cli.js migrate:status
create-admin:
	@if [ -z "$$ADMIN_EMAIL" ] || [ -z "$$ADMIN_PASSWORD" ]; then \
		echo "set ADMIN_EMAIL and ADMIN_PASSWORD in your environment"; \
		exit 1; \
	fi
	node dist/cli.js create-admin --email "$$ADMIN_EMAIL" --password "$$ADMIN_PASSWORD" --name "$${ADMIN_NAME:-Admin}"
docker-up:; docker compose up -d
docker-down:; docker compose down -v
clean:; rm -rf dist coverage data
