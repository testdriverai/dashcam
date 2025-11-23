#!/usr/bin/env node

import { PerformanceTracker } from './lib/performanceTracker.js';
import { logger, setVerbose } from './lib/logger.js';

setVerbose(true);

async function testPerformanceTracking() {
  console.log('Testing performance tracking with top processes...\n');
  
  const tracker = new PerformanceTracker();
  
  // Start tracking
  tracker.start();
  console.log('Started tracking...');
  
  // Wait for 6 seconds to get at least one sample
  console.log('Waiting 6 seconds for sample...');
  await new Promise(resolve => setTimeout(resolve, 6000));
  
  // Stop tracking
  const result = tracker.stop();
  
  console.log('\n=== Performance Tracking Results ===');
  console.log(`Total samples: ${result.samples.length}`);
  
  if (result.samples.length > 0) {
    const firstSample = result.samples[0];
    console.log('\nFirst sample keys:', Object.keys(firstSample));
    console.log('Has topProcesses:', !!firstSample.topProcesses);
    console.log('topProcesses count:', firstSample.topProcesses?.length || 0);
    
    if (firstSample.topProcesses && firstSample.topProcesses.length > 0) {
      console.log('\nTop 3 processes:');
      firstSample.topProcesses.slice(0, 3).forEach((proc, i) => {
        console.log(`${i + 1}. ${proc.name} (PID: ${proc.pid})`);
        console.log(`   CPU: ${proc.cpu.toFixed(1)}%`);
        console.log(`   Memory: ${(proc.memory / (1024 * 1024)).toFixed(1)} MB`);
      });
    }
  }
  
  if (result.summary) {
    console.log('\nSummary:');
    console.log(`  Duration: ${(result.summary.durationMs / 1000).toFixed(1)}s`);
    console.log(`  Sample count: ${result.summary.sampleCount}`);
    console.log(`  Avg CPU: ${result.summary.avgProcessCPU.toFixed(1)}%`);
    console.log(`  Max CPU: ${result.summary.maxProcessCPU.toFixed(1)}%`);
  }
}

testPerformanceTracking().catch(console.error);
