NODE ?= node

.PHONY: start test

start:
	$(NODE) src/main.mjs

test:
	$(NODE) --test
