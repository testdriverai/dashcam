import path from 'path';
import { logger } from '../logger.js';
import { LogsTracker } from '../tracking/LogsTracker.js';
import { FileTrackerManager } from '../tracking/FileTrackerManager.js';
import { WebLogsDaemon, DAEMON_CONFIG_FILE } from '../webLogsDaemon.js';
import { WebLogsTracker } from '../extension-logs/index.js';
import { WebTrackerManager } from '../extension-logs/manager.js';
import { server } from '../websocket/server.js';
import { jsonl } from '../utilities/jsonl.js';
import { filterWebEvents } from '../extension-logs/helpers.js';
import fs from 'fs';

const CLI_CONFIG_FILE = path.join(process.cwd(), '.dashcam', 'cli-config.json');

// Simple trim function for CLI (adapted from desktop app)
async function trimLogs(groupLogStatuses, startMS, endMS, clientStartDate, clipId) {
  logger.info('Trimming logs', { count: groupLogStatuses.length });
  
  const REPLAY_DIR = path.join(os.tmpdir(), 'dashcam', 'recordings');
  
  // Filter out logs with no content
  groupLogStatuses = groupLogStatuses.filter((status) => status.count);
  
  let webHandled = false;

  groupLogStatuses.forEach((status) => {
    if (!status.fileLocation || !status.count) return;
    
    try {
      const parsed = path.parse(status.fileLocation);
      const content = jsonl.read(status.fileLocation);
      
      if (!content || !Array.isArray(content)) return;
      
      let events = content;
      
      // Convert events to relative time
      let relativeEvents = events.map((event) => {
        event.time = parseInt(event.time + '') - startMS;
        // Check if it's not already relative time
        if (event.time > 1_000_000_000_000) {
          // relative time = absolute time - clip start time
          event.time = event.time - clientStartDate;
        }
        return event;
      });

      const duration = endMS - startMS;
      let filteredEvents = relativeEvents;

      if (status.type === 'application' || status.type === 'cli') {
        // Filter events within the time range
        filteredEvents = filteredEvents.filter((event) => {
          return event.time >= 0 && event.time <= duration;
        });

        if (status.type === 'cli') {
          // Remap logFile indices for CLI logs
          let map = {};
          filteredEvents = filteredEvents.map((event) => {
            let name = map[event.logFile] ?? Object.keys(map).length + 1;
            if (!map[event.logFile]) map[event.logFile] = name;
            return {
              ...event,
              logFile: name,
            };
          });
        }
      } else if (status.type === 'web' && !webHandled) {
        logger.debug('Found web groupLog, handling all web groupLogs at once');
        // We do this because weblogs have a single shared jsonl file
        // shared between all web logs
        filteredEvents = filterWebEvents(
          filteredEvents,
          groupLogStatuses.filter((status) => status.type === 'web'),
          0,
          duration
        );

        webHandled = true;
      } else if (status.type === 'web') {
        // Skip processing for additional web logs - already handled
        status.trimmedFileLocation = path.join(
          REPLAY_DIR,
          [clipId, parsed.base].join('_')
        );
        status.count = filteredEvents.length;
        return;
      }

      logger.debug('Filtered events', {
        source: events.length,
        filtered: filteredEvents.length,
        difference: events.length - filteredEvents.length,
      });

      status.count = filteredEvents.length;
      status.trimmedFileLocation = jsonl.write(
        REPLAY_DIR,
        [clipId, parsed.base].join('_'),
        filteredEvents
      );
    } catch (error) {
      logger.error('Error trimming log file', { file: status.fileLocation, error });
    }
  });

  // Handle shared web log file location
  const firstWebLog = groupLogStatuses.find(
    (status) => status.type === 'web' && status.trimmedFileLocation
  );
  if (firstWebLog) {
    groupLogStatuses
      .filter((status) => status.type === 'web')
      .forEach(
        (status) =>
          (status.trimmedFileLocation = firstWebLog.trimmedFileLocation)
      );
  }

  return groupLogStatuses;
}

class LogsTrackerManager {
  constructor() {
    this.instances = {};
    this.cliConfig = {};
    this.webLogsConfig = {};
    this.fileTrackerManager = new FileTrackerManager();
    
    // Load persisted configs
    this.loadCliConfig();
    this.loadWebConfig();
    
    // Create the singleton watch-only tracker for CLI files
    this.watchTracker = new LogsTracker({
      config: this.cliConfig,
      fileTrackerManager: this.fileTrackerManager
    });
  }

  async ensureWebDaemonRunning() {
    try {
      await WebLogsDaemon.ensureDaemonRunning();
    } catch (error) {
      logger.error('Failed to ensure web daemon is running', { error });
    }
  }

  loadWebConfig() {
    try {
      if (fs.existsSync(DAEMON_CONFIG_FILE)) {
        const data = fs.readFileSync(DAEMON_CONFIG_FILE, 'utf8');
        this.webLogsConfig = JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to load web config', { error });
    }
  }

  saveWebConfig() {
    try {
      fs.writeFileSync(DAEMON_CONFIG_FILE, JSON.stringify(this.webLogsConfig, null, 2));
    } catch (error) {
      logger.error('Failed to save web config', { error });
    }
  }

  loadCliConfig() {
    try {
      if (fs.existsSync(CLI_CONFIG_FILE)) {
        const data = fs.readFileSync(CLI_CONFIG_FILE, 'utf8');
        this.cliConfig = JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to load CLI config', { error });
    }
  }

  saveCliConfig() {
    try {
      // Ensure directory exists
      const dir = path.dirname(CLI_CONFIG_FILE);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(CLI_CONFIG_FILE, JSON.stringify(this.cliConfig, null, 2));
    } catch (error) {
      logger.error('Failed to save CLI config', { error });
    }
  }

  updateLogsConfig(config) {
    // Update web logs config
    const webConfigs = Array.isArray(config) ? 
      config.filter(app => app.type === 'web' && app.enabled === true)
        .reduce((map, config) => {
          map[config.id] = config;
          return map;
        }, {}) : {};
    
    this.webLogsConfig = webConfigs;
    this.saveWebConfig();
    
    logger.info('Updated logs config', { webConfigs });
  }

  async addWebTracker(config) {
    this.webLogsConfig[config.id] = config;
    this.saveWebConfig();
    
    // Ensure daemon is running and will pick up the new config
    await this.ensureWebDaemonRunning();
    
    logger.info(`Added web tracker: ${config.name}`, { patterns: config.patterns });
  }

  pushCliTrackedPath(filePath) {
    if (!this.cliConfig[filePath]) {
      this.cliConfig[filePath] = true;
      this.watchTracker.updateConfig(this.cliConfig);
      this.saveCliConfig();
      logger.info(`Added CLI tracked path: ${filePath}`);
    }
  }

  removeCliTrackedPath(filePath) {
    if (this.cliConfig[filePath]) {
      delete this.cliConfig[filePath];
      this.watchTracker.updateConfig(this.cliConfig);
      this.saveCliConfig();
      logger.info(`Removed CLI tracked path: ${filePath}`);
    }
  }

  // CLI interface methods
  addCliLogFile(filePath) {
    this.pushCliTrackedPath(filePath);
  }

  removeCliLogFile(filePath) {
    this.removeCliTrackedPath(filePath);
  }

  removeTracker(id) {
    // Try removing from web trackers first
    if (this.webLogsConfig[id]) {
      delete this.webLogsConfig[id];
      this.saveWebConfig();
      logger.info(`Removed web tracker: ${id}`);
      return;
    }
    
    // Check if it's a file tracker (format: file-1, file-2, etc.)
    if (id.startsWith('file-')) {
      const fileIndex = parseInt(id.split('-')[1]) - 1;
      const cliFiles = Object.keys(this.cliConfig);
      if (fileIndex >= 0 && fileIndex < cliFiles.length) {
        const filePath = cliFiles[fileIndex];
        this.removeCliTrackedPath(filePath);
        logger.info(`Removed file tracker: ${filePath}`);
        return;
      }
    }
    
    logger.warn(`Tracker not found: ${id}`);
  }

  getStatus() {
    // Load current web config
    this.loadWebConfig();
    
    const activeInstances = Object.keys(this.instances).length;
    const cliFilesCount = Object.keys(this.cliConfig).length;
    const webAppsCount = Object.keys(this.webLogsConfig).length;
    
    // Get file tracker stats
    const fileTrackerStats = Object.keys(this.cliConfig).map(filePath => {
      const stats = this.fileTrackerManager.getStats(filePath);
      return {
        filePath,
        count: stats.count
      };
    });
    
    const totalEvents = fileTrackerStats.reduce((sum, stat) => sum + stat.count, 0);
    
    return {
      activeInstances,
      cliFilesCount,
      webAppsCount,
      totalEvents,
      fileTrackerStats,
      cliFiles: Object.keys(this.cliConfig),
      webApps: Object.values(this.webLogsConfig).map(config => ({
        id: config.id,
        name: config.name,
        patterns: config.patterns
      })),
      webDaemonRunning: WebLogsDaemon.isDaemonRunning()
    };
  }

  async startNew({ recorderId, screenId, directory }) {
    logger.debug('LogsTrackerManager: Starting new logs tracker instance', { recorderId, screenId, directory });
    
    const instanceKey = `${recorderId}_${screenId}`;
    
    // Create recording tracker for CLI logs
    const cliTracker = new LogsTracker({
      directory,
      config: { ...this.cliConfig }, // Copy current config
      fileTrackerManager: this.fileTrackerManager,
    });

    // Start WebSocket server if not already running
    if (!server.isListening.value) {
      logger.debug('LogsTrackerManager: Starting WebSocket server...');
      await server.start();
      logger.info('LogsTrackerManager: WebSocket server started on port', { port: server.port });
    } else {
      logger.debug('LogsTrackerManager: WebSocket server already running on port', { port: server.port });
    }

    // Create a WebTrackerManager instance for this recording
    logger.debug('LogsTrackerManager: Creating WebTrackerManager for recording...');
    const webTrackerManager = new WebTrackerManager(server);
    
    // Create recording tracker for web logs with directory to write events to file
    logger.debug('LogsTrackerManager: Creating WebLogsTracker for recording...', { 
      directory, 
      webConfigCount: Object.keys(this.webLogsConfig).length 
    });
    const webTracker = new WebLogsTracker({
      config: { ...this.webLogsConfig }, // Copy current web config
      webTrackerManager,
      directory // This makes it NOT watch-only, so events will be written to file
    });

    this.instances[instanceKey] = {
      recorderId,
      screenId,
      directory,
      trackers: {
        cli: cliTracker,
        web: webTracker,
        webTrackerManager // Store this so we can clean it up later
      },
      startTime: Date.now(),
      endTime: undefined,
    };

    logger.info(`Started new logs tracker instance with web support`, { 
      recorderId, 
      screenId, 
      directory,
      webConfigCount: Object.keys(this.webLogsConfig).length
    });
    return this.instances[instanceKey];
  }

  async stop({ recorderId, screenId }) {
    const instanceKey = `${recorderId}_${screenId}`;
    const instance = this.instances[instanceKey];
    
    if (!instance) {
      logger.warn(`No logs tracker instance found for ${instanceKey}`);
      return [];
    }
    
    delete this.instances[instanceKey];
    
    // Stop CLI tracker
    const cliStatus = instance.trackers.cli.destroy();
    
    // Stop web tracker if it exists
    let webStatus = [];
    if (instance.trackers.web) {
      logger.debug('LogsTrackerManager: Stopping web tracker...', { recorderId, screenId });
      webStatus = instance.trackers.web.destroy();
    }
    
    // Clean up WebTrackerManager if it exists
    if (instance.trackers.webTrackerManager) {
      logger.debug('LogsTrackerManager: Destroying WebTrackerManager...', { recorderId, screenId });
      instance.trackers.webTrackerManager.destroy();
    }
    
    // Stop WebSocket server if no more recording instances are active
    const remainingInstances = Object.keys(this.instances).length;
    if (remainingInstances === 0 && server.isListening.value) {
      logger.debug('LogsTrackerManager: No more recording instances, stopping WebSocket server...');
      await server.stop();
      logger.info('LogsTrackerManager: WebSocket server stopped');
    } else {
      logger.debug('LogsTrackerManager: WebSocket server kept running', { remainingInstances });
    }
    
    logger.info(`Stopped logs tracker instance with web support`, { 
      recorderId, 
      screenId,
      cliStatusCount: cliStatus.length,
      webStatusCount: webStatus.length
    });
    
    // Combine CLI and web statuses
    return [...cliStatus, ...webStatus];
  }

  stopAll() {
    logger.info('Stopping all logs tracker instances');
    const results = [];
    for (const instanceKey of Object.keys(this.instances)) {
      const [recorderId, screenId] = instanceKey.split('_');
      results.push(...this.stop({ recorderId, screenId }));
    }
    return results;
  }

  destroy() {
    this.stopAll();
    this.watchTracker.destroy();
    this.fileTrackerManager.destroy();
    // Note: Don't stop the web daemon here as it should persist
  }
}

// Create singleton instance
const logsTrackerManager = new LogsTrackerManager();

export { trimLogs, logsTrackerManager };
