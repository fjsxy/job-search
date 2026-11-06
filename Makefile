NODE ?= node
NPM ?= npm

.PHONY: start test

node_modules/.package-lock.json: package-lock.json
	$(NPM) ci

start: node_modules/.package-lock.json
	$(NODE) src/main.mjs

test: node_modules/.package-lock.json
	$(NODE) --test
