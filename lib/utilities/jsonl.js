import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// Throttled logging to prevent spam
const throttledLog = (() => {
  const cache = {};
  const LOG_THROTTLE_DURATION = 500;

  return (level, msg, ...args) => {
    if (!logger[level]) level = 'info';
    if (!cache[level]) cache[level] = {};
    if (cache[level][msg]) return;
    cache[level][msg] = true;
    setTimeout(() => {
      delete cache[level][msg];
    }, LOG_THROTTLE_DURATION);
    logger[level](msg, ...args);
  };
})();

export const jsonl = {
  append: (file, json) => {
    if (!fs.existsSync(file)) {
      try {
        let fd = fs.openSync(file, 'w');
        fs.closeSync(fd);
      } catch (error) {
        throttledLog('info', `jsonl.js failed to initialize file ${error}`, {
          json,
        });
      }
    }
    try {
      fs.appendFileSync(file, JSON.stringify(json) + '\n', 'utf8');
    } catch (error) {
      throttledLog('info', `jsonl.js failed to append to file ${error}`, {
        json,
      });
    }

    return file;
  },
  
  read: (file) => {
    if (!fs.existsSync(file)) {
      return false;
    } else {
      return fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .slice(0, -1)
        .map(JSON.parse);
    }
  },
  
  write: (directory, fileName, arrayOfJsonObjects) => {
    const file = path.join(directory, fileName);

    if (!fs.existsSync(file)) {
      try {
        let fd = fs.openSync(file, 'w');
        fs.closeSync(fd);
      } catch (error) {
        throttledLog('info', `jsonl.js failed to initialize file ${error.message}`, {
          directory,
          fileName,
          error: error.message
        });
        throw error;
      }
    }
    try {
      let data = arrayOfJsonObjects.map((x) => JSON.stringify(x)).join('\n');
      fs.writeFileSync(file, data);
    } catch (error) {
      throttledLog('info', `jsonl.js failed to write to file ${error.message}`, {
        file,
        error: error.message
      });
      throw error;
    }

    return file;
  },
};
