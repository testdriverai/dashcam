#!/usr/bin/env node

/**
 * Test script for analyzing short recording issues
 * 
 * This tests whether very short recordings produce valid multi-frame videos
 * with properly finalized WebM container metadata.
 * 
 * Known issue: If ffmpeg/VP9 encoder is killed too quickly, the WebM container
 * metadata (especially duration) may be incomplete, causing playback issues.
 * 
 * Usage:
 *   node test-short-recording.js                    # Run recording tests
 *   node test-short-recording.js analyze <file>     # Analyze existing video
 *   node test-short-recording.js fix <input> <output> # Fix broken video container
 * 
 * Platform notes:
 *   - macOS: Uses AVFoundation for screen capture
 *   - Linux: Uses X11grab for screen capture
 *   - Windows: Uses gdigrab for screen capture
 */

import { startRecording, stopRecording, fixVideoContainer } from './lib/recorder.js';
import { execa } from 'execa';
import { getFfprobePath } from './lib/binaries.js';
import fs from 'fs';
import path from 'path';
import os from 'os';

async function analyzeVideo(videoPath) {
  const ffprobePath = await getFfprobePath();
  
  console.log(`\n📊 Analyzing video: ${videoPath}`);
  console.log('─'.repeat(80));
  
  // Check if file exists
  if (!fs.existsSync(videoPath)) {
    console.error(`❌ Video file does not exist: ${videoPath}`);
    return null;
  }
  
  const stats = fs.statSync(videoPath);
  console.log(`📁 File size: ${(stats.size / 1024).toFixed(2)} KB`);
  
  try {
    // Get basic format info
    const formatResult = await execa(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration,size,bit_rate',
      '-of', 'json',
      videoPath
    ]);
    
    const formatData = JSON.parse(formatResult.stdout);
    console.log(`⏱️  Duration: ${formatData.format.duration || 'unknown'}s`);
    console.log(`📊 Bit rate: ${formatData.format.bit_rate || 'unknown'} bits/s`);
    
    // Get stream info
    const streamResult = await execa(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,width,height,r_frame_rate,duration',
      '-of', 'json',
      videoPath
    ]);
    
    const streamData = JSON.parse(streamResult.stdout);
    const videoStream = streamData.streams.find(s => s.codec_name);
    
    if (videoStream) {
      console.log(`🎥 Codec: ${videoStream.codec_name}`);
      console.log(`📐 Resolution: ${videoStream.width}x${videoStream.height}`);
      console.log(`🎞️  Frame rate: ${videoStream.r_frame_rate}`);
    }
    
    // Count actual frames
    const frameResult = await execa(ffprobePath, [
      '-v', 'error',
      '-count_frames',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=nb_read_frames',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      videoPath
    ], { reject: false });
    
    const frameCount = parseInt(frameResult.stdout.trim());
    console.log(`🖼️  Frame count: ${frameCount || 'unknown'}`);
    
    if (frameResult.stderr) {
      console.log(`⚠️  FFprobe warnings: ${frameResult.stderr.trim()}`);
    }
    
    // Check if duration is available in container
    const hasDuration = formatData.format.duration && !isNaN(parseFloat(formatData.format.duration));
    
    // Determine if this is a single-frame video issue
    const isSingleFrame = frameCount === 1;
    const hasEncodingIssues = frameResult.stderr.includes('File ended prematurely');
    const hasMissingMetadata = !hasDuration;
    
    console.log('\n📋 Analysis Result:');
    console.log(`   Single frame: ${isSingleFrame ? '❌ YES (BUG!)' : '✅ NO'}`);
    console.log(`   Encoding issues: ${hasEncodingIssues ? '⚠️  YES' : '✅ NO'}`);
    console.log(`   Missing metadata: ${hasMissingMetadata ? '⚠️  YES (container incomplete)' : '✅ NO'}`);
    console.log(`   Platform: ${os.platform()}`);
    
    return {
      exists: true,
      size: stats.size,
      duration: parseFloat(formatData.format.duration),
      frameCount,
      codec: videoStream?.codec_name,
      resolution: videoStream ? `${videoStream.width}x${videoStream.height}` : 'unknown',
      isSingleFrame,
      hasEncodingIssues,
      hasMissingMetadata,
      platform: os.platform()
    };
    
  } catch (error) {
    console.error(`❌ Error analyzing video: ${error.message}`);
    return null;
  }
}

async function testShortRecording(duration = 3000) {
  console.log(`\n🎬 Testing ${duration}ms recording...`);
  console.log('═'.repeat(80));
  
  try {
    // Start recording
    console.log('▶️  Starting recording...');
    const { outputPath, startTime } = await startRecording({ 
      fps: 30,
      includeAudio: false 
    });
    
    console.log(`✅ Recording started at: ${outputPath}`);
    
    // Wait for specified duration
    console.log(`⏳ Recording for ${duration}ms...`);
    await new Promise(resolve => setTimeout(resolve, duration));
    
    // Stop recording
    console.log('⏹️  Stopping recording...');
    const result = await stopRecording();
    
    console.log(`✅ Recording stopped`);
    console.log(`   Duration: ${result.duration}ms`);
    console.log(`   File: ${result.outputPath}`);
    
    // Analyze the output
    await analyzeVideo(result.outputPath);
    
    return result;
    
  } catch (error) {
    console.error(`❌ Test failed: ${error.message}`);
    console.error(error.stack);
    throw error;
  }
}

async function testExistingVideo(videoPath) {
  console.log('\n🔍 Testing existing video...');
  console.log('═'.repeat(80));
  
  return await analyzeVideo(videoPath);
}

// Main test runner
async function main() {
  const args = process.argv.slice(2);
  
  console.log('\n🧪 Short Recording Test Suite');
  console.log('═'.repeat(80));
  console.log(`Platform: ${os.platform()}`);
  console.log(`Architecture: ${os.arch()}`);
  console.log(`Node version: ${process.version}`);
  
  if (args[0] === 'analyze' && args[1]) {
    // Analyze existing video
    const videoPath = path.resolve(args[1]);
    const result = await testExistingVideo(videoPath);
    
    if (result?.isSingleFrame) {
      console.log('\n❌ SINGLE-FRAME VIDEO DETECTED!');
      process.exit(1);
    } else if (result?.hasMissingMetadata) {
      console.log('\n⚠️  WARNING: Video container metadata is incomplete!');
      console.log('   This can cause playback issues in some players.');
      console.log('   The video has frames but duration is not in the container.');
      console.log('\n💡 Try fixing it with:');
      console.log(`   node test-short-recording.js fix ${args[1]} ${args[1].replace(/\.(webm|mp4)$/, '-fixed.$1')}`);
      process.exit(1);
    }
  } else if (args[0] === 'fix' && args[1] && args[2]) {
    // Fix existing broken video
    const inputPath = path.resolve(args[1]);
    const outputPath = path.resolve(args[2]);
    
    console.log('\n🔧 Fixing video container...');
    console.log('═'.repeat(80));
    console.log(`Input:  ${inputPath}`);
    console.log(`Output: ${outputPath}`);
    
    if (!fs.existsSync(inputPath)) {
      console.error(`❌ Input file does not exist: ${inputPath}`);
      process.exit(1);
    }
    
    // Analyze before
    console.log('\n📊 BEFORE:');
    const beforeResult = await analyzeVideo(inputPath);
    
    // Fix the video
    const fixSuccess = await fixVideoContainer(inputPath, outputPath);
    
    if (!fixSuccess) {
      console.error('\n❌ Failed to fix video!');
      process.exit(1);
    }
    
    // Analyze after
    console.log('\n📊 AFTER:');
    const afterResult = await analyzeVideo(outputPath);
    
    console.log('\n✅ Video fixed successfully!');
    console.log(`   Before: ${beforeResult?.hasMissingMetadata ? 'Missing metadata ⚠️' : 'Has metadata ✅'}`);
    console.log(`   After:  ${afterResult?.hasMissingMetadata ? 'Missing metadata ⚠️' : 'Has metadata ✅'}`);
    
    if (afterResult?.hasMissingMetadata) {
      console.log('\n⚠️  Warning: Metadata still missing after fix. The source file may be corrupted.');
      process.exit(1);
    }
  } else {
    // Run recording tests with different durations
    const testDurations = [1000, 2000, 3000, 5000];
    const results = [];
    
    for (const duration of testDurations) {
      try {
        const result = await testShortRecording(duration);
        results.push({ duration, success: true, result });
        
        // Clean up
        try {
          fs.unlinkSync(result.outputPath);
          if (result.gifPath && fs.existsSync(result.gifPath)) {
            fs.unlinkSync(result.gifPath);
          }
          if (result.snapshotPath && fs.existsSync(result.snapshotPath)) {
            fs.unlinkSync(result.snapshotPath);
          }
        } catch (cleanupError) {
          console.warn(`⚠️  Cleanup warning: ${cleanupError.message}`);
        }
      } catch (error) {
        results.push({ duration, success: false, error: error.message });
      }
      
      // Wait between tests
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Summary
    console.log('\n\n📊 TEST SUMMARY');
    console.log('═'.repeat(80));
    
    for (const result of results) {
      const status = result.success ? '✅' : '❌';
      console.log(`${status} ${result.duration}ms recording: ${result.success ? 'PASSED' : result.error}`);
    }
    
    const allPassed = results.every(r => r.success);
    if (!allPassed) {
      console.log('\n❌ Some tests failed!');
      process.exit(1);
    } else {
      console.log('\n✅ All tests passed!');
    }
  }
}

main().catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});
