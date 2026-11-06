NODE ?= node
NPM ?= npm

.PHONY: start login test

node_modules/.package-lock.json: package-lock.json
	$(NPM) ci

start: node_modules/.package-lock.json
	$(NODE) src/main.mjs

login:
	$(NODE) src/login.mjs

test: node_modules/.package-lock.json
	$(NODE) --test
