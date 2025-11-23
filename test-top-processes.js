#!/usr/bin/env node

import { getTopProcesses } from './lib/topProcesses.js';
import { logger, setVerbose } from './lib/logger.js';

setVerbose(true);

async function test() {
  console.log('Testing getTopProcesses...\n');
  
  const processes = await getTopProcesses(10);
  
  console.log(`Found ${processes.length} processes:\n`);
  
  processes.forEach((proc, index) => {
    console.log(`${index + 1}. ${proc.name} (PID: ${proc.pid})`);
    console.log(`   CPU: ${proc.cpu}%`);
    console.log(`   Memory: ${proc.mem || proc.memBytes}${proc.memBytes ? ' bytes' : '%'}`);
    console.log();
  });
}

test().catch(console.error);
