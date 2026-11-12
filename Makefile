.PHONY: help install build test test-unit test-int test-web e2e lint run update serve status clean migrate migrate-status create-admin init db

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
	@echo "make db           - set the DB connection (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME) and save it to .env"
	@echo "make create-admin   - create admin user (reads ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_NAME from env)"
	@echo "make init           - first-run bootstrap (reads ADMIN_EMAIL/ADMIN_PASSWORD/ADMIN_NAME/ADMIN_SEED from env)"
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
db:
	@if [ -z "$$DB_HOST" ] || [ -z "$$DB_USER" ] || [ -z "$$DB_NAME" ]; then \
		echo "set DB_HOST, DB_USER and DB_NAME (and DB_PASSWORD) in your environment"; \
		exit 1; \
	fi
	node dist/cli.js db --host "$$DB_HOST" --port "$${DB_PORT:-3306}" --user "$$DB_USER" --name "$$DB_NAME" --save
create-admin:
	@if [ -z "$$ADMIN_EMAIL" ] || [ -z "$$ADMIN_PASSWORD" ]; then \
		echo "set ADMIN_EMAIL and ADMIN_PASSWORD in your environment"; \
		exit 1; \
	fi
	node dist/cli.js create-admin --email "$$ADMIN_EMAIL" --password "$$ADMIN_PASSWORD" --name "$${ADMIN_NAME:-Admin}"
init:
	@if [ -z "$$ADMIN_EMAIL" ] || [ -z "$$ADMIN_PASSWORD" ]; then \
		echo "set ADMIN_EMAIL and ADMIN_PASSWORD in your environment"; \
		exit 1; \
	fi
	@if [ "$$ADMIN_SEED" = "true" ]; then \
		node dist/cli.js init --email "$$ADMIN_EMAIL" --password "$$ADMIN_PASSWORD" --name "$${ADMIN_NAME:-Admin}" --seed; \
	else \
		node dist/cli.js init --email "$$ADMIN_EMAIL" --password "$$ADMIN_PASSWORD" --name "$${ADMIN_NAME:-Admin}"; \
	fi
clean:; rm -rf dist coverage data
