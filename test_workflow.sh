#!/bin/bash

# Test workflow script for dashcam CLI
set -e

echo "🎬 Starting Dashcam CLI Test Workflow"
echo "======================================"

# 1. Authenticate with API key
echo "1. Authenticating with API key..."
./bin/dashcam.js auth 4e93d8bf-3886-4d26-a144-116c4063522d
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
echo "Using existing test file: $TEMP_FILE"

# File is already tracked from previous tests, check if it exists
if [ ! -f "$TEMP_FILE" ]; then
  touch "$TEMP_FILE"
  ./bin/dashcam.js logs --add --name=temp-file-tracking --type=file --file="$TEMP_FILE"
fi
echo "✅ File tracking configured"

# 4. Start background process that logs current time to the temporary file
echo ""
echo "4. Starting background logging process..."
(
  while true; do
    echo "$(date): Current time logged" >> "$TEMP_FILE"
    sleep 2
  done
) &
LOGGER_PID=$!
echo "✅ Background logger started (PID: $LOGGER_PID)"

# 5. Start dashcam recording in background
echo ""
echo "5. Starting dashcam recording in background..."
./bin/dashcam.js record --verbose --title "Test Workflow Recording" --description "Testing CLI workflow with web and file tracking" &

# Give the recording a moment to initialize
sleep 2
echo "✅ Recording started in background"

# 6. Let recording run for a few seconds
echo ""
echo "6. Letting recording run for 20 seconds..."
sleep 20
echo "✅ Recording completed"

# 7. Stop recording and upload (this will kill the background recording process)
echo ""
echo "7. Stopping recording and uploading..."
./bin/dashcam.js stop
echo "✅ Recording stopped and uploaded"

# Cleanup: Stop the background logger
echo ""
echo "🧹 Cleaning up..."
kill $LOGGER_PID 2>/dev/null || true
echo "✅ Background logger stopped"

echo ""
echo "🎉 Test workflow completed successfully!"
echo "======================================"

# Show final status
echo ""
echo "📊 Final Status:"
./bin/dashcam.js status

