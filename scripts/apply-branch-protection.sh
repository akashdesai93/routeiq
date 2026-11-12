#!/usr/bin/env bash
# Protects `main` on akashdesai93/routeiq and sets the merge settings that go with it.
# What it sets and why: docs/branch-protection.md (keep the two in step).
#
# Run it once, AFTER the pull request that adds .github/workflows/gate.yml is merged:
# the protection requires the status check `required`, which only gate.yml reports.
# It needs `gh` signed in as the repository owner. Running it again is harmless.
#
#   bash scripts/apply-branch-protection.sh
set -euo pipefail

REPO=akashdesai93/routeiq
BRANCH=main

# The gate must be on main already, or every pull request would wait for a check that never comes.
if ! gh api "repos/$REPO/contents/.github/workflows/gate.yml?ref=$BRANCH" --silent 2>/dev/null; then
  echo "gate.yml is not on $BRANCH yet. Merge its pull request first." >&2
  exit 1
fi

echo "Repository: squash merges only, auto-merge on, head branches deleted after a merge"
gh api -X PATCH "repos/$REPO" --silent \
  -F allow_squash_merge=true \
  -F allow_merge_commit=false \
  -F allow_rebase_merge=false \
  -F allow_auto_merge=true \
  -F delete_branch_on_merge=true

echo "Branch protection on $BRANCH"
# app_id 15368 is GitHub Actions: only a check reported by Actions counts as `required`.
gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --silent --input - <<'JSON'
{
  "required_status_checks": {
    "strict": false,
    "checks": [{ "context": "required", "app_id": 15368 }]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "required_approving_review_count": 0,
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false
  },
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true
}
JSON

echo "Now in force:"
gh api "repos/$REPO/branches/$BRANCH/protection" --jq '{
  required_checks: [.required_status_checks.checks[].context],
  strict: .required_status_checks.strict,
  approvals: .required_pull_request_reviews.required_approving_review_count,
  dismiss_stale_reviews: .required_pull_request_reviews.dismiss_stale_reviews,
  enforce_admins: .enforce_admins.enabled,
  linear_history: .required_linear_history.enabled,
  force_pushes: .allow_force_pushes.enabled,
  deletions: .allow_deletions.enabled,
  conversation_resolution: .required_conversation_resolution.enabled
}'
gh api "repos/$REPO" --jq '{allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge, delete_branch_on_merge}'
