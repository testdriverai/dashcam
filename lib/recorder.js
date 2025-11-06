import { spawn } from 'child_process';
import ffmpeg from 'ffmpeg-static';
import { logger } from './logger.js';
import path from 'path';
import os from 'os';

let currentRecording = null;
let outputPath = null;

export async function startRecording({ fps = 30 } = {}) {
  if (currentRecording) {
    throw new Error('Recording already in progress');
  }

  outputPath = path.join(os.tmpdir(), `recording-${Date.now()}.mp4`);
  
  // FFmpeg command to record screen
  // This is a basic implementation - you might want to add more options
  const args = [
    '-f', 'avfoundation',  // Use avfoundation for macOS (use gdigrab for Windows)
    '-framerate', fps.toString(),
    '-i', '1:none',        // Screen device index (might need adjustment)
    '-c:v', 'libx264',
    '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p',
    outputPath
  ];

  currentRecording = spawn(ffmpeg, args);

  currentRecording.stderr.on('data', (data) => {
    logger.debug(`ffmpeg: ${data}`);
  });

  currentRecording.on('error', (error) => {
    logger.error('FFmpeg error:', error);
    currentRecording = null;
  });

  return new Promise((resolve, reject) => {
    currentRecording.on('spawn', () => {
      resolve(outputPath);
    });
    
    currentRecording.on('error', reject);
  });
}

export async function stopRecording() {
  if (!currentRecording) {
    throw new Error('No recording in progress');
  }

  return new Promise((resolve, reject) => {
    currentRecording.on('exit', (code) => {
      if (code === 0) {
        const recordingPath = outputPath;
        currentRecording = null;
        outputPath = null;
        resolve(recordingPath);
      } else {
        reject(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    // Send SIGTERM to ffmpeg
    currentRecording.kill('SIGTERM');
  });
}
