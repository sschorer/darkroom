# Darkroom — every task you can run in this repo.
#
# `make` on its own lists the targets. The commands themselves live here and
# nowhere else: CLAUDE.md and CONTRIBUTING.md point at this file rather than
# repeating the flags, because three copies of `cargo clippy -- -D warnings`
# drift and the CI one is the only copy that's true.
#
# The frontend runs from the repo root; anything cargo touches runs in native/
# (ADR-012).

PNPM  := pnpm
CARGO_DIR := native

.DEFAULT_GOAL := help

# ---------------------------------------------------------------- meta

.PHONY: help
help: ## List targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'
	@echo ""
	@echo "  First time on a fresh machine: make doctor"

.PHONY: doctor
doctor: ## Check the toolchain is present and say what's missing
	@echo "node    : $$(node --version 2>/dev/null || echo 'MISSING')"
	@echo "pnpm    : $$($(PNPM) --version 2>/dev/null || echo 'MISSING — corepack enable pnpm')"
	@echo "cargo   : $$(cargo --version 2>/dev/null || echo 'MISSING — rustup default stable')"
	@echo "webkit  : $$(pkg-config --modversion webkit2gtk-4.1 2>/dev/null || echo 'MISSING — see below (TC-3)')"
	@echo ""
	@echo "Linux (Arch/CachyOS) system deps:"
	@echo "  sudo pacman -S --needed base-devel webkit2gtk-4.1 rustup librsvg \\"
	@echo "    patchelf openssl file curl wget libayatana-appindicator"
	@echo "  rustup default stable"
	@echo ""
	@echo "Debian/Ubuntu: see CONTRIBUTING.md"

# ---------------------------------------------------------------- setup

.PHONY: install
install: ## Install JS dependencies
	$(PNPM) install

.PHONY: icon
icon: ## Regenerate app icons from a 1024x1024 source PNG (make icon SRC=path.png)
	$(PNPM) tauri icon $(SRC)

# ---------------------------------------------------------------- run

.PHONY: dev
dev: ## Run the app (tauri dev — opens a window)
	$(PNPM) tauri dev

.PHONY: web
web: ## Run only the frontend in a browser, no Rust build
	$(PNPM) dev

.PHONY: build
build: ## Build the release bundle
	$(PNPM) tauri build

.PHONY: build-web
build-web: ## Build only the frontend into dist/
	$(PNPM) build

# ---------------------------------------------------------------- checks

.PHONY: check
check: lint typecheck test rust-fmt rust-lint rust-test ## Everything CI gates. Run before pushing.

.PHONY: lint
lint: ## eslint
	$(PNPM) lint

.PHONY: fmt
fmt: ## Format with prettier (writes)
	$(PNPM) format

.PHONY: fmt-check
fmt-check: ## Check formatting without writing
	$(PNPM) format:check

.PHONY: typecheck
typecheck: ## tsc --noEmit
	$(PNPM) typecheck

.PHONY: test
test: ## All vitest projects
	$(PNPM) test

.PHONY: test-registry
test-registry: ## Validate every manifest against the schema — fastest real signal
	$(PNPM) test:registry

.PHONY: test-unit
test-unit: ## Unit tests with coverage
	$(PNPM) test:unit --coverage

# ---------------------------------------------------------------- rust

.PHONY: rust-fmt
rust-fmt: ## cargo fmt --check
	cd $(CARGO_DIR) && cargo fmt --all --check

.PHONY: rust-fmt-fix
rust-fmt-fix: ## cargo fmt (writes)
	cd $(CARGO_DIR) && cargo fmt --all

.PHONY: rust-lint
rust-lint: ## cargo clippy, warnings are errors
	cd $(CARGO_DIR) && cargo clippy --all-targets -- -D warnings

.PHONY: rust-test
rust-test: ## cargo test
	cd $(CARGO_DIR) && cargo test --all-features

# ---------------------------------------------------------------- clean

.PHONY: clean
clean: ## Remove build output and caches (keeps node_modules and cargo target)
	rm -rf dist coverage node_modules/.vite

.PHONY: clean-all
clean-all: clean ## Also remove node_modules and the cargo target dir
	rm -rf node_modules $(CARGO_DIR)/target
