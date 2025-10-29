import { server } from './websocket/server.js';
import { WebTrackerManager } from './extension-logs/manager.js';
import { WebLogsTracker } from './extension-logs/index.js';
import { logger } from './logger.js';
import fs from 'fs';
import path from 'path';

const DAEMON_DIR = path.join(process.cwd(), '.dashcam');
const DAEMON_PID_FILE = path.join(DAEMON_DIR, 'daemon.pid');
const DAEMON_CONFIG_FILE = path.join(DAEMON_DIR, 'web-config.json');

// Ensure daemon directory exists
if (!fs.existsSync(DAEMON_DIR)) {
  fs.mkdirSync(DAEMON_DIR, { recursive: true });
}

class WebLogsDaemon {
  constructor() {
    this.webTrackerManager = null;
    this.webWatchTracker = null;
    this.isRunning = false;
  }

  async start() {
    if (this.isRunning) {
      logger.debug('Web logs daemon already running, skipping start');
      return;
    }

    logger.info('Starting web logs daemon...');
    try {
      // Start WebSocket server
      logger.debug('Initializing WebSocket server...');
      await server.start();
      logger.info(`WebSocket server started on port ${server.port}`);

      // Create web tracker manager
      logger.debug('Creating WebTrackerManager...');
      this.webTrackerManager = new WebTrackerManager(server);
      
      // Load existing config if available
      logger.debug('Loading daemon configuration...');
      const config = this.loadConfig();
      logger.debug('Loaded config:', { configKeys: Object.keys(config), configCount: Object.keys(config).length });
      
      this.webWatchTracker = new WebLogsTracker({
        config,
        webTrackerManager: this.webTrackerManager
      });

      this.isRunning = true;
      
      // Write PID file
      logger.debug('Writing daemon PID file...');
      fs.writeFileSync(DAEMON_PID_FILE, process.pid.toString());
      
      logger.info('Web logs daemon started successfully');

      // Keep process alive
      process.on('SIGTERM', () => {
        logger.info('Received SIGTERM, stopping daemon...');
        this.stop();
      });
      process.on('SIGINT', () => {
        logger.info('Received SIGINT, stopping daemon...');
        this.stop();
      });

    } catch (error) {
      logger.error('Failed to start web logs daemon', { error: error.message, stack: error.stack });
      throw error;
    }
  }

  stop() {
    if (!this.isRunning) {
      logger.debug('Web logs daemon not running, skipping stop');
      return;
    }

    logger.info('Stopping web logs daemon...');
    
    if (this.webWatchTracker) {
      logger.debug('Destroying web watch tracker...');
      this.webWatchTracker.destroy();
    }
    
    if (this.webTrackerManager) {
      logger.debug('Destroying web tracker manager...');
      this.webTrackerManager.destroy();
    }
    
    logger.debug('Stopping WebSocket server...');
    server.stop();
    
    // Remove PID file
    if (fs.existsSync(DAEMON_PID_FILE)) {
      logger.debug('Removing daemon PID file...');
      fs.unlinkSync(DAEMON_PID_FILE);
    }
    
    this.isRunning = false;
    logger.info('Web logs daemon stopped');
    process.exit(0);
  }

  updateConfig(config) {
    logger.debug('Updating daemon config...', { configKeys: Object.keys(config) });
    if (this.webWatchTracker) {
      this.webWatchTracker.updateConfig(config);
    }
    this.saveConfig(config);
    logger.info('Daemon config updated successfully');
  }

  loadConfig() {
    try {
      if (fs.existsSync(DAEMON_CONFIG_FILE)) {
        logger.debug('Loading daemon config from file...', { configFile: DAEMON_CONFIG_FILE });
        const data = fs.readFileSync(DAEMON_CONFIG_FILE, 'utf8');
        const config = JSON.parse(data);
        logger.debug('Daemon config loaded successfully', { configKeys: Object.keys(config) });
        return config;
      } else {
        logger.debug('No daemon config file found, using empty config');
      }
    } catch (error) {
      logger.error('Failed to load daemon config', { error: error.message, configFile: DAEMON_CONFIG_FILE });
    }
    return {};
  }

  saveConfig(config) {
    try {
      logger.debug('Saving daemon config to file...', { configFile: DAEMON_CONFIG_FILE, configKeys: Object.keys(config) });
      fs.writeFileSync(DAEMON_CONFIG_FILE, JSON.stringify(config, null, 2));
      logger.debug('Daemon config saved successfully');
    } catch (error) {
      logger.error('Failed to save daemon config', { error: error.message, configFile: DAEMON_CONFIG_FILE });
    }
  }

  static isDaemonRunning() {
    try {
      if (!fs.existsSync(DAEMON_PID_FILE)) {
        logger.debug('Daemon PID file does not exist, daemon not running');
        return false;
      }
      
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
      if (isNaN(pid)) {
        logger.warn('Invalid PID in daemon PID file', { pidFile: DAEMON_PID_FILE });
        return false;
      }
      
      logger.debug('Checking if daemon process is still running...', { pid });
      // Check if process is still running
      process.kill(pid, 0);
      logger.debug('Daemon process is running', { pid });
      return true;
    } catch (error) {
      logger.debug('Daemon process not running or not accessible', { error: error.message });
      return false;
    }
  }

  static async ensureDaemonRunning() {
    if (!WebLogsDaemon.isDaemonRunning()) {
      logger.info('Web logs daemon not running, starting it...');
      
      // Spawn daemon process
      const { spawn } = await import('child_process');
      const child = spawn('node', [
        path.join(process.cwd(), 'bin/dashcam.js'),
        '_internal_daemon'
      ], {
        detached: true,
        stdio: 'inherit'  // Changed from 'ignore' to 'inherit' for debugging
      });
      
      logger.debug('Spawned daemon process', { pid: child.pid });
      child.unref();
      
      // Wait a moment for daemon to start
      logger.debug('Waiting for daemon to start...');
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (!WebLogsDaemon.isDaemonRunning()) {
        logger.error('Failed to start web logs daemon after spawn attempt');
        throw new Error('Failed to start web logs daemon');
      } else {
        logger.info('Web logs daemon started successfully');
      }
    } else {
      logger.debug('Web logs daemon already running');
    }
  }

  static stopDaemon() {
    try {
      if (!fs.existsSync(DAEMON_PID_FILE)) {
        logger.debug('No daemon PID file found, daemon not running');
        return false;
      }
      
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
      if (isNaN(pid)) {
        logger.warn('Invalid PID in daemon PID file');
        return false;
      }
      
      logger.info('Stopping daemon process...', { pid });
      process.kill(pid, 'SIGTERM');
      
      // Wait for cleanup
      setTimeout(() => {
        if (fs.existsSync(DAEMON_PID_FILE)) {
          logger.debug('Removing daemon PID file after cleanup timeout');
          fs.unlinkSync(DAEMON_PID_FILE);
        }
      }, 1000);
      
      logger.info('Daemon stop signal sent');
      return true;
    } catch (error) {
      logger.error('Failed to stop daemon', { error: error.message });
      return false;
    }
  }
}

export { WebLogsDaemon, DAEMON_CONFIG_FILE };
