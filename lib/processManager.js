import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { logger } from './logger.js';

const PROCESS_DIR = path.join(process.cwd(), '.dashcam');
const PID_FILE = path.join(PROCESS_DIR, 'recording.pid');
const STATUS_FILE = path.join(PROCESS_DIR, 'status.json');

// Ensure process directory exists
if (!fs.existsSync(PROCESS_DIR)) {
  fs.mkdirSync(PROCESS_DIR, { recursive: true });
}

class ProcessManager {
  constructor() {
    this.isBackgroundMode = false;
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
    } catch (error) {
      logger.error('Failed to cleanup process files', { error });
    }
  }

  async stopActiveRecording() {
    const pid = this.readPid();
    if (pid && this.isProcessRunning(pid)) {
      try {
        // Import and call the stop recording function directly
        const { stopRecording } = await import('./recorder.js');
        
        logger.info('Stopping active recording directly');
        
        const result = await stopRecording();
        
        logger.info('Recording stopped successfully', { 
          outputPath: result.outputPath,
          duration: result.duration 
        });
        
        // Cleanup process files
        this.cleanup();
        
        return result;
      } catch (error) {
        logger.error('Failed to stop recording', { error });
        this.cleanup();
        throw error;
      }
    }
    return false;
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
        startTime: Date.now(),
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
    if (this.isBackgroundMode) {
      // In background mode, handle cleanup
      this.cleanup();
    }
    process.exit(0);
  }
}

const processManager = new ProcessManager();

// Handle graceful shutdown
process.on('SIGTERM', () => processManager.gracefulExit());
process.on('SIGINT', () => processManager.gracefulExit());

export { processManager };
