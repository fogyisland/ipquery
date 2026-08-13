.PHONY: help install build test test-unit test-int lint run update serve status clean docker-up docker-down

help:
	@echo "make install    - npm install"
	@echo "make build      - tsc + copy schema"
	@echo "make test       - all tests"
	@echo "make test-unit  - unit tests only"
	@echo "make test-int   - integration tests (requires MySQL)"
	@echo "make lint       - tsc --noEmit"
	@echo "make run        - serve with --once"
	@echo "make update     - one ETL pass"
	@echo "make status     - show last ETL run"
	@echo "make docker-up  - bring up MySQL + app"
	@echo "make docker-down"
	@echo "make clean      - dist + coverage + data"

install:; npm install
build:;  npm run build
test:;   npm test
test-unit:; npm test -- test/unit
test-int:; npm test -- test/integration
lint:;   npm run lint
run:;    node dist/cli.js serve --once
update:; node dist/cli.js update
status:; node dist/cli.js status
docker-up:; docker compose up -d
docker-down:; docker compose down -v
clean:; rm -rf dist coverage data