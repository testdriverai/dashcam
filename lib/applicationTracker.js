import { logger, logFunctionCall } from './logger.js';
import { extractIcon, getIconData } from './tracking/icons/index.js';
import { getActiveWindowInfo } from './tracking/systemWindowTracker.js';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Lazy-loaded get-windows module (will be loaded on first use)
let activeWindowSync = null;
let getWindowsLoadAttempted = false;
let usingSystemTracker = false;

async function loadGetWindows() {
  if (getWindowsLoadAttempted) {
    return activeWindowSync;
  }
  
  getWindowsLoadAttempted = true;
  
  try {
    // Try to import get-windows - will work if node_modules is available
    // or if running from source
    const getWindows = await import('get-windows');
    activeWindowSync = getWindows.activeWindowSync;
    logger.info('Successfully loaded get-windows for application tracking');
    return activeWindowSync;
  } catch (error) {
    const isPkg = typeof process.pkg !== 'undefined';
    
    if (isPkg) {
      logger.info('Using system-based window tracking (pkg build fallback)');
      usingSystemTracker = true;
    } else {
      logger.warn('get-windows not available, falling back to system commands', {
        error: error.message
      });
      usingSystemTracker = true;
    }
    return null;
  }
}

/**
 * Enhanced Application tracker for CLI
 * Uses desktop app patterns for tracking active applications and extracting icons
 */
class ApplicationTracker {
  constructor() {
    this.isTracking = false;
    this.trackingInterval = null;
    this.trackedApps = new Set();
    this.appEvents = [];
    this.failedAttempts = 0;
    this.maxFailedAttempts = 5;
    
    // Create a temporary directory for tracking logs
    this.trackingDir = path.join(os.tmpdir(), 'dashcam-cli-tracking');
    this.logFile = path.join(this.trackingDir, 'active-win.jsonl');
    
    // Ensure tracking directory exists
    if (!fs.existsSync(this.trackingDir)) {
      fs.mkdirSync(this.trackingDir, { recursive: true });
    }
  }

  /**
   * Start tracking active applications
   */
  start() {
    const logExit = logFunctionCall('ApplicationTracker.start');
    
    if (this.isTracking) {
      logger.debug('Application tracking already started');
      logExit();
      return;
    }

    logger.debug('Starting enhanced application tracking', {
      trackingDir: this.trackingDir,
      logFile: this.logFile
    });
    
    this.isTracking = true;
    this.trackedApps.clear();
    this.appEvents = [];
    this.failedAttempts = 0;

    // Clear previous tracking log
    if (fs.existsSync(this.logFile)) {
      fs.unlinkSync(this.logFile);
    }

    // Track active window every second (same as desktop app)
    this.trackingInterval = setInterval(() => {
      this.trackActiveWindow();
    }, 10000);

    logExit();
  }

  /**
   * Stop tracking active applications
   */
  stop() {
    const logExit = logFunctionCall('ApplicationTracker.stop');
    
    if (!this.isTracking) {
      logger.debug('Application tracking not started');
      logExit();
      return this.getResults();
    }

    logger.debug('Stopping enhanced application tracking');
    this.isTracking = false;
    
    if (this.trackingInterval) {
      clearInterval(this.trackingInterval);
      this.trackingInterval = null;
    }

    const results = this.getResults();
    logger.info('Enhanced application tracking stopped', {
      uniqueApps: results.apps.length,
      totalEvents: this.appEvents.length,
      iconsExtracted: results.icons.filter(icon => icon.file).length
    });

    logExit();
    return results;
  }

  /**
   * Track the currently active window (using desktop app patterns)
   */
  async trackActiveWindow() {
    // Lazy load get-windows on first use
    const getWindowsFn = await loadGetWindows();

    if (this.failedAttempts >= this.maxFailedAttempts) {
      logger.warn('Too many failed attempts, stopping application tracking');
      this.stop();
      return;
    }

    try {
      let activeWindow = null;
      
      // Try native module first, fall back to system commands
      if (getWindowsFn) {
        activeWindow = getWindowsFn();
      } else if (usingSystemTracker) {
        activeWindow = await getActiveWindowInfo();
      } else {
        if (this.failedAttempts === 0) {
          logger.info('Application tracking unavailable (no tracking method available)');
        }
        this.failedAttempts = this.maxFailedAttempts;
        this.stop();
        return;
      }
      
      if (activeWindow) {
        const appName = this.normalizeAppName(activeWindow.owner?.name);
        const appId = activeWindow.owner?.bundleId || activeWindow.owner?.path;
        
        if (appName) {
          // Track unique apps
          this.trackedApps.add(appName);
          
          // Create event object (same format as desktop app)
          const event = {
            title: activeWindow.title,
            time: Date.now(),
            owner: {
              id: appId,
              name: appName
            }
          };
          
          this.appEvents.push(event);
          
          // Extract icon for this application (async, non-blocking)
          if (appId) {
            extractIcon({ name: appName, id: appId }).catch(error => {
              logger.debug('Icon extraction failed', { 
                app: appName, 
                error: error.message 
              });
            });
          }
          
          // Log to JSONL file (same as desktop app)
          this.appendToLog(event);
          
          // Reset failed attempts on success
          this.failedAttempts = 0;
          
          logger.silly('Tracked active window with icon extraction', {
            app: appName,
            title: activeWindow.title?.substring(0, 50),
            hasId: !!appId
          });
        }
      } else {
        logger.debug('No active window detected');
        this.failedAttempts++;
      }
    } catch (error) {
      this.failedAttempts++;
      logger.warn('Failed to get active window', {
        error: error.message,
        attempt: this.failedAttempts
      });
    }
  }

  /**
   * Append event to JSONL log file
   */
  appendToLog(event) {
    try {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.logFile, line);
    } catch (error) {
      logger.warn('Failed to write to tracking log', { 
        error: error.message,
        logFile: this.logFile
      });
    }
  }

  /**
   * Normalize application name (same logic as desktop app)
   */
  normalizeAppName(name) {
    if (!name) return null;
    
    // Remove .exe extension and convert to lowercase
    name = name.split('.exe')[0];
    name = name.toLowerCase();
    return name;
  }

  /**
   * Get tracked applications and their icons (enhanced with actual icon data)
   */
  getResults() {
    const apps = Array.from(this.trackedApps);
    
    // Extract actual icon data for each app
    const icons = apps.map(appName => {
      const iconData = getIconData(appName, false);
      
      if (iconData) {
        return {
          name: appName,
          extension: iconData.extension,
          file: iconData.file // Actual file path to extracted icon
        };
      } else {
        // Fallback for apps without extracted icons
        return {
          name: appName,
          extension: 'png',
          file: null
        };
      }
    });

    return {
      apps,
      icons,
      events: this.appEvents,
      logFile: this.logFile // Include path to JSONL log
    };
  }

  /**
   * Get current tracking status
   */
  getStatus() {
    return {
      isTracking: this.isTracking,
      uniqueApps: this.trackedApps.size,
      totalEvents: this.appEvents.length,
      trackingDir: this.trackingDir,
      logFile: this.logFile
    };
  }

  /**
   * Clean up tracking files
   */
  cleanup() {
    const logExit = logFunctionCall('ApplicationTracker.cleanup');
    
    try {
      if (fs.existsSync(this.logFile)) {
        fs.unlinkSync(this.logFile);
        logger.debug('Cleaned up tracking log file');
      }
    } catch (error) {
      logger.warn('Failed to cleanup tracking files', { error: error.message });
    }
    
    logExit();
  }
}

// Create singleton instance
const applicationTracker = new ApplicationTracker();

export { applicationTracker };
export default applicationTracker;
