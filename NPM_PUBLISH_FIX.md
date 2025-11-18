# NPM Publish & Version Sync Issues

## Problem

The npm publish workflow was failing with:
```
npm error 404 'dashcam@1.0.1-beta.17' is not in this registry.
```

## Root Cause

**Version drift** between local git tags, package.json, and npm registry:

- **NPM registry**: `1.0.1-beta.13` (latest successfully published)
- **Local package.json**: `1.0.1-beta.16` (from failed publish attempts)
- **Git tags**: Only up to `v1.0.1-beta.9`

This happened because the workflow:
1. Bumped version in package.json
2. Created git tag
3. Tried to publish
4. **Publish failed** (possibly due to test failures or video encoding issues)
5. Git changes were not reverted, leaving version incremented

## Fixes Applied

### 1. Updated Publish Workflow

**Before**: Version bump → Push → Publish (wrong order!)

**After**: 
1. Sync with npm registry version
2. Bump version
3. **Publish first** ✅
4. Push only if publish succeeded ✅

```yaml
- name: Bump version
  run: |
    # Get current version from npm
    CURRENT_NPM_VERSION=$(npm view dashcam dist-tags.beta)
    
    # Sync before bumping
    npm version $CURRENT_NPM_VERSION --no-git-tag-version --allow-same-version
    
    # Bump to next
    npm version prerelease --preid=beta

- name: Publish to npm
  run: npm publish --access public --tag beta

- name: Push changes  # Only runs if publish succeeded
  run: git push --follow-tags
```

### 2. Created Version Sync Script

`scripts/sync-version.sh` - Helps detect and fix version drift:

```bash
./scripts/sync-version.sh
```

This will:
- Compare local version with npm registry
- Offer to sync package.json
- Show unpublished git tags that need cleanup

### 3. Synced package.json

Reset from `1.0.1-beta.16` → `1.0.1-beta.13` (current npm version)

## Video Issue Connection

The failed publishes were likely caused by **test failures due to the video encoding bugs** we fixed:

- Frame rate conflicts
- Buffer size issues
- Frame dropping
- Incomplete container metadata

All of these are now fixed in the recorder.js, so future CI runs should succeed.

## Next Steps

1. ✅ Package.json is synced
2. ✅ Workflow is fixed
3. ⚠️  Need to clean up unpublished git tags manually (optional):

```bash
# List tags
git tag | grep beta

# Delete local tags for unpublished versions (14-16)
git tag -d v1.0.1-beta.14 v1.0.1-beta.15 v1.0.1-beta.16

# If they exist on remote, delete them
git push origin :refs/tags/v1.0.1-beta.14
git push origin :refs/tags/v1.0.1-beta.15
git push origin :refs/tags/v1.0.1-beta.16
```

4. Push the fixes to trigger a new publish
5. Next version will be `1.0.1-beta.14` ✅
