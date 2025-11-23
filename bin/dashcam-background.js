#!/usr/bin/env node
/**
 * Background recording process for dashcam CLI
 * This script runs detached from the parent process to handle long-running recordings
 */

import { startRecording } from '../lib/recorder.js';
import { logger, setVerbose } from '../lib/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use user home directory for cross-session communication
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'recording-result.json');

console.log('[Background INIT] Process directory:', PROCESS_DIR);
console.log('[Background INIT] Status file:', STATUS_FILE);

// Ensure directory exists
if (!fs.existsSync(PROCESS_DIR)) {
  console.log('[Background INIT] Creating process directory');
  fs.mkdirSync(PROCESS_DIR, { recursive: true });
}

// Parse options from command line argument
const optionsJson = process.argv[2];
if (!optionsJson) {
  console.error('No options provided to background process');
  process.exit(1);
}

const options = JSON.parse(optionsJson);

// Enable verbose logging in background
setVerbose(true);

console.log('[Background] Process started', { 
  pid: process.pid,
  platform: process.platform,
  processDir: PROCESS_DIR,
  statusFile: STATUS_FILE
});

logger.info('Background recording process started', { 
  pid: process.pid,
  options 
});

// Write status file
function writeStatus(status) {
  try {
    const statusData = {
      ...status,
      timestamp: Date.now(),
      pid: process.pid,
      platform: process.platform
    };
    
    console.log('[Background] Writing status file:', {
      statusFile: STATUS_FILE,
      pid: statusData.pid,
      isRecording: statusData.isRecording,
      platform: statusData.platform
    });
    
    fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
    
    // Verify it was written
    if (fs.existsSync(STATUS_FILE)) {
      console.log('[Background] Status file written and verified:', STATUS_FILE);
      
      // Read it back to verify content
      const writtenContent = fs.readFileSync(STATUS_FILE, 'utf8');
      console.log('[Background] Status file content verification:', { 
        contentLength: writtenContent.length,
        parseable: true 
      });
    } else {
      console.error('[Background] Status file does not exist after write!', STATUS_FILE);
      logger.error('Status file does not exist after write!', { statusFile: STATUS_FILE });
    }
  } catch (error) {
    console.error('[Background] Failed to write status file:', error.message);
    logger.error('Failed to write status file in background process', { 
      error: error.message,
      stack: error.stack,
      statusFile: STATUS_FILE
    });
  }
}

// Write recording result file
function writeRecordingResult(result) {
  try {
    console.log('[Background] Writing upload result to file:', RESULT_FILE);
    console.log('[Background] Upload result data:', result);
    logger.info('Writing upload result to file', { path: RESULT_FILE, shareLink: result.shareLink });
    
    const resultData = {
      ...result,
      timestamp: Date.now()
    };
    
    fs.writeFileSync(RESULT_FILE, JSON.stringify(resultData, null, 2));
    console.log('[Background] Successfully wrote upload result to file');
    console.log('[Background] File exists after write:', fs.existsSync(RESULT_FILE));
    logger.info('Successfully wrote upload result to file');
  } catch (error) {
    console.error('[Background] Failed to write upload result file:', error.message);
    logger.error('Failed to write upload result file', { error });
  }
}

// Main recording function
async function runBackgroundRecording() {
  let recordingResult = null;
  let isShuttingDown = false;

  try {
    // Start the recording
    const recordingOptions = {
      fps: parseInt(options.fps) || 10,
      includeAudio: options.audio || false,
      customOutputPath: options.output || null
    };

    logger.info('Starting recording with options', { recordingOptions });
    console.log('[Background] Starting recording with options:', recordingOptions);

    recordingResult = await startRecording(recordingOptions);

    console.log('[Background] Recording started, writing status file...');
    
    // Write status to track the recording
    writeStatus({
      isRecording: true,
      startTime: recordingResult.startTime,
      options,
      pid: process.pid,
      outputPath: recordingResult.outputPath
    });

    logger.info('Recording started successfully', { 
      outputPath: recordingResult.outputPath,
      startTime: recordingResult.startTime 
    });
    
    console.log('[Background] Recording started successfully', {
      outputPath: recordingResult.outputPath,
      startTime: recordingResult.startTime,
      pid: process.pid
    });

    // Set up signal handlers for graceful shutdown BEFORE entering wait loop
    const handleShutdown = async (signal) => {
      if (isShuttingDown) {
        logger.info('Shutdown already in progress...');
        return;
      }
      isShuttingDown = true;
      
      logger.info(`Received ${signal}, cleaning up child processes`);
      console.log('[Background] Received stop signal, cleaning up...');
      
      // Kill any child processes (ffmpeg, etc.)
      try {
        // Get all child processes and kill them
        const { exec } = await import('child_process');
        const platform = process.platform;
        
        if (platform === 'darwin' || platform === 'linux') {
          // On Unix, kill the entire process group
          exec(`pkill -P ${process.pid}`, (error) => {
            if (error && error.code !== 1) { // code 1 means no processes found
              logger.warn('Failed to kill child processes', { error: error.message });
            }
            logger.info('Child processes killed');
          });
        } else if (platform === 'win32') {
          // On Windows, use taskkill
          exec(`taskkill /F /T /PID ${process.pid}`, (error) => {
            if (error) {
              logger.warn('Failed to kill child processes on Windows', { error: error.message });
            }
            logger.info('Child processes killed');
          });
        }
        
        // Give it a moment to clean up
        await new Promise(resolve => setTimeout(resolve, 500));
      } catch (error) {
        logger.error('Error during cleanup', { error: error.message });
      }
      
      logger.info('Background process exiting');
      process.exit(0);
    };
    
    // Register signal handlers
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    
    // Keep the process alive - wait indefinitely for SIGKILL from stop command
    logger.info('Background recording is now running. Waiting for stop signal...');
    console.log('[Background] Waiting for stop signal...');
    
  } catch (error) {
    logger.error('Background recording setup failed:', error);
    console.error('[Background] Recording setup failed:', error.message);
    
    // Update status to indicate failure
    writeStatus({
      isRecording: false,
      error: error.message,
      pid: process.pid
    });
    
    process.exit(1);
  }
  
  // Infinite loop - process will only exit via signal handlers or stop file
  await new Promise(() => {});
}

// Run the background recording
runBackgroundRecording().catch(error => {
  logger.error('Fatal error in background process:', error);
  process.exit(1);
});
