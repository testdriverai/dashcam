import { LogsTracker } from './tracking/LogsTracker.js';
import { FileTrackerManager } from './tracking/FileTrackerManager.js';

// Create a shared file tracker manager for efficient resource usage
const fileTrackerManager = new FileTrackerManager();

// Create a singleton instance for watch-only mode (no directory)
const logTracker = new LogsTracker({ 
  config: {},
  fileTrackerManager 
});

// Helper function to create a new tracker for recording (with directory)
export function createRecordingTracker(directory, config = {}) {
  return new LogsTracker({
    config,
    directory,
    fileTrackerManager
  });
}

// Export the singleton for backwards compatibility
export { logTracker, fileTrackerManager };
