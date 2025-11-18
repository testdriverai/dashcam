#!/bin/bash

# Sync local version with npm registry
# This fixes version drift when publishes fail

echo "🔍 Checking version sync..."

# Get current version in package.json
LOCAL_VERSION=$(node -p "require('./package.json').version")
echo "📦 Local version: $LOCAL_VERSION"

# Get current beta version from npm
NPM_BETA_VERSION=$(npm view dashcam dist-tags.beta 2>/dev/null)
if [ -z "$NPM_BETA_VERSION" ]; then
  echo "⚠️  No beta tag found on npm, checking latest version..."
  NPM_BETA_VERSION=$(npm view dashcam versions --json | jq -r '.[] | select(contains("beta"))' | tail -1)
fi
echo "📡 NPM beta version: $NPM_BETA_VERSION"

# Get all local git tags
echo ""
echo "🏷️  Local git tags:"
git tag | grep beta | tail -5

echo ""
echo "📡 NPM published versions:"
npm view dashcam versions --json | jq -r '.[] | select(contains("beta"))' | tail -5

echo ""
if [ "$LOCAL_VERSION" != "$NPM_BETA_VERSION" ]; then
  echo "⚠️  Version mismatch detected!"
  echo "   Local:  $LOCAL_VERSION"
  echo "   NPM:    $NPM_BETA_VERSION"
  echo ""
  read -p "Do you want to sync package.json to $NPM_BETA_VERSION? (y/n) " -n 1 -r
  echo
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    npm version $NPM_BETA_VERSION --no-git-tag-version --allow-same-version
    echo "✅ Synced package.json to $NPM_BETA_VERSION"
    echo ""
    echo "⚠️  Note: You may have unpublished git tags. To clean them up:"
    echo "   git tag | grep beta | tail -10  # Review tags"
    echo "   git tag -d v1.0.1-beta.XX       # Delete unpublished tags"
    echo "   git push origin :refs/tags/v1.0.1-beta.XX  # Delete remote tags"
  fi
else
  echo "✅ Versions are in sync!"
fi
