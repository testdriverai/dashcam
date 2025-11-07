import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { logger } from './logger.js';

/**
 * Get the path to the ffmpeg binary
 * @returns {Promise<string>} Path to ffmpeg
 */
export async function getFfmpegPath() {
  logger.debug('Getting ffmpeg path from ffmpeg-static', { path: ffmpegStatic });
  return ffmpegStatic;
}

/**
 * Get the path to the ffprobe binary
 * @returns {Promise<string>} Path to ffprobe
 */
export async function getFfprobePath() {
  logger.debug('Getting ffprobe path from ffprobe-static', { path: ffprobeStatic.path });
  return ffprobeStatic.path;
}
