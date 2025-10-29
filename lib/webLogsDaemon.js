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
    if (this.isRunning) return;

    try {
      // Start WebSocket server
      await server.start();
      logger.info(`WebSocket server started on port ${server.port}`);

      // Create web tracker manager
      this.webTrackerManager = new WebTrackerManager(server);
      
      // Load existing config if available
      const config = this.loadConfig();
      this.webWatchTracker = new WebLogsTracker({
        config,
        webTrackerManager: this.webTrackerManager
      });

      this.isRunning = true;
      
      // Write PID file
      fs.writeFileSync(DAEMON_PID_FILE, process.pid.toString());
      
      logger.info('Web logs daemon started successfully');

      // Keep process alive
      process.on('SIGTERM', () => this.stop());
      process.on('SIGINT', () => this.stop());

    } catch (error) {
      logger.error('Failed to start web logs daemon', { error });
      throw error;
    }
  }

  stop() {
    if (!this.isRunning) return;

    logger.info('Stopping web logs daemon...');
    
    if (this.webWatchTracker) {
      this.webWatchTracker.destroy();
    }
    
    if (this.webTrackerManager) {
      this.webTrackerManager.destroy();
    }
    
    server.stop();
    
    // Remove PID file
    if (fs.existsSync(DAEMON_PID_FILE)) {
      fs.unlinkSync(DAEMON_PID_FILE);
    }
    
    this.isRunning = false;
    logger.info('Web logs daemon stopped');
    process.exit(0);
  }

  updateConfig(config) {
    if (this.webWatchTracker) {
      this.webWatchTracker.updateConfig(config);
    }
    this.saveConfig(config);
  }

  loadConfig() {
    try {
      if (fs.existsSync(DAEMON_CONFIG_FILE)) {
        const data = fs.readFileSync(DAEMON_CONFIG_FILE, 'utf8');
        return JSON.parse(data);
      }
    } catch (error) {
      logger.error('Failed to load daemon config', { error });
    }
    return {};
  }

  saveConfig(config) {
    try {
      fs.writeFileSync(DAEMON_CONFIG_FILE, JSON.stringify(config, null, 2));
    } catch (error) {
      logger.error('Failed to save daemon config', { error });
    }
  }

  static isDaemonRunning() {
    try {
      if (!fs.existsSync(DAEMON_PID_FILE)) return false;
      
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
      if (isNaN(pid)) return false;
      
      // Check if process is still running
      process.kill(pid, 0);
      return true;
    } catch (error) {
      // Process doesn't exist or we don't have permission
      return false;
    }
  }

  static async ensureDaemonRunning() {
    if (!WebLogsDaemon.isDaemonRunning()) {
      logger.info('Starting web logs daemon...');
      
      // Spawn daemon process
      const { spawn } = await import('child_process');
      const child = spawn('node', [
        path.join(process.cwd(), 'bin/dashcam.js'),
        '_internal_daemon'
      ], {
        detached: true,
        stdio: 'ignore'
      });
      
      child.unref();
      
      // Wait a moment for daemon to start
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      if (!WebLogsDaemon.isDaemonRunning()) {
        throw new Error('Failed to start web logs daemon');
      }
    }
  }

  static stopDaemon() {
    try {
      if (!fs.existsSync(DAEMON_PID_FILE)) return false;
      
      const pid = parseInt(fs.readFileSync(DAEMON_PID_FILE, 'utf8').trim());
      if (isNaN(pid)) return false;
      
      process.kill(pid, 'SIGTERM');
      
      // Wait for cleanup
      setTimeout(() => {
        if (fs.existsSync(DAEMON_PID_FILE)) {
          fs.unlinkSync(DAEMON_PID_FILE);
        }
      }, 1000);
      
      return true;
    } catch (error) {
      logger.error('Failed to stop daemon', { error });
      return false;
    }
  }
}

export { WebLogsDaemon, DAEMON_CONFIG_FILE };
