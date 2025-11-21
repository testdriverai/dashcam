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

// Get process directory for status files
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'upload-result.json');

// Parse options from command line argument
const optionsJson = process.argv[2];
if (!optionsJson) {
  console.error('No options provided to background process');
  process.exit(1);
}

const options = JSON.parse(optionsJson);

// Enable verbose logging in background
setVerbose(true);

logger.info('Background recording process started', { 
  pid: process.pid,
  options 
});

// Write status file
function writeStatus(status) {
  try {
    fs.writeFileSync(STATUS_FILE, JSON.stringify({
      ...status,
      timestamp: Date.now(),
      pid: process.pid
    }, null, 2));
  } catch (error) {
    logger.error('Failed to write status file', { error });
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
    // Verify the file was written
    if (fs.existsSync(RESULT_FILE)) {
      const content = fs.readFileSync(RESULT_FILE, 'utf8');
      logger.info('Verified upload result file exists and contains', { content: content.substring(0, 100) });
    }
  } catch (error) {
    logger.error('Failed to write upload result file', { error: error.message, stack: error.stack });
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

    recordingResult = await startRecording(recordingOptions);

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

    // Set up signal handlers for graceful shutdown
    const handleShutdown = async (signal) => {
      if (isShuttingDown) {
        logger.info('Shutdown already in progress...');
        return;
      }
      isShuttingDown = true;
      
      logger.info(`Received ${signal} signal, stopping background recording...`, { pid: process.pid });
      
      try {
        // Stop the recording
        logger.info('Calling stopRecording...');
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
          logger.info('About to write upload result...');
          writeUploadResult({
            shareLink: uploadResult.shareLink,
            replayId: uploadResult.replay?.id
          });
          logger.info('Upload result written successfully');
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
        logger.error('Error during shutdown:', { error: error.message, stack: error.stack });
        process.exit(1);
      }
    };
    
    process.on('SIGINT', () => {
      logger.info('SIGINT handler triggered');
      handleShutdown('SIGINT');
    });
    process.on('SIGTERM', () => {
      logger.info('SIGTERM handler triggered');
      handleShutdown('SIGTERM');
    });
    
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
