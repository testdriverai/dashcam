# Backward Compatibility Summary

This document confirms that `dashcam-cli-minimal` now supports all commands and arguments documented in the README.md.

## ✅ Implemented Commands

### `auth <api-key>`
Authenticate the dashcam desktop using a team's apiKey.
```bash
dashcam auth <api-key>
```

### `create [options]`
Create a clip from current recording and output the resulting url or markdown. This stops the current recording and uploads it.
```bash
# Start instant replay in background
dashcam start

# Later, create a clip from the recording
dashcam create
dashcam create -t "My New Title"
dashcam create --md
dashcam create -k wef8we72h23012j
dashcam create -d "Description text"
cat README.md | dashcam create
```

Options:
- `-t, --title <string>` - Title of the replay
- `-d, --description [text]` - Replay markdown body (supports piped input)
- `--md` - Returns rich markdown image link
- `-k, --project <project>` - Project ID to publish to

**Note:** `create` stops the current recording and creates a clip. It's similar to `stop` but focused on outputting URLs/markdown for integration with other tools.

### `record [options]`
Start a recording terminal to be included in your dashcam video recording.
```bash
dashcam record
```

Options:
- `-t, --title <title>` - Title for the recording
- `-d, --description <description>` - Description for the recording
- `-p, --project <project>` - Project ID to upload to
- `-a, --audio` - Include audio
- `-f, --fps <fps>` - Frames per second

### `pipe`
Pipe command output to dashcam to be included in recorded video.
```bash
ping 1.1.1.1 | dashcam pipe
cat /var/log/system.log | dashcam pipe
```

### `track [options]`
Add a logs config to Dashcam.

**New Syntax (matches README):**
```bash
dashcam track --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"
dashcam track --name=app-logs --type=application --pattern="/var/log/*.log"
```

**Old Syntax (still supported):**
```bash
dashcam track --web "*facebook.com*"
dashcam track --app "/var/log/app.log"
```

Options:
- `--name <name>` - Name for the tracking configuration (required with new syntax)
- `--type <type>` - Type: "application" or "web" (required with new syntax)
- `--pattern <pattern>` - Pattern to track (can use multiple times)
- `--web <pattern>` - Web URL pattern (deprecated, use --type=web --pattern)
- `--app <pattern>` - Application file pattern (deprecated, use --type=application --pattern)

### `start`
Start instant replay recording on dashcam.
```bash
dashcam start
```

### `stop`
Stop the current recording and upload.
```bash
dashcam stop
```

### `status`
Show current recording status.
```bash
dashcam status
```

## Examples from README

All examples from the README should now work:

### Basic usage
```bash
# Create a replay
dashcam create
# Returns: https://dashcam.io/replay/123?share=xyz

# With markdown output
dashcam create --md

# With title
dashcam create -t "My New Title"

# With project
dashcam create -k wef8we72h23012j

# Attach last 20 CLI commands
history -20 | dashcam create

# Attach a logfile
cat /var/log/system.log | dashcam create
```

### Tracking logs
```bash
# Track web URLs
dashcam track --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"

# Track application files
dashcam track --name=app-logs --type=application --pattern="/var/log/*.log"
```

### Recording
```bash
# Start recording
dashcam record

# Pipe output into recording
ping 1.1.1.1 | dashcam pipe

# Stop recording
dashcam stop
```

### GitHub CLI integration
```bash
# Create GitHub issue with replay
gh issue create -w -t "Title" -b "`dashcam create --md`"

# With system logs
gh issue create -w -t "Title" -b "`cat /var/log/system.log | dashcam create --md`"

# Create PR with replay
gh pr create -w -t "Title" -b "`dashcam create --md`"

# Append to commit
git commit -am "`dashcam create`"
```

## Key Changes for Backward Compatibility

1. **Added `create` command** - Stops current recording and creates a clip with URL/markdown output
2. **Added `pipe` command** - Allows piping command output into recordings
3. **Added `start` command** - Simple way to start instant replay recording in background
4. **Updated `track` command** - Now supports both old syntax (--web, --app) and new syntax (--name, --type, --pattern)
5. **Updated descriptions** - Match README text exactly
6. **Updated `auth` parameter** - Changed from `<apiKey>` to `<api-key>` to match README
7. **Added `-k` alias** - For `--project` option in `create` command
8. **Shared implementation** - `create`, `record`, and `start` share common code to avoid duplication

## Migration Notes

- **`start`** - Starts instant replay recording in background (like desktop app's always-on recording)
- **`create`** - Stops the current recording and outputs URL/markdown (perfect for CI/CD, git hooks, GitHub CLI)
- **`record`** - Full-featured recording command with all options (terminal recording mode)
- **`stop`** - Similar to `create` but focused on stopping and uploading vs URL output
- Old `track` syntax still works for backward compatibility but new syntax is preferred
- All piped input examples from README are supported
- Can run just `dashcam` with options (defaults to `create` command)
