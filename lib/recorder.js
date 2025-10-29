import { execa } from 'execa';
import ffmpeg from 'ffmpeg-static';
import { logger, logFunctionCall } from './logger.js';
import { createGif, createSnapshot } from './ffmpeg.js';
import { applicationTracker } from './applicationTracker.js';
import { logsTrackerManager, trimLogs } from './logs/index.js';
import path from 'path';
import os from 'os';
import fs from 'fs';
// State management
let currentRecording = null;
let outputPath = null;
let recordingStartTime = null;
let currentTempFile = null;

// File paths  
const DASHCAM_DIR = path.join(process.cwd(), '.dashcam');
const TEMP_FILE_INFO_PATH = path.join(DASHCAM_DIR, 'temp-file.json');

// Platform-specific configurations
const PLATFORM_CONFIG = {
  darwin: {
    inputFormat: 'avfoundation',
    screenInput: '1:none',  // Use explicit format with no audio
    audioInput: '0',        // Default audio device if needed
    audioFormat: 'avfoundation',
    extraArgs: [
      '-video_size', '1920x1080',  // Set explicit resolution
      '-pixel_format', 'uyvy422',  // Use supported pixel format
      '-r', '30'                   // Set frame rate
    ]
  },
  win32: {
    inputFormat: 'gdigrab',
    screenInput: 'desktop',
    audioInput: 'audio="virtual-audio-capturer"',
    audioFormat: 'dshow'
  },
  linux: {
    inputFormat: 'x11grab',
    screenInput: ':0.0',
    audioInput: 'default',
    audioFormat: 'pulse'
  }
};

/**
 * Get the FFmpeg arguments for the current platform
 */
function getPlatformArgs({ fps, includeAudio }) {
  const logExit = logFunctionCall('getPlatformArgs', { fps, includeAudio });
  
  const platform = os.platform();
  const config = PLATFORM_CONFIG[platform] || PLATFORM_CONFIG.darwin;
  
  logger.verbose('Using platform configuration', { 
    platform, 
    config: {
      inputFormat: config.inputFormat,
      screenInput: config.screenInput,
      audioInput: config.audioInput
    }
  });
  
  const args = [
    '-f', config.inputFormat
  ];

  // Add platform-specific extra args before input
  if (config.extraArgs) {
    args.push(...config.extraArgs);
  }

  args.push(
    '-framerate', fps.toString(),
    '-i', config.screenInput
  );

  // Add audio capture if enabled
  if (includeAudio) {
    args.push(
      '-f', config.audioFormat,
      '-i', config.audioInput
    );
  }

  // Log the command being constructed
  logger.debug('FFmpeg capture command:', { args: args.join(' ') });
  logger.verbose('Platform-specific arguments added', { 
    totalArgs: args.length,
    includeAudio,
    fps 
  });

  logExit();
  return args;
}

/**
 * Generate a valid output path for the recording
 */
function generateOutputPath() {
  const logExit = logFunctionCall('generateOutputPath');
  
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Use local tmp directory instead of system temp
  const directory = path.join(process.cwd(), 'tmp', 'recordings');
  const filepath = path.join(directory, `recording-${timestamp}.webm`);
  
  logger.verbose('Generating output path', {
    timestamp,
    directory,
    filepath,
    directoryExists: fs.existsSync(directory)
  });
  
  // Ensure directory exists
  fs.mkdirSync(directory, { recursive: true });
  
  logger.debug('Created recordings directory', { directory });
  
  logExit();
  return filepath;
}

/**
 * Start a new screen recording
 */
export async function startRecording({ 
  fps = 10,
  includeAudio = false,
  customOutputPath = null
} = {}) {
  if (currentRecording) {
    throw new Error('Recording already in progress');
  }

  outputPath = customOutputPath || generateOutputPath();
  
  // Construct FFmpeg command arguments
  const platformArgs = getPlatformArgs({ fps, includeAudio });
  const outputArgs = [
    '-c:v', 'libvpx',      // Use VP8 codec instead of VP9 for better compatibility
    '-b:v', '1M',          // Set specific bitrate instead of variable
    // Remove explicit pixel format to let ffmpeg handle conversion automatically
    '-r', fps.toString(),   // Ensure output framerate matches input
    '-g', '30',            // Keyframe every 30 frames
    // WebM options for more frequent disk writes
    '-f', 'webm',          // Force WebM container format
    '-flush_packets', '1', // Flush packets immediately to disk
    '-max_muxing_queue_size', '1024' // Limit muxing queue to prevent delays
  ];

  if (includeAudio) {
    outputArgs.push(
      '-c:a', 'libopus',   // Opus audio codec for WebM
      '-b:a', '128k'
    );
  }

  // Create a temporary file for the recording in our workspace
  const tempDir = path.dirname(outputPath);
  const timestamp = Date.now();
  const tempFile = path.join(tempDir, `temp-${timestamp}.webm`);
  currentTempFile = tempFile; // Store globally for stopRecording
  
  logger.info('Generated temp file path', { tempFile, timestamp, tempDir });
  
  // Also persist temp file path to disk for cross-process access
  try {
    // Ensure .dashcam directory exists
    if (!fs.existsSync(DASHCAM_DIR)) {
      fs.mkdirSync(DASHCAM_DIR, { recursive: true });
    }
    
    const tempFileInfo = {
      tempFile,
      outputPath,
      startTime: timestamp
    };
    fs.writeFileSync(TEMP_FILE_INFO_PATH, JSON.stringify(tempFileInfo));
    logger.info('Wrote temp file info to disk', { path: TEMP_FILE_INFO_PATH, tempFileInfo });
  } catch (error) {
    logger.warn('Failed to write temp file info', { error });
  }

  // WebM doesn't need movflags (those are MP4-specific)
  const args = [
    ...platformArgs,
    ...outputArgs,
    '-y', // Overwrite output file if it exists
    tempFile
  ];

  const fullCommand = [ffmpeg, ...args].join(' ');
  logger.info('Starting recording with options:', {
    fps,
    includeAudio,
    platform: os.platform(),
    outputPath,
    tempFile
  });
  
  logger.verbose('FFmpeg command details', {
    ffmpegPath: ffmpeg,
    totalArgs: args.length,
    outputArgs: outputArgs.join(' '),
    platformArgs: platformArgs.join(' ')
  });
  
  logger.trace('Full FFmpeg command', { command: fullCommand });

  try {
    logger.debug('Spawning FFmpeg process...');
    currentRecording = execa(ffmpeg, args, {
      reject: false,
      all: true, // Capture both stdout and stderr
      stdin: 'pipe' // Enable stdin for sending 'q' to stop recording
    });

    recordingStartTime = Date.now();
    
    logger.info('FFmpeg process spawned', { 
      pid: currentRecording.pid,
      args: args.slice(-5), // Log last 5 args including output file
      tempFile 
    });
    
    // Check if temp file gets created within first few seconds
    setTimeout(() => {
      if (fs.existsSync(tempFile)) {
        logger.info('Temp file created successfully', { 
          path: tempFile, 
          size: fs.statSync(tempFile).size 
        });
      } else {
        logger.warn('Temp file not created yet', { path: tempFile });
      }
    }, 3000);

    // Start application tracking
    logger.debug('Starting application tracking...');
    applicationTracker.start();
    
    // Start log tracking for this recording
    logger.debug('Starting log tracking...');
    await logsTrackerManager.startNew({
      recorderId: generateOutputPath().split('/').pop().replace('.webm', ''), // Use filename as ID
      screenId: '1', // Default screen ID for CLI
      directory: path.dirname(outputPath)
    });

    if (currentRecording.all) {
      currentRecording.all.setEncoding('utf8');
      currentRecording.all.on('data', (data) => {
        // Parse FFmpeg output for useful information
        const output = data.toString().trim();
        logger.info(`FFmpeg output: ${output}`);
        
        // Check for permission issues
        if (output.includes('Configuration of video device failed')) {
          logger.error('PERMISSION ISSUE DETECTED: Screen recording failed. This happens because the Node.js subprocess doesn\'t inherit VS Code\'s screen recording permissions.');
          logger.error('SOLUTION: Add Node.js to screen recording permissions:');
          logger.error('1. Open System Preferences > Security & Privacy > Privacy > Screen Recording');
          logger.error('2. Click the lock to unlock');
          logger.error('3. Click the + button and add: /usr/local/bin/node (or your Node.js installation path)');
          logger.error('4. Alternatively, find node with: which node');
          logger.error('5. Restart the terminal after adding permissions');
        }
        
        if (output.includes('frame=') || output.includes('time=')) {
          logger.verbose(`FFmpeg progress: ${output}`);
        } else if (output.includes('error') || output.includes('Error')) {
          logger.warn(`FFmpeg warning: ${output}`);
        } else {
          logger.debug(`FFmpeg: ${output}`);
        }
      });
    }

    logger.info('Recording process started successfully', {
      pid: currentRecording.pid,
      startTime: recordingStartTime
    });

    // Return immediately since FFmpeg is running
    return { outputPath, startTime: recordingStartTime };
  } catch (error) {
    logger.error('Failed to start recording:', error);
    currentRecording = null;
    recordingStartTime = null;
    currentTempFile = null;
    throw error;
  }
}

/**
 * Stop the current recording
 */
export async function stopRecording() {
  const logExit = logFunctionCall('stopRecording');
  
  if (!currentRecording) {
    throw new Error('No recording in progress');
  }

  const recordingDuration = Date.now() - recordingStartTime;
  logger.info('Stopping recording', {
    pid: currentRecording.pid,
    duration: recordingDuration,
    durationSeconds: (recordingDuration / 1000).toFixed(1)
  });

  try {
    // First try to gracefully stop FFmpeg by sending 'q'
    if (currentRecording && currentRecording.stdin) {
      logger.debug('Sending quit signal to FFmpeg...');
      currentRecording.stdin.write('q');
    }

    // Wait for FFmpeg to finish gracefully
    const gracefulTimeout = setTimeout(() => {
      if (currentRecording && !currentRecording.killed) {
        // If still running, try SIGTERM
        process.kill(currentRecording.pid, 'SIGTERM');
      }
    }, 2000);

    // Wait up to 5 seconds for SIGTERM to work
    const hardKillTimeout = setTimeout(() => {
      if (currentRecording && !currentRecording.killed) {
        // If still not dead, use SIGKILL as last resort
        process.kill(currentRecording.pid, 'SIGKILL');
      }
    }, 5000);

    // Wait for the process to fully exit
    if (currentRecording) {
      await currentRecording;
    }

    // Clear timeouts
    clearTimeout(gracefulTimeout);
    clearTimeout(hardKillTimeout);

    // Additional wait to ensure filesystem is synced
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Read temp file path from disk (for cross-process access)
    let tempFile = currentTempFile; // Try in-memory first
    
    logger.info('Looking for temp file', { 
      inMemory: currentTempFile, 
      infoFileExists: fs.existsSync(TEMP_FILE_INFO_PATH),
      infoPath: TEMP_FILE_INFO_PATH
    });
    
    console.log('DEBUG: Looking for temp file', { 
      inMemory: currentTempFile, 
      infoFileExists: fs.existsSync(TEMP_FILE_INFO_PATH),
      infoPath: TEMP_FILE_INFO_PATH
    });
    
    if (!tempFile && fs.existsSync(TEMP_FILE_INFO_PATH)) {
      try {
        const tempFileInfo = JSON.parse(fs.readFileSync(TEMP_FILE_INFO_PATH, 'utf8'));
        tempFile = tempFileInfo.tempFile;
        logger.info('Loaded temp file path from disk', { tempFile, tempFileInfo });
      } catch (error) {
        logger.error('Failed to read temp file info', { error });
      }
    }
    
    logger.info('Debug: temp file check', {
      tempFile,
      exists: tempFile ? fs.existsSync(tempFile) : false,
      size: tempFile && fs.existsSync(tempFile) ? fs.statSync(tempFile).size : 0
    });
    
    if (!tempFile) {
      throw new Error('No temp file path available');
    }

    if (!fs.existsSync(tempFile) || fs.statSync(tempFile).size === 0) {
      throw new Error('Recording file is empty or missing');
    }

    // Analyze temp file before processing
    const tempStats = fs.statSync(tempFile);
    logger.debug('Temp file stats:', {
      size: tempStats.size,
      path: tempFile
    });

    // Use ffmpeg to properly finalize the recording with WebM format
    const finalizeArgs = [
      '-f', 'webm',  // Force WebM format
      '-i', tempFile,
      '-c:v', 'libvpx',      // VP8 video codec for WebM (matching recording)
      '-c:a', 'libopus',     // Opus audio codec for WebM
      '-b:v', '1M',          // Fixed bitrate matching recording
      '-map', '0',
      '-y',
      outputPath
    ];

    logger.debug('Finalizing recording...', { command: finalizeArgs.join(' ') });
    
    // Try finalization multiple times with increasing delays
    const attempts = 3;
    let success = false;
    
    for (let i = 0; i < attempts && !success; i++) {
      // Wait longer between each attempt
      await new Promise(resolve => setTimeout(resolve, (i + 1) * 2000));
      
      try {
        logger.debug(`Finalization attempt ${i + 1} of ${attempts}`);
        
        const finalizeProcess = execa(ffmpeg, finalizeArgs, {
          reject: false,
          all: true
        });

        if (finalizeProcess.all) {
          finalizeProcess.all.setEncoding('utf8');
          finalizeProcess.all.on('data', (data) => {
            logger.debug(`FFmpeg finalize attempt ${i + 1}: ${data}`);
          });
        }

        const { exitCode, all: output } = await finalizeProcess;

        if (exitCode === 0 && fs.existsSync(outputPath) && fs.statSync(outputPath).size > 0) {
          success = true;
          logger.info(`Successfully finalized recording on attempt ${i + 1}`);
          break;
        } else {
          logger.warn(`Attempt ${i + 1} failed: ${output}`);
        }
      } catch (err) {
        logger.error(`Finalization attempt ${i + 1} error:`, err);
        if (i === attempts - 1) throw err;
      }
    }

    if (!success) {
      throw new Error('Failed to finalize recording after all attempts');
    }

    // Clean up temp file only after successful finalization
    try {
      fs.unlinkSync(tempFile);
    } catch (e) {
      logger.debug('Failed to delete temp file:', e);
    }

    // Generate paths for additional assets
    const basePath = outputPath.substring(0, outputPath.lastIndexOf('.'));
    const gifPath = `${basePath}.gif`;
    const snapshotPath = `${basePath}.png`;

    // Stop application tracking and get results
    logger.debug('Stopping application tracking...');
    const appTrackingResults = applicationTracker.stop();
    
    // Stop log tracking and get results
    const recorderId = path.basename(outputPath).replace('.webm', '');
    logger.debug('Stopping log tracking...', { recorderId });
    const logTrackingResults = await logsTrackerManager.stop({
      recorderId,
      screenId: '1'
    });
    
    logger.debug('Tracking results collected', {
      appResults: {
        apps: appTrackingResults.apps?.length || 0,
        icons: appTrackingResults.icons?.length || 0,
        events: appTrackingResults.events?.length || 0
      },
      logResults: {
        trackers: logTrackingResults.length,
        totalEvents: logTrackingResults.reduce((sum, result) => sum + result.count, 0)
      }
    });

    // Create GIF and snapshot
    await Promise.all([
      createGif(outputPath, gifPath),
      createSnapshot(outputPath, snapshotPath, 0)
    ]);

    const result = {
      outputPath,
      gifPath,
      snapshotPath,
      duration: Date.now() - recordingStartTime,
      fileSize: fs.statSync(outputPath).size,
      clientStartDate: recordingStartTime, // Include the recording start timestamp
      apps: appTrackingResults.apps, // Include tracked applications
      icons: appTrackingResults.icons, // Include application icons metadata
      logs: logTrackingResults // Include log tracking results
    };

    currentRecording = null;
    recordingStartTime = null;
    currentTempFile = null;
    
    // Clean up temp file info
    try {
      if (fs.existsSync(TEMP_FILE_INFO_PATH)) {
        fs.unlinkSync(TEMP_FILE_INFO_PATH);
      }
    } catch (error) {
      logger.warn('Failed to clean up temp file info', { error });
    }
    
    // Stop application tracking on error
    applicationTracker.stop();
    return result;
  } catch (error) {
    currentRecording = null;
    recordingStartTime = null;
    currentTempFile = null;
    
    // Clean up temp file info on error
    try {
      if (fs.existsSync(TEMP_FILE_INFO_PATH)) {
        fs.unlinkSync(TEMP_FILE_INFO_PATH);
      }
    } catch (cleanupError) {
      logger.warn('Failed to clean up temp file info on error', { cleanupError });
    }
    
    // Stop application tracking on error
    applicationTracker.stop();
    throw error;
  }
}

/**
 * Get current recording status
 */
export function getRecordingStatus() {
  if (!currentRecording) {
    return { isRecording: false };
  }

  return {
    isRecording: true,
    duration: recordingStartTime ? Date.now() - recordingStartTime : 0,
    outputPath
  };
}
