const _ = require("lodash");
const path = require("path");
const fs = require("fs");
const { logger, logFunctionCall } = require("../logger.js");
const { extractIcon } = require("./icons");

// Try to load get-windows, but handle gracefully if it's not available (e.g., in pkg builds)
let activeWindowSync = null;
let useSystemTracker = false;
let systemTrackerModule = null;

try {
  const getWindows = require("get-windows");
  activeWindowSync = getWindows.activeWindowSync;
  logger.debug("Successfully loaded get-windows module");
} catch (error) {
  logger.debug("get-windows not available, will use system-based tracking");
  useSystemTracker = true;
}

const normalizeAppName = (name) => {
  name = name.split(".exe")[0];
  name = name.toLowerCase();
  return name;
};

// Simple JSONL utilities for CLI
const jsonl = {
  append: (filePath, data) => {
    const line = JSON.stringify(data) + '\n';
    fs.appendFileSync(filePath, line);
  }
};

class ActiveWin {
  constructor({ recorderId, screenId, directory, fileName }) {
    this.recorderId = recorderId;
    this.screenId = screenId;
    this.directory = directory;
    this.fileName = fileName;

    this.intervalRef = null;
    this.failedAttempts = 0;
  }

  async trackActiveWin() {
    if (this.failedAttempts === 5) {
      logger.warn("active-win.js failed 5 attempts, stopping interval", {
        recorderId: this.recorderId,
        screenId: this.screenId,
      });
      this.stop();
      return;
    }

    try {
      let awin = null;
      
      // Try native module first
      if (activeWindowSync) {
        awin = activeWindowSync();
      } 
      // Fall back to system tracker
      else if (useSystemTracker) {
        // Lazy load the system tracker module
        if (!systemTrackerModule) {
          systemTrackerModule = await import("./systemWindowTracker.js");
        }
        awin = await systemTrackerModule.getActiveWindowInfo();
      }
      
      // If no tracking method available, stop
      if (!activeWindowSync && !useSystemTracker) {
        if (this.failedAttempts === 0) {
          logger.debug("Active window tracking unavailable (no tracking method)");
        }
        this.failedAttempts = 5;
        this.stop();
        return;
      }

      if (awin) {
        const result = {
          title: awin.title,
          time: Date.now(),
          owner: {
            id: awin.owner?.bundleId || awin.owner?.path,
            name: normalizeAppName(awin.owner?.name),
          },
        };

        // Extract icon for this application
        await extractIcon({ name: result.owner.name, id: result.owner.id });

        // Write to JSONL file
        jsonl.append(path.join(this.directory, this.fileName), result);
        
        logger.silly("Tracked active window", {
          app: result.owner.name,
          title: result.title?.substring(0, 50)
        });
      } else {
        logger.debug("active-win.js activeWindowSync() returned nullable value");
        this.failedAttempts++;
      }
    } catch (err) {
      logger.warn("active-win.js error", {
        error: err.message,
        attempt: this.failedAttempts + 1
      });
      this.failedAttempts++;
    }
  }

  start() {
    const logExit = logFunctionCall('ActiveWin.start');
    
    logger.debug("active-win.js starting tracking active win", {
      recorderId: this.recorderId,
      screenId: this.screenId,
      directory: this.directory,
      fileName: this.fileName,
    });

    if (!this.screenId || !this.directory || !this.fileName) {
      logger.warn("active-win.js missing args", {
        recorderId: this.recorderId,
        screenId: this.screenId,
      });
      logExit();
      return;
    }

    if (!this.intervalRef) {
      logger.debug("active-win.js active win start interval");
      this.intervalRef = setInterval(() => this.trackActiveWin(), 10000);
    } else {
      logger.debug("active-win.js active win already started", {
        recorderId: this.recorderId,
        screenId: this.screenId,
      });
    }
    
    logExit();
  }

  stop = () => {
    const logExit = logFunctionCall('ActiveWin.stop');
    
    logger.debug("active-win.js removing tracker for screen", {
      recorderId: this.recorderId,
      screenId: this.screenId,
    });

    if (this.intervalRef) {
      clearInterval(this.intervalRef);
    }

    this.intervalRef = null;
    logExit();
  };
}

class ActiveWinManager {
  constructor() {
    this.activeWins = [];
  }

  startNew({ recorderId, screenId, directory, fileName }) {
    const logExit = logFunctionCall('ActiveWinManager.startNew');
    
    const activeWin = new ActiveWin({
      recorderId,
      screenId,
      directory,
      fileName,
    });

    activeWin.start();
    this.activeWins.push(activeWin);
    
    logger.debug("Started new active window tracker", {
      recorderId,
      screenId,
      totalTrackers: this.activeWins.length
    });
    
    logExit();
  }

  stop({ recorderId, screenId }) {
    const logExit = logFunctionCall('ActiveWinManager.stop');
    
    const index = this.activeWins.findIndex(
      (win) => win.recorderId === recorderId && win.screenId === screenId
    );

    if (index > -1) {
      const activeWin = this.activeWins[index];
      activeWin.stop();
      this.activeWins.splice(index, 1);
      
      logger.debug("Stopped active window tracker", {
        recorderId,
        screenId,
        remainingTrackers: this.activeWins.length
      });
    }
    
    logExit();
  }

  stopAll() {
    const logExit = logFunctionCall('ActiveWinManager.stopAll');
    
    logger.info("active-win.js stopping all active wins");
    this.activeWins.forEach((activeWin) => activeWin.stop());
    this.activeWins = [];
    
    logExit();
  }
}

const activeWinManager = new ActiveWinManager();
module.exports = activeWinManager;
