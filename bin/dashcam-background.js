#!/usr/bin/env node
/**
 * Background recording process for dashcam CLI
 * This script runs detached from the parent process to handle long-running recordings
 */

import { startRecording, stopRecording } from '../lib/recorder.js';
import { upload } from '../lib/uploader.js';
import { logger, setVerbose } from '../lib/logger.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

// Use user home directory for cross-session communication
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'upload-result.json');

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

// Write upload result file
function writeUploadResult(result) {
  try {
    logger.info('Writing upload result to file', { path: RESULT_FILE, shareLink: result.shareLink });
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
      ...result,
      timestamp: Date.now()
    }, null, 2));
    logger.info('Successfully wrote upload result to file');
  } catch (error) {
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

    // Set up signal handlers for graceful shutdown
    const handleShutdown = async (signal) => {
      if (isShuttingDown) {
        logger.info('Shutdown already in progress...');
        return;
      }
      isShuttingDown = true;
      
      logger.info(`Received ${signal}, stopping background recording...`);
      
      try {
        // Stop the recording
        const stopResult = await stopRecording();
        
        if (stopResult) {
          logger.info('Recording stopped successfully', { 
            outputPath: stopResult.outputPath,
            duration: stopResult.duration 
          });
          
          // Upload the recording
          logger.info('Starting upload...');
          const uploadResult = await upload(stopResult.outputPath, {
            title: options.title || 'Dashcam Recording',
            description: options.description || 'Recorded with Dashcam CLI',
            project: options.project || options.k,
            duration: stopResult.duration,
            clientStartDate: stopResult.clientStartDate,
            apps: stopResult.apps,
            logs: stopResult.logs,
            gifPath: stopResult.gifPath,
            snapshotPath: stopResult.snapshotPath
          });
          
          logger.info('Upload complete', { shareLink: uploadResult.shareLink });
          
          // Write upload result for stop command to read
          writeUploadResult({
            shareLink: uploadResult.shareLink,
            replayId: uploadResult.replay?.id
          });
        }
        
        // Update status to indicate recording stopped
        writeStatus({
          isRecording: false,
          completedTime: Date.now(),
          pid: process.pid
        });
        
        logger.info('Background process exiting successfully');
        process.exit(0);
      } catch (error) {
        logger.error('Error during shutdown:', error);
        process.exit(1);
      }
    };
    
    process.on('SIGINT', () => handleShutdown('SIGINT'));
    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    
    // Keep the process alive
    logger.info('Background recording is now running. Waiting for stop signal...');
    await new Promise(() => {}); // Wait indefinitely for signals
    
  } catch (error) {
    logger.error('Background recording failed:', error);
    
    // Update status to indicate failure
    writeStatus({
      isRecording: false,
      error: error.message,
      pid: process.pid
    });
    
    process.exit(1);
  }
}

// Run the background recording
runBackgroundRecording().catch(error => {
  logger.error('Fatal error in background process:', error);
  process.exit(1);
});
