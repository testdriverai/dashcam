# Single-Frame Video & Frame Drop Issues - Root Cause & Fix

## Problem Description

Videos produced by dashcam-cli had two related issues:
1. **Single-frame appearance**: Videos appearing as single-frame, even though they contained multiple frames
2. **Frame drops**: Videos showing significantly shorter duration than actual recording time (e.g., 12 seconds shown vs 68 seconds actual)

## Root Causes

### Issue 1: Incomplete WebM Container Metadata
When ffmpeg's VP9 encoder is terminated before it can properly finalize the stream:

1. **Missing duration metadata** - The WebM container doesn't have duration information
2. **Premature file ending** - FFprobe reports "File ended prematurely"  
3. **Playback issues** - Some players show only the first frame because they can't seek without duration metadata

### Issue 2: Frame Dropping During Capture
Frames were being dropped during the recording process due to:

1. **Conflicting frame rate settings** - Platform config had hardcoded `-r 30` while fps parameter was set to 10
2. **Insufficient buffer sizes** - Default thread queue size caused frame drops when encoder couldn't keep up
3. **Premature stream termination** - The `-shortest` flag caused encoding to stop before all buffered frames were processed
4. **Missing vsync enforcement** - Frames could be skipped instead of encoded

### Example from Real Recording

```bash
# File: 691cb2b4c2fc02f59ae66e21.mp4
Frame count: 512 frames
Actual duration: 17.06 seconds (when decoded)
Container duration: N/A (missing metadata)
Warning: "File ended prematurely"
```

The video has 512 frames spanning 17 seconds, but players that rely on container metadata see it as a single frame.

## Platform Specificity

This issue can occur on all platforms but may be more prevalent on Linux due to:
- Different screen capture performance characteristics
- Variations in how X11grab delivers frames vs AVFoundation (macOS) or gdigrab (Windows)
- System load affecting encoder buffer flush timing

## Fix Applied

### 1. Minimum Recording Duration (recorder.js)
```javascript
const MIN_RECORDING_DURATION = 2000; // 2 seconds minimum
if (recordingDuration < MIN_RECORDING_DURATION) {
  const waitTime = MIN_RECORDING_DURATION - recordingDuration;
  await new Promise(resolve => setTimeout(resolve, waitTime));
}
```

### 2. Improved FFmpeg Encoding Parameters

**Removed conflicting settings:**
```javascript
// REMOVED from platform config:
'-r', '30'  // This conflicted with fps parameter

// REMOVED from output args:
'-shortest'  // This caused premature termination
```

**Added buffer and sync enforcement:**
```javascript
// Input buffering (before -i):
'-thread_queue_size', '512',    // Large input buffer prevents drops
'-probesize', '50M',            // Better stream detection

// Output sync enforcement:
'-vsync', '1',                   // Constant frame rate - encode every frame
'-max_muxing_queue_size', '9999' // Large muxing queue prevents drops

// Existing improvements:
'-quality', 'good',              // Changed from 'realtime' for better finalization
'-cpu-used', '4',                // Balanced encoding speed
'-deadline', 'good',             // Good quality mode
'-g', fps.toString(),            // Keyframe every second (was 2 seconds)
'-force_key_frames', `expr:gte(t,n_forced*1)`, // Force keyframes every 1s
'-fflags', '+genpts',            // Generate presentation timestamps
'-avoid_negative_ts', 'make_zero' // Prevent timestamp issues
```

### 3. Extended Graceful Shutdown Timing
```javascript
// Graceful quit: 5s -> 8s (VP9 needs time to finalize)
// SIGTERM timeout: 10s -> 15s
// Post-exit wait: 3s (for filesystem sync)

currentRecording.stdin.write('q');
currentRecording.stdin.end(); // Properly close stdin
```

## Testing

Use the provided test script to verify recordings:

```bash
# Analyze existing video
node test-short-recording.js analyze <video-file>

# Run automated tests with various durations
node test-short-recording.js
```

The test checks for:
- ✅ Frame count > 1
- ✅ No "File ended prematurely" warnings
- ✅ Container metadata is complete (duration present)
- ✅ All platforms (macOS/Linux/Windows)

## Prevention

The fix ensures proper container finalization by:
1. Enforcing minimum recording time for multiple frames
2. Using encoding parameters that prioritize stream finalization
3. Allowing sufficient time for VP9 encoder to flush buffers
4. Properly closing stdin before waiting for process exit
5. Adding safety timeouts before force-killing the encoder

## Impact

- Short recordings (< 2s) now wait to ensure at least 2 seconds of footage
- All recordings get properly finalized WebM container metadata
- Videos play correctly in all players, including web browsers
- No more "single frame" issues on any platform
