#!/bin/bash

# Test workflow script for dashcam CLI
set -e

echo "🎬 Starting Dashcam CLI Test Workflow"
echo "======================================"

# 1. Authenticate with API key
echo "1. Authenticating with API key..."
./bin/dashcam.js auth $TD_API_KEY
echo "✅ Authentication complete"

# 2. Track web for testdriver.ai
echo ""
echo "2. Setting up web tracking for testdriver.ai..."
./bin/dashcam.js logs --add --name=testdriver-tracking --type=web --pattern="*testdriver.ai*"
echo "✅ Web tracking configured"

# 3. Create temporary file and set up file tracking
echo ""
echo "3. Setting up file tracking..."
TEMP_FILE="/tmp/test-cli-log.txt"

# Clear the file to start fresh (remove old events from previous test runs)
> "$TEMP_FILE"
echo "Created fresh test file: $TEMP_FILE"

# File is already tracked from previous tests, check if it exists in config
if ! ./bin/dashcam.js logs --list 2>/dev/null | grep -q "$TEMP_FILE"; then
  ./bin/dashcam.js logs --add --name=temp-file-tracking --type=file --file="$TEMP_FILE"
fi
echo "✅ File tracking configured"

# 4. Start dashcam recording in background
echo ""
echo "4. Starting dashcam recording in background..."
# Start recording and redirect output to a log file so we can still monitor it
./bin/dashcam.js record --title "Sync Test Recording" --description "Testing video/log synchronization with timestamped events" > /tmp/dashcam-recording.log 2>&1

# Wait for recording to initialize and log tracker to start
echo "Waiting for recording to initialize..."
sleep 2

# Write first event after log tracker is fully ready
RECORDING_START=$(date +%s)
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔴 EVENT 1: Recording START at $(date '+%H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "[EVENT 1] 🔴 Recording started with emoji at $(date '+%H:%M:%S') - TIMESTAMP: $RECORDING_START" >> "$TEMP_FILE"

# Verify background recording process is actually running
if pgrep -f "dashcam-background.js" > /dev/null; then
  echo "✅ Recording started successfully"
else
  echo "❌ Recording process died, check /tmp/dashcam-recording.log"
  cat /tmp/dashcam-recording.log
  exit 1
fi

# 5. Create synchronized log events with visual markers
echo ""
echo "5. Creating synchronized test events..."
echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║  SYNC TEST - Watch for these markers in the recording!        ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""

# Event 1 was already written above - now continue with the rest
sleep 3

# Event 2 - after 3 seconds
echo ""
echo "🟡 EVENT 2: 3 seconds mark at $(date '+%H:%M:%S')"
echo "[EVENT 2] 🟡 3 seconds elapsed with emoji at $(date '+%H:%M:%S')" >> "$TEMP_FILE"
sleep 3

# Event 3 - after 6 seconds
echo ""
echo "🟢 EVENT 3: 6 seconds mark at $(date '+%H:%M:%S')"
echo "[EVENT 3] 🟢 6 seconds elapsed with emoji at $(date '+%H:%M:%S')" >> "$TEMP_FILE"
sleep 3

# Event 4 - after 9 seconds
echo ""
echo "🔵 EVENT 4: 9 seconds mark at $(date '+%H:%M:%S')"
echo "[EVENT 4] 🔵 9 seconds elapsed with emoji at $(date '+%H:%M:%S')" >> "$TEMP_FILE"
sleep 3

# Event 5 - after 12 seconds
echo ""
echo "🟣 EVENT 5: 12 seconds mark at $(date '+%H:%M:%S')"
echo "[EVENT 5] 🟣 12 seconds elapsed with emoji at $(date '+%H:%M:%S')" >> "$TEMP_FILE"
sleep 3

# Event 6 - before ending
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "⚫ EVENT 6: Recording END at $(date '+%H:%M:%S')"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
RECORDING_END=$(date +%s)
echo "[EVENT 6] ⚫ Recording ending with emoji at $(date '+%H:%M:%S') - TIMESTAMP: $RECORDING_END" >> "$TEMP_FILE"

DURATION=$((RECORDING_END - RECORDING_START))
echo ""
echo "✅ Test events completed (Duration: ${DURATION}s)"

# Give a moment for the last event to be fully processed
echo ""
echo "Waiting 2 seconds to ensure all events are captured..."
sleep 2

# 6. Stop recording and upload (this will kill the background recording process)
echo ""
echo "6. Stopping recording and uploading..."
# Check if recording is still active
if ./bin/dashcam.js status | grep -q "Recording in progress"; then
  ./bin/dashcam.js stop
  echo "✅ Recording stopped and uploaded"
else
  echo "⚠️  Recording already completed (this is expected with background mode)"
fi

echo ""
echo "🧹 Cleaning up..."

echo ""
echo "🎉 Test workflow completed successfully!"
echo "======================================"

# Show final status
echo ""
echo "📊 Final Status:"
./bin/dashcam.js status

echo ""
echo "╔════════════════════════════════════════════════════════════════╗"
echo "║                  SYNC VERIFICATION GUIDE                       ║"
echo "╚════════════════════════════════════════════════════════════════╝"
echo ""
echo "To verify video/log synchronization in the recording:"
echo ""
echo "1. Open the uploaded recording in your browser"
echo "2. Check the log panel for '$TEMP_FILE'"
echo "3. Verify these events appear at the correct times:"
echo ""
echo "   Time   | Terminal Display          | Log Entry"
echo "   -------|---------------------------|---------------------------"
echo "   0:00   | 🔴 EVENT 1               | [EVENT 1] 🔴 Recording started"
echo "   0:03   | 🟡 EVENT 2               | [EVENT 2] 🟡 3 seconds elapsed"
echo "   0:06   | 🟢 EVENT 3               | [EVENT 3] 🟢 6 seconds elapsed"
echo "   0:09   | 🔵 EVENT 4               | [EVENT 4] 🔵 9 seconds elapsed"
echo "   0:12   | 🟣 EVENT 5               | [EVENT 5] 🟣 12 seconds elapsed"
echo "   0:15   | ⚫ EVENT 6               | [EVENT 6] ⚫ Recording ending"
echo ""
echo "4. The log timestamps should match the video timeline exactly"
echo "5. Each colored event marker should appear in the video"
echo "   at the same moment as the corresponding log entry"
echo ""

