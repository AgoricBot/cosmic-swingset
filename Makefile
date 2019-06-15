REPOSITORY = agoric/cosmic-swingset
TAG := $(shell sed -ne 's/.*"version": "\(.*\)".*/\1/p' package.json)

include Makefile.ledger
all: build install

docker-install:
	install -m 755 ./ag-chain-cosmos ./ag-cosmos-helper ./ag-setup-cosmos /usr/local/bin/

docker-build: docker-build-base docker-build-setup

docker-build-setup:
	docker build -t $(REPOSITORY)-setup:latest ./setup

docker-build-base:
	docker build -t $(REPOSITORY):latest .

docker-push: docker-push-base docker-push-setup

docker-push-setup:
	docker tag $(REPOSITORY)-setup:latest $(REPOSITORY)-setup:$(TAG)
	docker push $(REPOSITORY)-setup:latest
	docker push $(REPOSITORY)-setup:$(TAG)

docker-push-base:
	docker tag $(REPOSITORY):latest $(REPOSITORY):$(TAG)
	docker push $(REPOSITORY):latest
	docker push $(REPOSITORY):$(TAG)

compile-go: go.sum
	GO111MODULE=on go build -v -buildmode=c-shared -o lib/libagcosmosdaemon.so lib/agcosmosdaemon.go
	-install_name_tool -id `pwd`/lib/libagcosmosdaemon.so lib/libagcosmosdaemon.so

build: compile-go compile-node

compile-node:
	test ! -d node_modules/bindings || npm run build

install: go.sum
	# Not needed, because we librarify ./cmd/ag-chain-cosmos as ./lib/libagcosmosdaemon.so
	#GO111MODULE=on go install -tags "$(build_tags)" ./cmd/ag-chain-cosmos
	GO111MODULE=on go install -v -tags "$(build_tags)" ./cmd/ag-cosmos-helper

go.sum: go.mod
	@echo "--> Ensure dependencies have not been modified"
	GO111MODULE=on go mod verify

start-ag-solo:
	-rm -r t1
	bin/ag-solo init t1
	cd t1 && ../bin/ag-solo start

show-local-gci:
	@./calc-gci.js ~/.ag-cosmos-chain/config/genesis.json

set-local-gci-ingress:
	cd t1 && ../bin/ag-solo set-gci-ingress `../calc-gci.js ~/.ag-chain-cosmos/config/genesis.json` `../calc-rpcport.js ~/.ag-chain-cosmos/config/config.toml`

start-ag-solo-connected-to-local:
	-rm -r t1
	bin/ag-solo init t1
	$(MAKE) set-local-gci-ingress
	cd t1 && ../bin/ag-solo start

install-pserver:
	python3 -mvenv ve3
	ve3/bin/pip install -U setuptools wheel
	ve3/bin/pip install --editable ./provisioning-server

run-pserver:
	ve3/bin/ag-pserver --listen tcp:8001 --controller tcp:localhost:8002

install-setup-client:
	python3 -mvenv ve3-client
	ve3-client/bin/pip install -U setuptools wheel
	ve3-client/bin/pip install --editable ./ag-setup-solo
run-setup-client:
	ve3-client/bin/ag-setup-solo

AGC = /home/warner/bindmounts/trees/cosmic-swingset/lib/ag-chain-cosmos
warner-setup:
	rm -rf node_modules package-lock.json
	npm install
	-rm -r ~/.ag-chain-cosmos
	$(AGC) init --chain-id=agoric
	rm -rf t1
	bin/ag-solo init t1
	$(AGC) add-genesis-account `cat t1/ag-cosmos-helper-address` 1000agtoken
	$(MAKE) set-local-gci-ingress
	@echo "export const soloKey = '`cat t1/ag-cosmos-helper-address`';" >demo1/solo-key.js
	@echo "agc start"
	@echo "(cd t1 && ../bin/ag-solo start)"
