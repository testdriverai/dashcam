# Release Workflow

## How It Works

### Pull Requests
- When you create a PR, the build workflow runs automatically
- Binaries are built for all platforms but **NOT released**
- Artifacts are uploaded to the PR for testing

### Pushes to Main
- When code is pushed to `main`, the release workflow automatically:
  1. **Bumps the version** (creates a git tag)
  2. **Builds binaries** for all platforms
  3. **Creates a GitHub release** with all binaries attached

## Version Bumping

The version is automatically bumped based on your commit messages:

### Default: Patch Version (1.0.0 → 1.0.1)
```bash
git commit -m "fix: bug fix"
git commit -m "docs: update documentation"
```

### Minor Version (1.0.0 → 1.1.0)
Include `#minor` or `#feature` in your commit message:
```bash
git commit -m "feat: add new feature #minor"
git commit -m "new feature #feature"
```

### Major Version (1.0.0 → 2.0.0)
Include `#major` in your commit message:
```bash
git commit -m "breaking: major API change #major"
git commit -m "refactor: complete rewrite #major"
```

### Skip Release
Include `#none` or `[skip ci]` to skip the release:
```bash
git commit -m "chore: update README #none"
git commit -m "docs: typo fix [skip ci]"
```

## Manual Release

You can trigger a release manually from the GitHub Actions tab:
1. Go to Actions → Release workflow
2. Click "Run workflow"
3. Select the branch and run

## Supported Platforms

Each release includes binaries for:
- **macOS**: x64 (Intel) and ARM64 (Apple Silicon)
- **Linux**: x64 and ARM64
- **Windows**: x64 and ARM64
