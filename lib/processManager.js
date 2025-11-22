import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import { logger } from './logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use user home directory for cross-session communication
const PROCESS_DIR = path.join(os.homedir(), '.dashcam-cli');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');
const RESULT_FILE = path.join(PROCESS_DIR, 'upload-result.json');

console.log('[INIT] Process Manager initialized');
console.log('[INIT] Process directory:', PROCESS_DIR);
console.log('[INIT] Status file:', STATUS_FILE);
console.log('[INIT] Platform:', process.platform);

// Ensure process directory exists
if (!fs.existsSync(PROCESS_DIR)) {
  console.log('[INIT] Creating process directory:', PROCESS_DIR);
  fs.mkdirSync(PROCESS_DIR, { recursive: true });
} else {
  console.log('[INIT] Process directory exists:', PROCESS_DIR);
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
      const statusData = {
        ...status,
        timestamp: Date.now(),
        pid: process.pid
      };
      
      logger.debug('Writing status file', {
        statusFile: STATUS_FILE,
        pid: statusData.pid,
        isRecording: statusData.isRecording,
        platform: process.platform
      });
      
      fs.writeFileSync(STATUS_FILE, JSON.stringify(statusData, null, 2));
      
      // Verify it was written
      if (fs.existsSync(STATUS_FILE)) {
        logger.debug('Status file written successfully');
      } else {
        logger.error('Status file does not exist after write!');
      }
    } catch (error) {
      logger.error('Failed to write status file', { 
        error: error.message,
        stack: error.stack,
        statusFile: STATUS_FILE
      });
    }
  }

  readStatus() {
    try {
      logger.debug('Reading status file', { 
        statusFile: STATUS_FILE,
        exists: fs.existsSync(STATUS_FILE)
      });
      
      if (!fs.existsSync(STATUS_FILE)) {
        logger.debug('Status file does not exist');
        return null;
      }
      
      const data = fs.readFileSync(STATUS_FILE, 'utf8');
      const status = JSON.parse(data);
      
      logger.debug('Status file read successfully', {
        pid: status.pid,
        isRecording: status.isRecording,
        timestamp: status.timestamp,
        startTime: status.startTime,
        outputPath: status.outputPath
      });
      
      return status;
    } catch (error) {
      logger.error('Failed to read status file', { 
        error: error.message,
        stack: error.stack,
        statusFile: STATUS_FILE
      });
      return null;
    }
  }

  markStatusCompleted(completionData = {}) {
    try {
      const status = this.readStatus();
      if (status) {
        fs.writeFileSync(STATUS_FILE, JSON.stringify({
          ...status,
          isRecording: false,
          completedAt: Date.now(),
          ...completionData
        }, null, 2));
      }
    } catch (error) {
      logger.error('Failed to mark status as completed', { error });
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

  isProcessRunning(pid) {
    if (!pid) {
      logger.debug('isProcessRunning: no PID provided');
      return false;
    }
    
    try {
      process.kill(pid, 0); // Signal 0 just checks if process exists
      logger.debug('Process is running', { pid });
      return true;
    } catch (error) {
      logger.debug('Process is not running', { 
        pid, 
        error: error.code,
        platform: process.platform
      });
      return false;
    }
  }

  isRecordingActive() {
    console.log('[DEBUG] Checking if recording is active...');
    console.log('[DEBUG] Status file path:', STATUS_FILE);
    console.log('[DEBUG] Status file exists:', fs.existsSync(STATUS_FILE));
    
    logger.debug('Checking if recording is active...', {
      statusFile: STATUS_FILE,
      processDir: PROCESS_DIR,
      platform: process.platform
    });
    
    const status = this.readStatus();
    
    console.log('[DEBUG] Status read result:', status);
    
    logger.debug('Status check result', {
      hasStatus: !!status,
      hasPid: !!(status && status.pid),
      isRecording: status ? status.isRecording : null,
      statusPid: status ? status.pid : null,
      currentPid: process.pid
    });
    
    if (!status) {
      console.log('[DEBUG] No status found - recording not active');
      logger.debug('No status found - recording not active');
      return false;
    }
    
    if (!status.pid) {
      console.log('[DEBUG] Status has no PID - marking as completed');
      logger.debug('Status has no PID - marking as completed');
      this.markStatusCompleted({ reason: 'no_pid_in_status' });
      return false;
    }
    
    const processRunning = this.isProcessRunning(status.pid);
    console.log('[DEBUG] Process running check:', { pid: status.pid, isRunning: processRunning });
    logger.debug('Process running check', {
      pid: status.pid,
      isRunning: processRunning
    });
    
    if (!processRunning) {
      console.log('[DEBUG] Process not running - marking as completed:', { pid: status.pid });
      logger.debug('Process not running - marking as completed', {
        pid: status.pid,
        wasRecording: status.isRecording
      });
      
      // Mark as completed if process is dead but status exists
      if (status.isRecording) {
        this.markStatusCompleted({ reason: 'process_not_running' });
      }
      return false;
    }
    
    console.log('[DEBUG] Recording active status:', { isRecording: status.isRecording, pid: status.pid });
    logger.debug('Recording active status', {
      isRecording: status.isRecording,
      pid: status.pid
    });
    
    return status.isRecording;
  }

  getActiveStatus() {
    if (!this.isRecordingActive()) return null;
    return this.readStatus();
  }

  cleanup(options = {}) {
    const { preserveResult = false } = options;
    try {
      // Only delete result file, keep status file for history
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
      
      if (!status || !status.isRecording) {
        logger.warn('No active recording found');
        return false;
      }
      
      const pid = status.pid;
      if (!pid || !this.isProcessRunning(pid)) {
        logger.warn('Background process not running');
        this.markStatusCompleted({ reason: 'process_already_stopped' });
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
      
      // Mark status as completed
      this.markStatusCompleted({ 
        reason: 'stopped_by_user',
        duration: Date.now() - status.startTime
      });
      
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
    
    // Wait for the log stream to open before using it in spawn
    await new Promise((resolve, reject) => {
      logStream.once('open', resolve);
      logStream.once('error', reject);
    });
    
    logger.info('Background process log file', { logFile });
    console.log('[ProcessManager] Log file created:', logFile);
    console.log('[ProcessManager] Node path:', nodePath);
    console.log('[ProcessManager] Background script:', backgroundScriptPath);
    console.log('[ProcessManager] Options:', optionsJson);
    
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
    
    // Handle spawn errors
    child.on('error', (error) => {
      console.error('[ProcessManager] Spawn error:', error);
      logger.error('Failed to spawn background process', { error: error.message, stack: error.stack });
    });
    
    child.on('exit', (code, signal) => {
      console.log('[ProcessManager] Background process exited', { code, signal, pid: child.pid });
      logger.info('Background process exited', { code, signal, pid: child.pid });
    });
    
    // Unref to allow parent to exit independently
    child.unref();
    
    const pid = child.pid;
    
    console.log('[ProcessManager] Background process spawned with PID:', pid);
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
        this.markStatusCompleted({ reason: 'graceful_exit_error' });
      }
    }
    
    process.exit(0);
  }
}

const processManager = new ProcessManager();

export { processManager };
