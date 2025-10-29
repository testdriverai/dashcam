import path from 'path';
import { logger } from '../logger.js';
import { FileTrackerManager } from './FileTrackerManager.js';
import { jsonl } from '../utilities/jsonl.js';

export class LogsTracker {
  // Omitting a directory puts it in a watch only mode where it
  // only collect per minute stats
  constructor({ config = {}, directory, fileTrackerManager }) {
    this.files = {};
    this.fileIndex = 0;
    this.fileToIndex = {};
    this.config = config;
    this.isWatchOnly = !directory;
    this.fileTrackerManager = fileTrackerManager || new FileTrackerManager();
    
    const filename = 'dashcam_logs_cli.jsonl';
    this.fileLocation = this.isWatchOnly ? '' : path.join(directory, filename);
    
    // Start tracking files from initial config
    this._updateTrackedFiles();
  }

  updateConfig(config) {
    this.config = config;
    this._updateTrackedFiles();
  }

  _updateTrackedFiles() {
    const updatedFilePaths = Object.keys(this.config);
    updatedFilePaths.forEach((filePath) => this._startFileTracker(filePath));

    Object.keys(this.files)
      .filter((filePath) => !updatedFilePaths.includes(filePath))
      .forEach((filePath) => this._stopFileTracker(filePath));
  }

  _startFileTracker(filePath) {
    if (this.files[filePath]) return;

    const index = ++this.fileIndex;
    this.fileToIndex[filePath] = index;
    const status = {
      item: index,
      count: 0,
    };
    const callback = (event) => {
      if (!this.fileLocation) return;
      jsonl.append(this.fileLocation, {
        ...event,
        logFile: index,
      });
      status.count++;
    };

    this.files[filePath] = {
      status,
      unsubscribe: this.fileTrackerManager.subscribe(filePath, callback),
    };
    
    logger.info(`Started tracking logs for ${filePath}`);
  }

  _stopFileTracker(filePath) {
    const unsubscribe = this.files[filePath]?.unsubscribe;
    if (unsubscribe) {
      delete this.fileToIndex[filePath];
      unsubscribe();
      delete this.files[filePath];
      logger.info(`Stopped tracking logs for ${filePath}`);
    }
  }

  // Legacy methods for backwards compatibility
  startTracking(filePath) {
    if (!this.config[filePath]) {
      this.config[filePath] = true;
      this._updateTrackedFiles();
    }
  }

  stopTracking(filePath) {
    if (this.config[filePath]) {
      delete this.config[filePath];
      this._updateTrackedFiles();
    }
  }

  startRecording(recordingPath) {
    this.fileLocation = recordingPath;
    logger.info(`Started recording to ${recordingPath}`);
  }

  stopRecording() {
    this.fileLocation = null;
    logger.info('Stopped recording');
  }

  getStatus() {
    let items = [];
    if (this.isWatchOnly) {
      items = Object.keys(this.files).map((filePath) => ({
        ...this.fileTrackerManager.getStats(filePath),
        item: this.fileToIndex[filePath],
      }));
    } else {
      items = Object.values(this.files).map(({ status }) => status);
    }

    const totalCount = items.reduce((acc, status) => acc + status.count, 0);

    return [
      {
        id: 'CLI',
        name: 'CLI',
        type: 'cli',
        fileLocation: this.fileLocation,
        items: items,
        count: totalCount,
      },
    ];
  }

  // Legacy method for backwards compatibility
  getStats() {
    const status = this.getStatus();
    return status.length > 0 ? status[0] : {
      id: 'CLI',
      name: 'CLI', 
      type: 'cli',
      fileLocation: this.fileLocation,
      items: [],
      count: 0
    };
  }

  destroy() {
    const status = this.getStatus();
    for (const filePath of Object.keys(this.files)) {
      this._stopFileTracker(filePath);
    }
    this.fileTrackerManager.destroy();
    this.fileLocation = null;
    logger.info('Destroyed log tracker');
    return status;
  }
}
