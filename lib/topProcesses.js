import { execFile, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

// Persistent PowerShell instance for Windows
let persistentPowerShell = null;
let psCommandQueue = [];
let psProcessing = false;

/**
 * Initialize a persistent PowerShell instance for Windows
 */
function initPersistentPowerShell() {
  if (persistentPowerShell) {
    return persistentPowerShell;
  }

  logger.debug('Initializing persistent PowerShell instance');

  const ps = spawn('powershell.exe', [
    '-NoLogo',
    '-NoProfile',
    '-NonInteractive',
    '-WindowStyle', 'Hidden',
    '-Command', '-'
  ], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  let outputBuffer = '';
  const DELIMITER = '---END-OF-COMMAND---';

  ps.stdout.on('data', (data) => {
    outputBuffer += data.toString();
    
    // Check if we have a complete response
    const delimiterIndex = outputBuffer.indexOf(DELIMITER);
    if (delimiterIndex !== -1) {
      const output = outputBuffer.substring(0, delimiterIndex);
      outputBuffer = outputBuffer.substring(delimiterIndex + DELIMITER.length);
      
      // Resolve the pending command
      if (psCommandQueue.length > 0) {
        const { resolve } = psCommandQueue.shift();
        resolve(output);
        psProcessing = false;
        processNextCommand();
      }
    }
  });

  ps.stderr.on('data', (data) => {
    logger.debug('PowerShell stderr:', data.toString());
  });

  ps.on('close', (code) => {
    logger.debug('PowerShell process closed', { code });
    persistentPowerShell = null;
    // Reject all pending commands
    while (psCommandQueue.length > 0) {
      const { reject } = psCommandQueue.shift();
      reject(new Error('PowerShell process closed'));
    }
  });

  ps.on('error', (error) => {
    logger.warn('PowerShell process error', { error: error.message });
    persistentPowerShell = null;
  });

  persistentPowerShell = ps;
  persistentPowerShell.delimiter = DELIMITER;
  
  return ps;
}

/**
 * Process the next command in the queue
 */
function processNextCommand() {
  if (psProcessing || psCommandQueue.length === 0) {
    return;
  }

  psProcessing = true;
  const { command } = psCommandQueue[0];
  
  try {
    persistentPowerShell.stdin.write(command + '\n');
    persistentPowerShell.stdin.write(`Write-Host '${persistentPowerShell.delimiter}'\n`);
  } catch (error) {
    logger.warn('Failed to write to PowerShell stdin', { error: error.message });
    const { reject } = psCommandQueue.shift();
    reject(error);
    psProcessing = false;
    processNextCommand();
  }
}

/**
 * Execute a command in the persistent PowerShell instance
 */
function execPowerShellCommand(command, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const ps = initPersistentPowerShell();
    
    const timeoutId = setTimeout(() => {
      reject(new Error('PowerShell command timeout'));
    }, timeout);

    psCommandQueue.push({
      command,
      resolve: (output) => {
        clearTimeout(timeoutId);
        resolve(output);
      },
      reject: (error) => {
        clearTimeout(timeoutId);
        reject(error);
      }
    });

    processNextCommand();
  });
}

/**
 * Cleanup the persistent PowerShell instance
 */
export function cleanupPowerShell() {
  if (persistentPowerShell) {
    logger.debug('Cleaning up persistent PowerShell instance');
    try {
      persistentPowerShell.stdin.end();
      persistentPowerShell.kill();
    } catch (error) {
      logger.debug('Error cleaning up PowerShell', { error: error.message });
    }
    persistentPowerShell = null;
  }
}

/**
 * Parse ps output format: "  PID %CPU %MEM COMMAND"
 */
function parsePsOutput(stdout, limit) {
  logger.debug('Parsing ps output', { 
    outputLength: stdout.length,
    firstLine: stdout.split('\n')[0],
    lineCount: stdout.split('\n').length
  });
  
  const lines = stdout.trim().split('\n');
  
  if (lines.length === 0) {
    logger.warn('ps output is empty');
    return [];
  }
  
  // Skip header line
  const processes = lines.slice(1).map(line => {
    const parts = line.trim().split(/\s+/, 4);
    return {
      pid: Number(parts[0]),
      cpu: Number(parts[1]) || 0,
      mem: Number(parts[2]) || 0,
      name: parts[3] || ''
    };
  }).filter(proc => proc.pid > 0); // Filter out invalid entries
  
  logger.debug('Parsed processes', { 
    count: processes.length,
    sample: processes.slice(0, 3)
  });
  
  // Sort by CPU descending (in case ps doesn't support --sort)
  processes.sort((a, b) => b.cpu - a.cpu);
  
  return processes.slice(0, limit);
}

/**
 * Get top processes on Unix-like systems (Linux, macOS)
 */
async function getTopProcessesUnix(limit = 10) {
  try {
    let stdout;
    
    if (os.platform() === 'darwin') {
      // macOS uses BSD ps - different syntax, no --sort option
      // Use -r flag to sort by CPU usage
      console.log('[topProcesses] Running macOS ps command');
      const result = await execFileAsync('ps', [
        '-Arco',
        'pid,pcpu,pmem,comm'
      ], { encoding: 'utf8', timeout: 5000 });
      stdout = result.stdout;
      console.log('[topProcesses] macOS ps succeeded, output length:', stdout.length);
    } else {
      // Linux - try different variations in order of preference
      const psVariations = [
        // Standard GNU ps with --sort
        { args: ['-eo', 'pid,pcpu,pmem,comm', '--sort=-pcpu'], name: 'GNU ps with --sort' },
        // GNU ps without --sort (we'll sort in JS)
        { args: ['-eo', 'pid,pcpu,pmem,comm'], name: 'GNU ps without --sort' },
        // BusyBox ps (minimal options)
        { args: ['-o', 'pid,pcpu,pmem,comm'], name: 'BusyBox ps' },
        // Most basic ps command
        { args: ['aux'], name: 'basic ps aux' }
      ];
      
      let psSuccess = false;
      for (const variation of psVariations) {
        try {
          console.log(`[topProcesses] Trying: ${variation.name}`);
          const result = await execFileAsync('ps', variation.args, { 
            encoding: 'utf8', 
            timeout: 5000 
          });
          stdout = result.stdout;
          console.log(`[topProcesses] ${variation.name} succeeded, output length:`, stdout.length);
          logger.debug(`ps command succeeded: ${variation.name}`, { outputLength: stdout.length });
          psSuccess = true;
          break;
        } catch (err) {
          console.log(`[topProcesses] ${variation.name} failed:`, err.message);
          // Try next variation
        }
      }
      
      if (!psSuccess) {
        throw new Error('All ps command variations failed');
      }
    }
    
    console.log('[topProcesses] Parsing ps output...');
    const processes = parsePsOutput(stdout, limit);
    console.log('[topProcesses] Parsed', processes.length, 'processes');
    logger.debug('Parsed processes from ps output', { 
      processCount: processes.length,
      firstProcess: processes[0]
    });
    
    return processes;
  } catch (error) {
    console.error('[topProcesses] FATAL ERROR getting top processes:', error.message);
    console.error('[topProcesses] Error stack:', error.stack);
    logger.warn('Failed to get top processes on Unix', { 
      error: error.message,
      stack: error.stack,
      platform: os.platform()
    });
    return [];
  }
}

/**
 * Parse PowerShell JSON output for Windows processes
 */
function parsePsWinJson(stdout, limit) {
  let arr;
  try {
    arr = JSON.parse(stdout);
  } catch (e) {
    logger.warn('Failed to parse PowerShell JSON output', { error: e.message });
    return [];
  }
  
  if (!Array.isArray(arr)) {
    arr = [arr];
  }

  // Some fields may be undefined if CPU hasn't updated yet
  arr.sort((a, b) => (b.CPU || 0) - (a.CPU || 0));

  return arr.slice(0, limit).map(p => ({
    pid: p.Id,
    cpu: p.CPU || 0,              // total CPU seconds
    memBytes: p.WS || 0,          // working set in bytes
    name: p.ProcessName || ''
  }));
}

/**
 * Get top processes on Windows using PowerShell
 */
async function getTopProcessesWindows(limit = 10) {
  try {
    // Use persistent PowerShell instance
    const psCmd = "Get-Process | Select-Object Id,CPU,WS,ProcessName | ConvertTo-Json";
    
    const stdout = await execPowerShellCommand(psCmd, 10000);
    return parsePsWinJson(stdout, limit);
  } catch (error) {
    logger.warn('Failed to get top processes on Windows', { error: error.message });
    return [];
  }
}

/**
 * Get top processes by CPU usage (cross-platform)
 * @param {number} limit - Number of top processes to return (default: 10)
 * @returns {Promise<Array>} Array of process objects with pid, cpu, mem/memBytes, and name
 */
export async function getTopProcesses(limit = 10) {
  const platform = os.platform();
  
  logger.debug('Getting top processes', { platform, limit });
  
  if (platform === 'win32') {
    return getTopProcessesWindows(limit);
  }
  
  // Linux, macOS, and other Unix-like systems
  return getTopProcessesUnix(limit);
}
