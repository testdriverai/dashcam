# Dashcam CLI - Log Tracking Guide

The Dashcam CLI can track both **file-based logs** (from CLI applications) and **web browser logs** (from browser extensions). This guide explains how to use the log tracking features.

## File Log Tracking (CLI Applications)

### Adding Log Files to Track

Track log files during recordings:

```bash
# Add a single log file
dashcam logs --add /var/log/myapp.log

# Add multiple log files
dashcam logs --add /tmp/debug.log
dashcam logs --add ~/.npm/_logs/npm.log
dashcam logs --add /var/log/nginx/access.log
```

### Removing Log Files

```bash
# Remove a log file from tracking
dashcam logs --remove /var/log/myapp.log
```

### Viewing Tracked Files

```bash
# List all currently tracked log files
dashcam logs --list

# Show detailed tracking status
dashcam logs --status
```

## Web Browser Log Tracking

### Setting Up Web App Tracking

Web log tracking requires configuring patterns for URLs you want to monitor:

```bash
# Create a config file for web apps (web-logs.json)
cat > web-logs.json << 'EOF'
[
  {
    "id": "my-web-app",
    "type": "web",
    "name": "My Web Application",
    "enabled": true,
    "patterns": [
      "*localhost:3000*",
      "*myapp.com*",
      "*staging.myapp.com*"
    ]
  },
  {
    "id": "github",
    "type": "web", 
    "name": "GitHub",
    "enabled": true,
    "patterns": [
      "*github.com*"
    ]
  }
]
EOF
```

### Updating Web Log Configuration

```javascript
// In your Node.js script or through the API
import { logsTrackerManager } from './lib/logs/index.js';

const webConfig = [
  {
    id: 'my-app',
    type: 'web',
    name: 'My Application',
    enabled: true,
    patterns: ['*localhost:3000*', '*myapp.com*']
  }
];

logsTrackerManager.updateLogsConfig(webConfig);
```

## Recording with Log Tracking

### Start a Recording with Logs

```bash
# Start recording (logs are automatically included if configured)
dashcam record --duration 30

# The recording will include:
# - All tracked log files (--add files above)
# - Web browser events (if browser extension is installed)
```

### Browser Extension Setup

1. **Install the Dashcam browser extension** (Chrome/Firefox)
2. **The CLI automatically starts a WebSocket server** on ports: 10368, 16240, 21855, 24301, or 25928
3. **Extension connects automatically** when CLI is running
4. **Web events are captured** based on your URL patterns

## Log Event Types

### File Logs
- **Line events**: Each new line written to tracked files
- **Timestamps**: Precise timing for synchronization with video
- **Error detection**: Automatic highlighting of error lines

### Web Logs  
- **Console logs**: `console.log()`, `console.error()`, etc.
- **Network requests**: HTTP requests and responses
- **Navigation events**: Page loads and URL changes
- **Tab management**: Tab switches and window focus

## Example Workflow

```bash
# 1. Add log files to track
dashcam logs --add /var/log/myapp.log
dashcam logs --add /tmp/debug.log

# 2. Check status
dashcam logs --status
# Output:
# Log tracking status:
#   Active recording instances: 0
#   Configured CLI log files: 2
#   Total recent events: 15
#   File tracker details:
#     /var/log/myapp.log: 8 events (last minute)
#     /tmp/debug.log: 7 events (last minute)

# 3. Start recording
dashcam record --duration 60

# 4. During recording:
# - CLI monitors all tracked log files in real-time
# - Browser extension sends web events via WebSocket
# - All events are timestamped and synchronized

# 5. After recording:
# - Logs are automatically trimmed to match video duration
# - Events are saved in JSONL format alongside video
# - Logs can be replayed in sync with video
```

## Advanced Configuration

### Custom WebSocket Port

```javascript
// If you need to use specific ports
import { server } from './lib/websocket/server.js';
await server.start(); // Uses predefined port list
```

### Pattern Matching for Web Apps

Patterns support wildcards:
- `*example.com*` - Matches any URL containing "example.com"
- `*localhost:3000*` - Matches local development server
- `*github.com/myuser/*` - Matches specific GitHub paths

### Log File Requirements

- **Files must exist** before adding to tracking
- **Files must be readable** by the CLI process  
- **Real-time writes** are monitored (uses `tail` library)
- **Log rotation** is automatically handled

## Troubleshooting

### Common Issues

1. **"Log file does not exist"**
   ```bash
   # Ensure file exists first
   touch /var/log/myapp.log
   dashcam logs --add /var/log/myapp.log
   ```

2. **"WebSocket connection failed"** 
   - Check that browser extension is installed
   - Verify no firewall blocking local ports
   - Ensure CLI is running when opening browser

3. **"No events captured"**
   ```bash
   # Check if files are being written to
   tail -f /var/log/myapp.log
   
   # Verify tracking status
   dashcam logs --status
   ```

### Getting Help

```bash
# Show all log tracking options
dashcam logs --help

# Show general CLI help
dashcam --help
```

## Integration with Recordings

When you create a recording, all configured logs are:

1. **Automatically included** in the recording
2. **Synchronized** with video timestamps  
3. **Trimmed** to match video start/end times
4. **Saved** in JSON Lines format for replay
5. **Uploaded** along with video files

The result is a complete recording with both visual and log context, making debugging and analysis much more effective.
