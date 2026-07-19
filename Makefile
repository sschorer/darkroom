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

# Every cargo target below depends on this, not just the bundle: externalBin
# makes tauri-build fail at compile time when the sidecar is missing. Cheap to
# repeat — the script no-ops when the pinned version is already there.
.PHONY: sidecar
sidecar: ## Fetch the uv sidecar for this host and check it runs (idempotent; ADR-004)
	node scripts/fetch-uv.mjs --verify

# ---------------------------------------------------------------- run

# WEBKIT_DISABLE_DMABUF_RENDERER: WebKitGTK's dmabuf compositing path deadlocks
# the NVIDIA proprietary driver on teardown — the webview's GPU thread wedges in
# `exit_mmap` unmapping GPU memory, leaving an unkillable D-state task that no
# signal (not even SIGKILL) can clear. The process never reaps, it keeps the
# Wayland connection open so the compositor can't drop the now-frozen window, and
# only a reboot recovers the session. It's Linux-only (macOS/Windows use WKWebView
# / WebView2 and ignore this var) and dev-only (`tauri build` never opens a live
# webview), so it lives on `dev` alone. Disabling only the dmabuf *renderer* keeps
# the rest of GPU-accelerated rendering — a lighter hammer than
# WEBKIT_DISABLE_COMPOSITING_MODE, which turns compositing off wholesale.
.PHONY: dev
dev: sidecar ## Run the app (tauri dev — opens a window)
	WEBKIT_DISABLE_DMABUF_RENDERER=1 $(PNPM) tauri dev

.PHONY: web
web: ## Run only the frontend in a browser, no Rust build
	$(PNPM) dev

.PHONY: build
build: sidecar ## Build the release bundle
	$(PNPM) tauri build

.PHONY: build-web
build-web: ## Build only the frontend into dist/
	$(PNPM) build

.PHONY: smoke
smoke: sidecar ## Bundle smoke — must succeed unsigned, or forks can't build
	$(PNPM) tauri build --no-bundle

# ---------------------------------------------------------------- checks

.PHONY: check
check: lint fmt-check typecheck test rust-fmt rust-lint rust-test bindings-check ## Everything CI gates. Run before pushing.

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
rust-lint: sidecar ## cargo clippy, warnings are errors
	cd $(CARGO_DIR) && cargo clippy --all-targets -- -D warnings

.PHONY: rust-test
rust-test: sidecar ## cargo test
	cd $(CARGO_DIR) && cargo test --all-features

.PHONY: bindings
bindings: sidecar ## Regenerate the TS IPC types from Rust (ts-rs, ADR-018)
	cd $(CARGO_DIR) && cargo test --features ts export_bindings

.PHONY: bindings-check
bindings-check: bindings ## Fail if the generated TS types drifted from Rust (CI gate)
	git add --intent-to-add app/lib/generated
	git diff --exit-code -- app/lib/generated

# ---------------------------------------------------------------- clean

.PHONY: clean
clean: ## Remove build output and caches (keeps node_modules and cargo target)
	rm -rf dist coverage node_modules/.vite

.PHONY: clean-all
clean-all: clean ## Also remove node_modules, the cargo target dir, and the sidecar
	rm -rf node_modules $(CARGO_DIR)/target $(CARGO_DIR)/binaries
