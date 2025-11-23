import { execFile } from 'child_process';
import { promisify } from 'util';
import os from 'os';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Parse ps output format: "  PID %CPU %MEM COMMAND"
 */
function parsePsOutput(stdout, limit) {
  const lines = stdout.trim().split('\n');
  // Skip header line
  return lines.slice(1, 1 + limit).map(line => {
    const parts = line.trim().split(/\s+/, 4);
    return {
      pid: Number(parts[0]),
      cpu: Number(parts[1]),
      mem: Number(parts[2]),
      name: parts[3] || ''
    };
  });
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
      const result = await execFileAsync('ps', [
        '-Arco',
        'pid,pcpu,pmem,comm'
      ], { encoding: 'utf8' });
      stdout = result.stdout;
    } else {
      // Linux uses GNU ps - supports --sort
      const result = await execFileAsync('ps', [
        '-eo',
        'pid,pcpu,pmem,comm',
        '--sort=-pcpu'
      ], { encoding: 'utf8' });
      stdout = result.stdout;
    }
    
    return parsePsOutput(stdout, limit);
  } catch (error) {
    logger.warn('Failed to get top processes on Unix', { error: error.message });
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
    // Use PowerShell to get process info and convert to JSON
    // NOTE: PowerShell startup is slower but more reliable than WMI
    const psCmd = [
      'Get-Process | ',
      'Select-Object Id,CPU,WS,ProcessName | ',
      'ConvertTo-Json'
    ].join('');

    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      psCmd
    ], { encoding: 'utf8' });

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
