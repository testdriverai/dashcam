import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use a fixed directory in the user's home directory for cross-process communication
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const PID_FILE = path.join(PROCESS_DIR, 'recording.pid');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'upload-result.json');

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
      return JSON.parse(data);
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
        logger.info('Verified upload result file exists');
      } else {
        logger.error('Upload result file does not exist after write!');
      }
    } catch (error) {
      logger.error('Failed to write upload result file', { error });
    }
  }

  readUploadResult() {
    try {
      if (!fs.existsSync(RESULT_FILE)) return null;
      const data = fs.readFileSync(RESULT_FILE, 'utf8');
      return JSON.parse(data);
    } catch (error) {
      logger.error('Failed to read upload result file', { error });
      return null;
    }
  }

  writePid(pid = process.pid) {
    try {
      fs.writeFileSync(PID_FILE, pid.toString());
    } catch (error) {
      logger.error('Failed to write PID file', { error });
    }
  }

  readPid() {
    try {
      if (!fs.existsSync(PID_FILE)) return null;
      const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim());
      return isNaN(pid) ? null : pid;
    } catch (error) {
      return null;
    }
  }

  isProcessRunning(pid) {
    if (!pid) return false;
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      return true;
    } catch (error) {
      return false;
    }
  }

  isRecordingActive() {
    const pid = this.readPid();
    const status = this.readStatus();
    
    if (!pid || !this.isProcessRunning(pid)) {
      // Clean up but preserve upload result in case the background process just finished uploading
      this.cleanup({ preserveResult: true });
      return false;
    }
    
    return status && status.isRecording;
  }

  getActiveStatus() {
    if (!this.isRecordingActive()) return null;
    return this.readStatus();
  }

  cleanup(options = {}) {
    const { preserveResult = false } = options;
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      if (fs.existsSync(STATUS_FILE)) fs.unlinkSync(STATUS_FILE);
      if (!preserveResult && fs.existsSync(RESULT_FILE)) fs.unlinkSync(RESULT_FILE);
    } catch (error) {
      logger.error('Failed to cleanup process files', { error });
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
      const pid = this.readPid();
      
      if (!status || !status.isRecording) {
        logger.warn('No active recording found');
        return false;
      }
      
      if (!pid || !this.isProcessRunning(pid)) {
        logger.warn('Background process not running');
        this.cleanup({ preserveResult: true });
        return false;
      }
      
      logger.info('Sending stop signal to background process', { pid });
      
      // Send SIGTERM to the background process to trigger graceful shutdown
      try {
        process.kill(pid, 'SIGTERM');
        logger.info('Sent SIGTERM to background process');
      } catch (error) {
        logger.error('Failed to send signal to background process', { error });
        throw new Error('Failed to stop background recording process');
      }
      
      // Wait for the background process to finish and write results
      logger.debug('Waiting for background process to complete...');
      const maxWaitTime = 30000; // 30 seconds
      const startWait = Date.now();
      
      while (this.isProcessRunning(pid) && (Date.now() - startWait) < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (this.isProcessRunning(pid)) {
        logger.error('Background process did not exit within timeout, forcing kill');
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          logger.error('Failed to force kill background process', { error });
        }
      }
      
      logger.info('Background process stopped');
      
      // Return a minimal result indicating success
      // The upload will be handled by the stop command checking the result file
      return {
        outputPath: status.outputPath,
        duration: Date.now() - status.startTime
      };
      
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

    // Spawn background process
    const backgroundScriptPath = path.join(__dirname, '..', 'bin', 'dashcam-background.js');
    
    logger.info('Starting background recording process', { 
      backgroundScriptPath,
      options 
    });

    // Serialize options to pass to background process
    const optionsJson = JSON.stringify(options);
    
    // Determine node executable path
    const nodePath = process.execPath;
    
    // Create log file for background process output
    const logDir = path.join(PROCESS_DIR, 'logs');
    if (!fs.existsSync(logDir)) {
      fs.mkdirSync(logDir, { recursive: true });
    }
    const logFile = path.join(logDir, `recording-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    
    logger.info('Background process log file', { logFile });
    
    // Spawn the background process with proper detachment
    const child = spawn(
      nodePath,
      [backgroundScriptPath, optionsJson],
      {
        detached: true,    // Detach from parent on Unix-like systems
        stdio: ['ignore', logStream, logStream], // Redirect output to log file
        windowsHide: true, // Hide console window on Windows
        shell: false       // Don't use shell to avoid extra process wrapper
      }
    );
    
    // Unref to allow parent to exit independently
    child.unref();
    
    const pid = child.pid;
    
    logger.info('Background process spawned', { 
      pid,
      logFile,
      detached: true
    });
    
    // Wait for status file to be created by background process
    logger.debug('Waiting for background process to write status file...');
    const maxWaitTime = 10000; // 10 seconds
    const startWait = Date.now();
    let statusCreated = false;
    
    while (!statusCreated && (Date.now() - startWait) < maxWaitTime) {
      const status = this.readStatus();
      if (status && status.isRecording && status.pid === pid) {
        statusCreated = true;
        logger.debug('Status file created by background process', { status });
        break;
      }
      // Wait a bit before checking again
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    if (!statusCreated) {
      logger.error('Background process did not create status file within timeout');
      throw new Error('Failed to start background recording process - status file not created. Check log: ' + logFile);
    }
    
    // Read the status to get output path and start time
    const status = this.readStatus();
    
    logger.info('Recording started successfully in background', { 
      pid,
      outputPath: status.outputPath,
      startTime: status.startTime,
      logFile
    });

    return {
      pid,
      outputPath: status.outputPath,
      startTime: status.startTime,
      logFile
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
