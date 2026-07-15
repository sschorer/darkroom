#!/usr/bin/env bash
# Creates the Darkroom repo on GitHub and configures it.
#
# Prereqs:  gh auth login   (needs `repo` and `admin:repo_hook` scopes)
# Usage:    ./bootstrap-repo.sh <your-github-handle> [repo-name]
#
# Run this from INSIDE the unpacked darkroom-scaffold directory.

set -euo pipefail

HANDLE="${1:?usage: ./bootstrap-repo.sh <github-handle> [repo-name]}"
REPO="${2:-darkroom}"
SLUG="$HANDLE/$REPO"

command -v gh >/dev/null || { echo "gh CLI not found: https://cli.github.com"; exit 1; }
gh auth status >/dev/null || { echo "run: gh auth login"; exit 1; }
[[ -f ARCHITECTURE.md ]] || { echo "run this from inside the scaffold directory"; exit 1; }

echo "==> Creating $SLUG"
gh repo create "$SLUG" \
  --public \
  --license gpl-3.0 \
  --description "Generate images and video with AI models running entirely on your own GPU."

echo "==> Adding your handle to the trust list"
# You're a collaborator so vouch trusts you automatically, but seeding the
# maintainer section makes the file self-documenting for the first contributor.
sed -i.bak "s|^# --- Maintainers ---$|# --- Maintainers ---\ngithub:$HANDLE|" .github/VOUCHED.td
rm -f .github/VOUCHED.td.bak

echo "==> First commit"
git init -q -b main
git add -A
git commit -q -m "chore: scaffold project documentation and CI

Architecture (arc42), contribution guidelines, vouch-based trust,
CodeRabbit config, conventional commit enforcement, and the registry
schema with its validation suite.

See docs/BACKLOG.md for the sequenced plan."
git remote add origin "https://github.com/$SLUG.git" 2>/dev/null || true
git push -qu origin main

echo "==> Merge settings"
# The squash title becomes the commit message on main — which is the entire
# reason pr-title.yml can enforce Conventional Commits (ADR-011). If this
# isn't PR_TITLE, the linted title gets discarded and the check is theatre.
gh repo edit "$SLUG" \
  --enable-squash-merge \
  --squash-merge-commit-title PR_TITLE \
  --squash-merge-commit-message PR_BODY \
  --enable-merge-commit=false \
  --enable-rebase-merge=false \
  --enable-discussions \
  --delete-branch-on-merge

echo "==> Branch protection on main"
# Fails silently on a free plan for private repos; public repos are fine.
gh api -X PUT "repos/$SLUG/branches/main/protection" \
  --input - <<'JSON' >/dev/null 2>&1 || echo "    (skipped — needs a public repo or a paid plan)"
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["Registry validation", "Conventional Commit format"]
  },
  "enforce_admins": false,
  "required_pull_request_reviews": null,
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false
}
JSON

echo "==> Labels, milestones and the M0/M1 backlog"
(cd . && ./scripts/seed-issues.sh)

cat <<EOF

Done: https://github.com/$SLUG

Four things I can't do from a script:

  1. Install the CodeRabbit GitHub App
     https://github.com/apps/coderabbitai  → grant it $REPO

  2. Generate the updater signing key (needed at M3, not now)
     pnpm tauri signer generate -w ~/.tauri/darkroom.key
     Back the private key up OFFLINE. Losing it means no user can ever
     update again; leaking it means anyone can push them a payload.
     Then: gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/darkroom.key
           gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD

  3. Decide macOS notarization (RISK-2). \$99/yr or ship unsigned with
     xattr instructions. Decide before M3 — it changes updater behaviour.

  4. Write SECURITY.md. CONTRIBUTING already links to it. That's issue #44.

Next: issue #1. Then #2, #3, and go straight at #4 — it's the bet.
EOF
