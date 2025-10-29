import { Tail } from 'tail';
import { logger } from '../logger.js';

// Simple function to get stats for events in the last minute
function getStats(eventTimes = []) {
  const endTime = Date.now();
  const startTime = Date.now() - 60000;

  let startIndex = 0;
  let count = 0;

  for (const time of eventTimes) {
    if (time < startTime) startIndex++;
    else if (time <= endTime) {
      count++;
    } else break;
  }

  return {
    eventTimes: eventTimes.slice(startIndex),
    count,
  };
}

// Simple ANSI escape code regex for stripping colors
const ansiRegex = /[\u001B\u009B][[\\]()#;?]*(?:(?:(?:(?:;[-a-zA-Z\d\\/#&.:=?%@~_]+)*|[a-zA-Z\d]+(?:;[-a-zA-Z\d\\/#&.:=?%@~_]*)*)?\\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\\dA-PR-TZcf-nq-uy=><~]))/g;

function stripAnsi(string) {
  if (typeof string !== 'string') {
    throw new TypeError(`Expected a \`string\`, got \`${typeof string}\``);
  }
  return string.replace(ansiRegex, '');
}

export class FileTracker {
  constructor(trackedFile, callback) {
    this.tail = null;
    this.eventTimes = [];
    this.callback = callback;
    this.trackedFile = trackedFile;

    try {
      this.tail = new Tail(this.trackedFile, { encoding: 'ascii' });
      this.tail.on('line', (line) => {
        const time = Date.now();
        this.eventTimes.push(time);

        // Log errors for debugging (simplified error handling)
        if (line.toLowerCase().indexOf('error') > -1) {
          logger.warn('Error found in log file', { 
            file: trackedFile, 
            line: stripAnsi(line).substring(0, 200) 
          });
        }

        if (!this.callback) return;

        try {
          this.callback({
            line,
            time,
            logFile: this.trackedFile,
          });
        } catch (err) {
          logger.error(
            `FAILED callback for FileTracker ${this.trackedFile} with error:`,
            err
          );
        }
      });

      this.tail.on('error', (data) => {
        logger.error(
          `Error in file tracker for file "${this.trackedFile}": ${data}`
        );
      });
    } catch (e) {
      logger.error('Failed to create FileTracker', { trackedFile, error: e });
    }
  }

  destroy() {
    if (this.tail) {
      this.tail.unwatch();
      this.tail = null;
    }
  }

  getStats() {
    const { eventTimes, count } = getStats(this.eventTimes);

    this.eventTimes = eventTimes;
    return {
      count,
      item: this.trackedFile,
    };
  }
}
