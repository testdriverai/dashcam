import { execa } from 'execa';
import { logger } from './logger.js';
import { getFfmpegPath, getFfprobePath } from './binaries.js';
import os from 'os';
import path from 'path';
import fs from 'fs';

/**
 * Create a snapshot (PNG) from a video at a specific timestamp
 */
export async function createSnapshot(inputVideoPath, outputSnapshotPath, snapshotTimeSeconds = 0) {
  logger.debug('Creating snapshot', { inputVideoPath, outputSnapshotPath, snapshotTimeSeconds });
  
  const ffmpegPath = await getFfmpegPath();
  
  const command = [
    '-ss', snapshotTimeSeconds,
    '-i', inputVideoPath,
    '-frames:v', '1',
    '-vf', 'scale=640:-1:force_original_aspect_ratio=decrease:eval=frame',
    '-pred', 'mixed',
    '-compression_level', '100',
    outputSnapshotPath,
    '-y',
    '-hide_banner'
  ];

  await execa(ffmpegPath, command);
}

/**
 * Create an animated GIF from a video
 */
export async function createGif(inputVideoPath, outputGifPath) {
  logger.debug('Creating GIF', { inputVideoPath, outputGifPath });

  const ffmpegPath = await getFfmpegPath();
  const ffprobePath = await getFfprobePath();

  // Function to check if video is ready
  const isVideoReady = async () => {
    try {
      // Check if file exists and is not empty
      if (!fs.existsSync(inputVideoPath) || fs.statSync(inputVideoPath).size === 0) {
        return false;
      }

      // Try to read video info with ffprobe
      const { exitCode } = await execa(ffprobePath, [
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'stream=codec_type',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        inputVideoPath
      ], { reject: false });

      return exitCode === 0;
    } catch (error) {
      return false;
    }
  };

  // Wait for up to 5 seconds for the video to be ready
  for (let i = 0; i < 10; i++) {
    if (await isVideoReady()) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Final check
  if (!await isVideoReady()) {
    throw new Error('Video file is not ready or is corrupted');
  }

  const gifFps = 4;
  const gifDuration = 10;
  const gifFrames = Math.ceil(gifDuration * gifFps);

  // Get video duration in seconds
  const { stdout } = await execa(ffprobePath, [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    inputVideoPath
  ]);

  const videoDuration = parseFloat(stdout);
  const id = (Math.random() + 1).toString(36).substring(7);
  
  // Handle NaN or invalid duration
  if (!videoDuration || isNaN(videoDuration) || videoDuration <= 0) {
    logger.warn('Video duration unavailable or invalid, using default sampling for GIF', {
      duration: videoDuration,
      stdout
    });
    
    // Fallback: Just sample the video at a fixed rate (e.g., 1 frame every 3 seconds)
    const framesPath = path.join(os.tmpdir(), `frames_${id}_%04d.png`);
    await execa(ffmpegPath, [
      '-i', inputVideoPath,
      '-vf', `fps=1/3`, // Sample 1 frame every 3 seconds
      framesPath
    ]);

    // Create GIF from frames
    await execa(ffmpegPath, [
      '-framerate', `${gifFps}`,
      '-i', framesPath,
      '-loop', '0',
      outputGifPath,
      '-y',
      '-hide_banner'
    ]);

    // Clean up temporary frame files
    const framesToDelete = fs.readdirSync(os.tmpdir())
      .filter(file => file.startsWith(`frames_${id}_`) && file.endsWith('.png'))
      .map(file => path.join(os.tmpdir(), file));
    
    for (const frame of framesToDelete) {
      fs.unlinkSync(frame);
    }
    
    return;
  }
  
  const extractedFramesInterval = videoDuration / gifFrames;

  // Extract frames
  const framesPath = path.join(os.tmpdir(), `frames_${id}_%04d.png`);
  await execa(ffmpegPath, [
    '-i', inputVideoPath,
    '-vf', `fps=1/${extractedFramesInterval}`,
    framesPath
  ]);

  // Create GIF from frames
  await execa(ffmpegPath, [
    '-framerate', `${gifFps}`,
    '-i', framesPath,
    '-loop', '0',
    outputGifPath,
    '-y',
    '-hide_banner'
  ]);

  // Clean up temporary frame files
  const framesToDelete = fs.readdirSync(os.tmpdir())
    .filter(file => file.startsWith(`frames_${id}_`) && file.endsWith('.png'))
    .map(file => path.join(os.tmpdir(), file));
  
  for (const frame of framesToDelete) {
    fs.unlinkSync(frame);
  }
}
