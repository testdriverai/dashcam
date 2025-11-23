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
    '-compression_level', '0', // Fast compression for speed (0 = fastest, 9 = slowest)
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

  const gifFps = 2; // Reduced from 4 to 2 fps for faster generation
  const gifDuration = 5; // Reduced from 10 to 5 seconds for faster generation
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
    
    // Fallback: Fast GIF creation with reduced quality
    const filters = `fps=2,scale=480:-1:flags=fast_bilinear,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none`;
    
    await execa(ffmpegPath, [
      '-i', inputVideoPath,
      '-vf', filters,
      '-loop', '0',
      outputGifPath,
      '-y',
      '-hide_banner'
    ]);
    
    return;
  }
  
  const extractedFramesInterval = videoDuration / gifFrames;

  // Fast GIF creation with reduced quality for speed
  // - Smaller scale (480 vs 640)
  // - Fewer colors (64 vs 128)
  // - Faster scaling algorithm (fast_bilinear vs lanczos)
  // - No dithering for faster processing
  const filters = `fps=1/${extractedFramesInterval},scale=480:-1:flags=fast_bilinear,split[s0][s1];[s0]palettegen=max_colors=64[p];[s1][p]paletteuse=dither=none`;
  
  await execa(ffmpegPath, [
    '-i', inputVideoPath,
    '-vf', filters,
    '-loop', '0',
    outputGifPath,
    '-y',
    '-hide_banner'
  ]);
}
