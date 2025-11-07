<div align="center">

# 🎬 Dashcam CLI

### Screen Recording for Automated Tests, CI/CD, and AI Agents

Capture video recordings of automated test runs with synchronized browser logs, application events, and file changes. Built for CI pipelines, custom VMs, and computer-use agents.

[![npm version](https://img.shields.io/npm/v/dashcam.svg)](https://www.npmjs.com/package/dashcam)
[![Node.js](https://img.shields.io/badge/node-%3E%3D14.0.0-brightgreen.svg)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

[Quick Start](#-quick-start) • [CI/CD](#-cicd-integration) • [Examples](#-examples) • [API](#-commands)

</div>

---

## 🚀 Quick Start

```bash
# Install in your CI environment
npm install -g dashcam

# Authenticate with your API key (get it from app.testdriver.ai/team)
dashcam auth $TD_API_KEY

# Wrap your test command
dashcam record --title "E2E Test Run" &
DASHCAM_PID=$!

# Run your tests
npm run test:e2e

# Stop recording and auto-upload
dashcam stop
```

**That's it!** Your test run is recorded, uploaded, and ready to debug. 🎉

> 💡 **Get your API key** from [app.testdriver.ai/team](https://app.testdriver.ai/team)

---

## ✨ Features

### 🎥 **Automated Test Recording**
- Capture full video of test executions in CI/CD
- High-quality video powered by FFmpeg
- Background recording that runs alongside your tests
- Works with any test framework (Playwright, Selenium, Cypress, Puppeteer, etc.)

### 🕵️ **Intelligent Log Tracking**
Synchronize logs with video timeline for complete observability:

- **📂 Application Logs**: Tail any log file in real-time
  ```bash
  dashcam logs --add --name=app-logs --type=file --file=/var/log/myapp.log
  ```

- **🌐 Browser Events**: Capture console logs, network requests, and navigation
  ```bash
  dashcam logs --add --name=webapp --type=web --pattern="*localhost:3000*"
  ```

- **🔄 Perfect Sync**: All events timestamped and aligned with video

### ☁️ **CI-Friendly Upload**
- Automatic cloud storage after test completion
- Instant shareable links for team debugging
- Project organization and retention policies
- No manual intervention required

### 🎯 **Perfect for...**
- 🤖 **CI/CD Pipelines**: Record test runs in GitHub Actions, GitLab CI, Jenkins, etc.
- 🖥️ **Custom VMs**: Capture agent behavior on headless or virtual machines
- 🧠 **AI Agents**: Record computer-use agents (Claude, OpenAI, AutoGPT, etc.)
- � **Test Debugging**: See exactly what happened when tests fail
- 📊 **QA Validation**: Visual proof of test coverage and behavior

---

## � CI/CD Integration

### GitHub Actions

```yaml
name: E2E Tests with Video Recording

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'
      
      - name: Install dependencies
        run: npm install
      
      - name: Install Dashcam
        run: npm install -g dashcam
      
      - name: Authenticate Dashcam
        run: dashcam auth ${{ secrets.TD_API_KEY }}
      
      - name: Start recording
        run: |
          dashcam record --title "E2E Tests - ${{ github.sha }}" \
                         --description "Automated test run on branch ${{ github.ref_name }}" \
                         --project ${{ secrets.DASHCAM_PROJECT_ID }} &
          sleep 2
      
      - name: Run tests
        run: npm run test:e2e
      
      - name: Stop recording and upload
        if: always()
        run: dashcam stop
```

### GitLab CI

```yaml
e2e-tests:
  stage: test
  image: node:18
  before_script:
    - npm install -g dashcam
    - dashcam auth $TD_API_KEY
  script:
    - dashcam record --title "E2E Tests - $CI_COMMIT_SHORT_SHA" &
    - sleep 2
    - npm run test:e2e
  after_script:
    - dashcam stop
  variables:
    TD_API_KEY: $TD_API_KEY
    DASHCAM_PROJECT_ID: $DASHCAM_PROJECT_ID
```

### Jenkins

```groovy
pipeline {
    agent any
    
    environment {
        TD_API_KEY = credentials('dashcam-api-key')
    }
    
    stages {
        stage('Setup') {
            steps {
                sh 'npm install -g dashcam'
                sh 'dashcam auth $TD_API_KEY'
            }
        }
        
        stage('Test') {
            steps {
                sh 'dashcam record --title "E2E Tests - ${BUILD_NUMBER}" &'
                sh 'sleep 2'
                sh 'npm run test:e2e'
            }
        }
    }
    
    post {
        always {
            sh 'dashcam stop'
        }
    }
}
```

### Docker/Custom VMs

```dockerfile
FROM node:18

# Install Dashcam
RUN npm install -g dashcam

# Your app setup
WORKDIR /app
COPY . .
RUN npm install

# Authenticate (use build args or runtime env)
ARG TD_API_KEY
RUN dashcam auth $TD_API_KEY

# Run tests with recording
CMD ["sh", "-c", "dashcam record --title 'Container Tests' & sleep 2 && npm test && dashcam stop"]
```

---

## 🤖 AI Agent Integration

### Recording Computer-Use Agents

Perfect for capturing AI agent behavior (Claude Computer Use, OpenAI Agents, AutoGPT, etc.):

```javascript
import { spawn } from 'child_process';

async function runAgentWithRecording(agentTask) {
  // Start recording
  const recording = spawn('dashcam', [
    'record',
    '--title', `Agent Task: ${agentTask}`,
    '--description', 'AI agent execution recording'
  ]);
  
  // Wait for recording to initialize
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    // Run your AI agent
    await runAgent(agentTask);
  } finally {
    // Always stop and upload recording
    spawn('dashcam', ['stop']);
  }
}
```

### Python Agent Integration

```python
import subprocess
import time

def record_agent_execution(task_description):
    # Start recording
    recording = subprocess.Popen([
        'dashcam', 'record',
        '--title', f'Agent Task: {task_description}',
        '--description', 'AI agent execution'
    ])
    
    time.sleep(2)  # Let recording initialize
    
    try:
        # Run your agent code
        run_my_agent()
    finally:
        # Stop and upload
        subprocess.run(['dashcam', 'stop'])

# Usage
record_agent_execution("Browse web and fill form")
```

---

## �📦 Installation

### NPM (Recommended for CI)
```bash
npm install -g dashcam
```

### Project Dependency
```bash
npm install --save-dev dashcam
```

Then in your package.json:
```json
{
  "scripts": {
    "test:recorded": "dashcam record --title 'Test Run' & sleep 2 && npm test; dashcam stop"
  }
}
```

### From Source
```bash
git clone https://github.com/testdriverai/dashcam.git
cd dashcam
npm install
npm link
```

### Requirements
- **Node.js** 14.0.0 or higher
- **FFmpeg** (bundled automatically via ffmpeg-static)
- **Display server** (X11, Wayland, or macOS windowing system)

---

## 🎯 Examples

### Example 1: Playwright Test Suite

```bash
#!/bin/bash
set -e

# Setup
dashcam auth $TD_API_KEY

# Configure browser log tracking
dashcam logs --add --name=playwright --type=web --pattern="*localhost:*"

# Start recording
dashcam record --title "Playwright E2E Suite" \
               --description "Full test suite execution" &

sleep 2

# Run Playwright tests
npx playwright test

# Stop and upload
dashcam stop
```

### Example 2: Selenium Grid

```bash
#!/bin/bash

# Track application logs
dashcam logs --add --name=app --type=file --file=/var/log/app.log
dashcam logs --add --name=selenium --type=file --file=/var/log/selenium.log

# Start recording
dashcam record --title "Selenium Grid Tests" --project my-project &

sleep 2

# Run tests on Selenium Grid
pytest tests/selenium/ --hub=http://selenium-hub:4444

# Cleanup
dashcam stop
```

### Example 3: Custom Test Framework

```javascript
// test-runner.js
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

async function runTestsWithRecording() {
  // Start recording
  exec('dashcam record --title "Custom Tests" &');
  
  // Wait for initialization
  await new Promise(resolve => setTimeout(resolve, 2000));
  
  try {
    // Run your custom test framework
    await execAsync('node tests/runner.js');
    console.log('Tests completed successfully');
  } catch (error) {
    console.error('Tests failed:', error);
    throw error;
  } finally {
    // Always upload the recording
    await execAsync('dashcam stop');
  }
}

runTestsWithRecording().catch(console.error);
```

### Example 4: Multi-Service Test Environment

```bash
#!/bin/bash

# Setup log tracking for all services
dashcam logs --add --name=frontend --type=file --file=/var/log/frontend.log
dashcam logs --add --name=backend --type=file --file=/var/log/backend.log
dashcam logs --add --name=database --type=file --file=/var/log/postgres.log

# Track web apps
dashcam logs --add --name=app --type=web --pattern="*localhost:3000*"
dashcam logs --add --name=admin --type=web --pattern="*localhost:8080*"

# Start recording
dashcam record --title "Integration Tests" \
               --description "# Multi-service test\n\nFrontend, backend, and database" &

sleep 2

# Start services
docker-compose up -d

# Wait for services to be ready
sleep 10

# Run integration tests
npm run test:integration

# Cleanup
docker-compose down
dashcam stop
```

---

## 📚 Commands

### `dashcam auth <apiKey>`
Authenticate with your TestDriver API key.

> 💡 **Get your API key** from [app.testdriver.ai/team](https://app.testdriver.ai/team)

```bash
dashcam auth 4e93d8bf-3886-4d26-a144-116c4063522d
```

**In CI environments:**
```bash
# Use environment variable
dashcam auth $TD_API_KEY
```

### `dashcam record [options]`
Start a new background recording for your test run.

**Options:**
- `-t, --title <title>` - Recording title (e.g., "E2E Test Suite")
- `-d, --description <description>` - Description (supports Markdown)
- `-p, --project <project>` - Project ID for organization
- `-f, --fps <fps>` - Frames per second (default: 30)
- `-a, --audio` - Include audio (experimental)
- `-o, --output <path>` - Custom output path
- `-v, --verbose` - Enable verbose logging

**Examples:**
```bash
# Basic test recording
dashcam record --title "Nightly E2E Tests" &

# With project and metadata
dashcam record --title "Sprint 23 Tests" \
               --description "Testing new authentication flow" \
               --project proj_abc123 &

# High FPS for smooth playback
dashcam record --fps 60 --title "UI Animation Tests" &
```

### `dashcam stop`
Stop the current recording and upload it. Always call this in CI, even if tests fail.

```bash
dashcam stop
```

**CI Best Practice:**
```yaml
# GitHub Actions
- name: Stop recording and upload
  if: always()  # Run even if tests fail
  run: dashcam stop
```

### `dashcam status`
Check if a recording is in progress.

```bash
dashcam status
# Output:
# Recording in progress
# Duration: 45.2 seconds
# PID: 12345
# Started: 11/6/2025, 2:30:15 PM
# Title: Bug Investigation
```

### `dashcam logs [options]`
Manage log tracking configurations.

**Options:**
- `--add` - Add a new log tracker
- `--remove <id>` - Remove a tracker by ID
- `--list` - List all configured trackers
- `--status` - Show tracking status with event counts
- `--name <name>` - Tracker name (required with --add)
- `--type <type>` - Type: "web" or "file" (required with --add)
- `--pattern <pattern>` - URL pattern for web trackers (can specify multiple)
- `--file <file>` - File path for file trackers

**Examples:**
```bash
# Add web tracker with multiple patterns
dashcam logs --add --name=social --type=web \
  --pattern="*facebook.com*" \
  --pattern="*twitter.com*"

# Add file tracker
dashcam logs --add --name=app --type=file --file=/var/log/app.log

# List all trackers
dashcam logs --list

# Check activity
dashcam logs --status
```

### `dashcam upload [filePath] [options]`
Upload a recording file or recover from interruption.

**Options:**
- `-t, --title <title>` - Recording title
- `-d, --description <description>` - Description
- `-p, --project <project>` - Project ID
- `--recover` - Recover interrupted recording

**Examples:**
```bash
# Upload specific file
dashcam upload /path/to/recording.webm --title "My Recording"

# Recover from interruption
dashcam upload --recover
```

### `dashcam logout`
Clear authentication credentials.

```bash
dashcam logout
```

---

## 🔧 Advanced Usage

### Pattern Matching for Web Trackers

Web trackers support powerful wildcard patterns for capturing browser events during automated tests:

```bash
# Match any subdomain
dashcam logs --add --name=app --type=web --pattern="*.myapp.com*"

# Match specific paths
dashcam logs --add --name=admin --type=web --pattern="*app.com/admin/*"

# Match local dev servers (common in tests)
dashcam logs --add --name=dev --type=web --pattern="*localhost:*"

# Match test environments
dashcam logs --add --name=staging --type=web \
  --pattern="*staging.myapp.com*" \
  --pattern="*test.myapp.com*"
```

### Working with Log Files in Tests

```bash
# Ensure log files exist before starting
mkdir -p /var/log/myapp
touch /var/log/myapp/app.log
touch /var/log/myapp/error.log

# Add to tracking
dashcam logs --add --name=app --type=file --file=/var/log/myapp/app.log
dashcam logs --add --name=errors --type=file --file=/var/log/myapp/error.log

# Start recording
dashcam record --title "Test Run with Logs" &

sleep 2

# Your tests run and write logs
npm test

# All logs are synchronized with video
dashcam stop
```

### Environment Variables

For CI/CD environments, use environment variables instead of hardcoding:

```bash
# Set in CI environment
export TD_API_KEY="your-api-key"
export DASHCAM_PROJECT_ID="proj_abc123"

# Use in scripts
dashcam auth $TD_API_KEY
dashcam record --title "Tests" --project $DASHCAM_PROJECT_ID &
```

### Programmatic Usage in Test Frameworks

#### Jest Integration

```javascript
// jest.config.js
module.exports = {
  globalSetup: './test/setup.js',
  globalTeardown: './test/teardown.js'
};

// test/setup.js
import { exec } from 'child_process';

export default async function globalSetup() {
  console.log('Starting Dashcam recording...');
  exec('dashcam record --title "Jest Test Suite" &');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

// test/teardown.js
import { execSync } from 'child_process';

export default async function globalTeardown() {
  console.log('Stopping Dashcam recording...');
  execSync('dashcam stop');
}
```

#### Mocha Integration

```javascript
// test/hooks.js
import { exec, execSync } from 'child_process';

before(async function() {
  this.timeout(5000);
  console.log('Starting recording...');
  exec('dashcam record --title "Mocha Tests" &');
  await new Promise(resolve => setTimeout(resolve, 2000));
});

after(function() {
  this.timeout(10000);
  console.log('Uploading recording...');
  execSync('dashcam stop');
});
```

#### Pytest Integration

```python
# conftest.py
import subprocess
import time
import pytest

@pytest.fixture(scope="session", autouse=True)
def record_session():
    # Start recording
    print("Starting Dashcam recording...")
    subprocess.Popen([
        'dashcam', 'record',
        '--title', 'Pytest Test Suite'
    ])
    time.sleep(2)
    
    yield
    
    # Stop and upload
    print("Stopping recording...")
    subprocess.run(['dashcam', 'stop'])
```

---

## 🌐 Browser Extension for Test Automation

For web test automation (Playwright, Selenium, Puppeteer, etc.), install the Dashcam browser extension to capture:

- **Console logs** from your application
- **Network requests** and responses
- **JavaScript errors** and warnings
- **Page navigation** events

### Setup

1. **Install extension** (Chrome/Firefox) 
2. **Start Dashcam CLI** - Extension auto-connects via WebSocket
3. **Run your tests** - All browser events captured automatically
4. **Upload recording** - Browser logs included alongside video

The CLI automatically starts a WebSocket server on available ports (10368, 16240, 21855, 24301, or 25928).

### Headless Testing

For headless browsers in CI, browser extension features won't be available, but you can still:
- Record the full test execution video
- Track application log files
- Capture system-level events

---

## 💡 Tips for CI/CD

### 1. Always Use `if: always()` in CI

```yaml
# GitHub Actions - Always upload recording
- name: Stop recording
  if: always()
  run: dashcam stop
```

### 2. Set Proper Timeouts

```bash
# Give recording time to initialize
dashcam record --title "Tests" &
sleep 2  # Important!
npm test
```

### 3. Use Descriptive Titles

```bash
# Include branch, commit, or build number
dashcam record --title "E2E Tests - ${GITHUB_SHA}" \
               --description "Branch: ${GITHUB_REF_NAME}"
```

### 4. Organize with Projects

```bash
# Group recordings by project
dashcam record --project $DASHCAM_PROJECT_ID
```

### 5. Handle Failed Tests Gracefully

```bash
# Bash script with proper error handling
set -e
dashcam record --title "Tests" &
sleep 2

# Tests might fail, but still upload
npm test || TEST_FAILED=true

dashcam stop

# Exit with test status
if [ "$TEST_FAILED" = true ]; then
  exit 1
fi
```

---

## 🗂️ Project Structure

```
dashcam/
├── bin/
│   └── dashcam.js          # CLI entry point
├── lib/
│   ├── auth.js             # Authentication
│   ├── recorder.js         # Screen recording engine
│   ├── uploader.js         # Cloud upload
│   ├── processManager.js   # Background process handling
│   ├── logs/               # Log tracking core
│   ├── tracking/           # File & activity tracking
│   ├── extension-logs/     # Browser extension integration
│   └── websocket/          # WebSocket server
└── examples/               # Example scripts
```

---

## 🤝 Contributing

We love contributions! Here's how you can help:

1. 🐛 **Report bugs** via GitHub issues
2. 💡 **Suggest features** we should build
3. 🔧 **Submit PRs** with improvements
4. 📖 **Improve docs** for clarity

---

## 📄 License

MIT © TestDriver.ai

---

## 🔗 Links

- **Documentation**: [Full Guide](./LOG_TRACKING_GUIDE.md)
- **Issues**: [GitHub Issues](https://github.com/testdriverai/dashcam/issues)
- **Website**: [testdriver.ai](https://testdriver.ai)

---

<div align="center">

**Made with ❤️ by the TestDriver.ai team**

[⭐ Star us on GitHub](https://github.com/testdriverai/dashcam) • [🐦 Follow us on Twitter](https://twitter.com/testdriverai)

</div>
