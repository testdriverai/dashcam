import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

// Use a fixed directory in the user's home directory for cross-process communication
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'upload-result.json');
const STOP_SIGNAL_FILE = path.join(PROCESS_DIR, 'stop-signal.json');

// Ensure process directory exists
if (!fs.existsSync(PROCESS_DIR)) {
  fs.mkdirSync(PROCESS_DIR, { recursive: true });
}

class ProcessManager {
  constructor() {
    this.isBackgroundMode = false;
    this.isStopping = false;
  }

  setBackgroundMode(enabled = true) {
    this.isBackgroundMode = enabled;
  }

  writeStatus(status) {
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

  readStatus() {
    try {
      if (!fs.existsSync(STATUS_FILE)) return null;
      const data = fs.readFileSync(STATUS_FILE, 'utf8');
      const status = JSON.parse(data);
      
      // Check if status is stale (older than 24 hours)
      if (status.timestamp && (Date.now() - status.timestamp) > 24 * 60 * 60 * 1000) {
        logger.warn('Status file is stale, ignoring');
        return null;
      }
      
      return status;
    } catch (error) {
      logger.error('Failed to read status file', { error });
      return null;
    }
  }

  writeUploadResult(result) {
    try {
      logger.info('Writing upload result to file', { path: RESULT_FILE, shareLink: result.shareLink });
      fs.writeFileSync(RESULT_FILE, JSON.stringify({
        ...result,
        timestamp: Date.now()
      }, null, 2));
      logger.info('Successfully wrote upload result to file');
      // Verify it was written
      if (fs.existsSync(RESULT_FILE)) {
        const fileSize = fs.statSync(RESULT_FILE).size;
        logger.info('Verified upload result file exists', { size: fileSize });
      } else {
        logger.error('Upload result file does not exist after write!');
      }
    } catch (error) {
      logger.error('Failed to write upload result file', { error: error.message, stack: error.stack });
    }
  }

  readUploadResult() {
    try {
      logger.debug('Checking for upload result file', { path: RESULT_FILE, exists: fs.existsSync(RESULT_FILE) });
      if (!fs.existsSync(RESULT_FILE)) return null;
      const data = fs.readFileSync(RESULT_FILE, 'utf8');
      const result = JSON.parse(data);
      logger.debug('Successfully read upload result', { shareLink: result.shareLink });
      return result;
    } catch (error) {
      logger.error('Failed to read upload result file', { error: error.message, stack: error.stack });
      return null;
    }
  }

  isRecordingActive() {
    const status = this.readStatus();
    
    // Recording is active if we have a status file with isRecording=true
    // and it's not stale
    if (status && status.isRecording) {
      return true;
    }
    
    // Clean up stale files if recording is not active
    if (!status || !status.isRecording) {
      this.cleanup({ preserveResult: true });
      return false;
    }
    
    return false;
  }

  getActiveStatus() {
    if (!this.isRecordingActive()) return null;
    return this.readStatus();
  }

  cleanup(options = {}) {
    const { preserveResult = false } = options;
    try {
      logger.debug('Cleanup called', { preserveResult, resultFileExists: fs.existsSync(RESULT_FILE) });
      if (fs.existsSync(STATUS_FILE)) {
        fs.unlinkSync(STATUS_FILE);
        logger.debug('Deleted STATUS file');
      }
      if (fs.existsSync(STOP_SIGNAL_FILE)) {
        fs.unlinkSync(STOP_SIGNAL_FILE);
        logger.debug('Deleted STOP_SIGNAL file');
      }
      if (!preserveResult && fs.existsSync(RESULT_FILE)) {
        fs.unlinkSync(RESULT_FILE);
        logger.debug('Deleted RESULT file');
      } else if (preserveResult && fs.existsSync(RESULT_FILE)) {
        logger.debug('Preserved RESULT file');
      }
    } catch (error) {
      logger.error('Failed to cleanup process files', { error: error.message });
    }
  }

  async stopActiveRecording() {
    if (this.isStopping) {
      logger.info('Stop already in progress, ignoring additional stop request');
      return false;
    }
    
    this.isStopping = true;
    
    try {
      const status = this.readStatus();
      
      if (!status || !status.isRecording) {
        logger.warn('No active recording found in status file');
        return false;
      }
      
      logger.info('Signaling background process to stop recording');
      
      // Write stop signal file instead of killing the process
      // The background process polls for this file
      try {
        fs.writeFileSync(STOP_SIGNAL_FILE, JSON.stringify({
          timestamp: Date.now(),
          requestedBy: 'stop-command'
        }));
        logger.info('Stop signal file written successfully');
      } catch (error) {
        logger.error('Failed to write stop signal file', { error: error.message });
        throw new Error('Failed to signal background process to stop');
      }
      
      // Mark recording as stopping in status file
      this.writeStatus({
        isRecording: false,
        stopping: true,
        stoppedAt: Date.now(),
        pid: status.pid
      });
      
      if (status) {
        logger.info('Recording stopped, returning status', { 
          outputPath: status.outputPath,
          duration: Date.now() - status.startTime
        });
        
        const basePath = status.outputPath.substring(0, status.outputPath.lastIndexOf('.'));
        const result = {
          outputPath: status.outputPath,
          gifPath: `${basePath}.gif`,
          snapshotPath: `${basePath}.png`,
          duration: Date.now() - status.startTime,
          clientStartDate: status.startTime,
          apps: [],
          logs: []
        };
        
        // Don't cleanup here - the background process needs to read the stop signal file
        // Cleanup will happen after we get the recording result
        return result;
      } else {
        throw new Error('No status information available for active recording');
      }
    } catch (error) {
      logger.error('Failed to stop recording', { error });
      throw error;
    } finally {
      this.isStopping = false;
    }
  }

  async startRecording(options) {
    // Check if recording is already active
    if (this.isRecordingActive()) {
      throw new Error('Recording already in progress');
    }

    logger.info('Starting recording in detached background process');
    
    // Get the path to the background script
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const backgroundScript = path.join(__dirname, '..', 'bin', 'dashcam-background.js');
    
    // Spawn a detached background process
    const child = spawn(process.execPath, [backgroundScript, JSON.stringify(options)], {
      detached: true,
      stdio: 'ignore'
    });
    
    // Unref so the parent process can exit
    child.unref();
    
    const pid = child.pid;

    logger.info('Background process spawned successfully', { 
      pid,
      backgroundScript
    });
    
    // Wait a moment for the background process to write its status
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    // Read the status to get output path and start time
    const status = this.readStatus();
    
    if (!status) {
      logger.error('Background process failed to write status');
      throw new Error('Background process failed to write status');
    }

    logger.info('Recording started successfully', { 
      pid: status.pid,
      outputPath: status.outputPath,
      startTime: status.startTime
    });

    return {
      pid: status.pid,
      outputPath: status.outputPath,
      startTime: status.startTime
    };
  }

  async gracefulExit() {
    logger.info('Graceful exit requested');
    
    // If we're currently recording, stop it properly
    if (this.isRecordingActive()) {
      try {
        logger.info('Stopping active recording before exit');
        await this.stopActiveRecording();
        logger.info('Recording stopped successfully during graceful exit');
      } catch (error) {
        logger.error('Failed to stop recording during graceful exit', { error });
        this.cleanup(); // Fallback cleanup
      }
    } else {
      // Just cleanup if no recording is active
      this.cleanup();
    }
    
    process.exit(0);
  }
}

const processManager = new ProcessManager();

export { processManager };
