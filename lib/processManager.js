import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { logger } from './logger.js';

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
      fs.writeFileSync(RESULT_FILE, JSON.stringify({
        ...result,
        timestamp: Date.now()
      }, null, 2));
      logger.debug('Wrote upload result to file', { shareLink: result.shareLink });
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
      this.cleanup();
      return false;
    }
    
    return status && status.isRecording;
  }

  getActiveStatus() {
    if (!this.isRecordingActive()) return null;
    return this.readStatus();
  }

  cleanup() {
    try {
      if (fs.existsSync(PID_FILE)) fs.unlinkSync(PID_FILE);
      if (fs.existsSync(STATUS_FILE)) fs.unlinkSync(STATUS_FILE);
      if (fs.existsSync(RESULT_FILE)) fs.unlinkSync(RESULT_FILE);
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
      const pid = this.readPid();
      const status = this.readStatus();
      
      if (!pid || !this.isProcessRunning(pid)) {
        logger.warn('No active recording process found');
        return false;
      }
      
      // Recording is active, send SIGINT to trigger graceful shutdown
      logger.info('Stopping active recording process', { pid });
      process.kill(pid, 'SIGINT');
      
      // Wait for the process to actually finish
      const maxWaitTime = 30000; // 30 seconds max
      const startWait = Date.now();
      
      while (this.isProcessRunning(pid) && (Date.now() - startWait) < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
      
      if (this.isProcessRunning(pid)) {
        logger.warn('Process did not stop within timeout, forcing termination');
        process.kill(pid, 'SIGKILL');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      
      // Call the actual recorder's stopRecording function to get complete results
      if (status) {
        try {
          const { stopRecording } = await import('./recorder.js');
          const result = await stopRecording();
          
          logger.info('Recording stopped successfully via recorder', { 
            outputPath: result.outputPath,
            duration: result.duration,
            hasLogs: result.logs?.length > 0,
            hasApps: result.apps?.length > 0
          });
          
          // Cleanup process files
          this.cleanup();
          
          return result;
        } catch (recorderError) {
          logger.warn('Failed to stop via recorder, falling back to basic result', { error: recorderError.message });
          
          // Fallback to basic result if recorder fails
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
          
          this.cleanup();
          return result;
        }
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

    try {
      // Import and call the recording function directly
      const { startRecording } = await import('./recorder.js');
      
      const recordingOptions = {
        fps: parseInt(options.fps) || 10,
        includeAudio: options.audio || false,
        customOutputPath: options.output || null
      };

      logger.info('Starting recording directly', { options: recordingOptions });

      const result = await startRecording(recordingOptions);

      // Write status to track the recording
      this.writePid(process.pid);
      this.writeStatus({
        isRecording: true,
        startTime: result.startTime, // Use actual recording start time from recorder
        options,
        pid: process.pid,
        outputPath: result.outputPath
      });

      logger.info('Recording started successfully', { 
        outputPath: result.outputPath,
        startTime: result.startTime 
      });

      return {
        pid: process.pid,
        outputPath: result.outputPath,
        startTime: result.startTime
      };
    } catch (error) {
      logger.error('Failed to start recording', { error });
      throw error;
    }
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
