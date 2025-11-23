#!/usr/bin/env node
import { program } from 'commander';
import { auth } from '../lib/auth.js';
import { upload } from '../lib/uploader.js';
import { logger, setVerbose } from '../lib/logger.js';
import { APP } from '../lib/config.js';
import { createPattern } from '../lib/tracking.js';
import { processManager } from '../lib/processManager.js';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import path from 'path';
import fs from 'fs';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Ensure config directory exists
if (!fs.existsSync(APP.configDir)) {
  fs.mkdirSync(APP.configDir, { recursive: true });
}

// Ensure recordings directory exists
if (!fs.existsSync(APP.recordingsDir)) {
  fs.mkdirSync(APP.recordingsDir, { recursive: true });
}

// Handle graceful shutdown on terminal close or process termination
// This prevents orphaned FFmpeg processes and ensures clean exit
let isShuttingDown = false;

async function gracefulShutdown(signal) {
  if (isShuttingDown) {
    logger.debug('Shutdown already in progress, ignoring additional signal', { signal });
    return;
  }
  
  isShuttingDown = true;
  logger.info('Received shutdown signal, cleaning up...', { signal });
  
  try {
    // Check if there's an active recording and stop it
    if (processManager.isRecordingActive()) {
      logger.info('Stopping active recording before exit...');
      await processManager.stopActiveRecording().catch(err => {
        logger.warn('Failed to stop recording during shutdown', { error: err.message });
      });
    }
    
    logger.info('Cleanup complete, exiting gracefully');
    process.exit(0);
  } catch (error) {
    logger.error('Error during graceful shutdown', { error: error.message });
    process.exit(1);
  }
}

// Register signal handlers for graceful shutdown
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));

// Handle uncaught errors to prevent crashes
process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', { 
    error: error.message, 
    stack: error.stack 
  });
  gracefulShutdown('uncaughtException');
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection', { 
    reason: reason instanceof Error ? reason.message : reason,
    stack: reason instanceof Error ? reason.stack : undefined
  });
});

program
  .name('dashcam')
  .description('Capture the steps to reproduce every bug.')
  .version(APP.version)
  .option('-v, --verbose', 'Enable verbose logging output')
  .hook('preAction', (thisCommand) => {
    // Enable verbose logging if the flag is set
    if (thisCommand.opts().verbose) {
      setVerbose(true);
      logger.info('Verbose logging enabled');
    }
  });

// Add a dedicated version command that shows more details
program
  .command('version')
  .description('Show version information')
  .action(() => {
    const packageJson = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    console.log(`Dashcam CLI v${packageJson.version}`);
    console.log(`Node.js ${process.version}`);
    console.log(`Platform: ${process.platform} ${process.arch}`);
    process.exit(0);
  });

program
  .command('auth')
  .description("Authenticate the dashcam desktop using a team's apiKey")
  .argument('<api-key>', 'Your team API key')
  .action(async (apiKey, options, command) => {
    try {
      logger.verbose('Starting authentication process', { 
        apiKeyProvided: !!apiKey,
        globalOptions: command.parent.opts()
      });
      
      await auth.login(apiKey);
      console.log('Successfully authenticated with API key');
      process.exit(0);
    } catch (error) {
      console.error('Authentication failed:', error.message);
      logger.error('Authentication failed with details:', {
        error: error.message,
        stack: error.stack
      });
      process.exit(1);
    }
  });

program
  .command('logout')
  .description('Logout from your Dashcam account')
  .action(async () => {
    try {
      await auth.logout();
      console.log('Successfully logged out');
      process.exit(0);
    } catch (error) {
      logger.error('Logout failed:', error);
      process.exit(1);
    }
  });

// Shared recording action to avoid duplication
async function recordingAction(options, command) {
  try {
    const silent = options.silent;
    const log = (...args) => { if (!silent) console.log(...args); };
    const logError = (...args) => { if (!silent) console.error(...args); };
    
    // Check if recording is already active
    if (processManager.isRecordingActive()) {
      const status = processManager.getActiveStatus();
      const duration = ((Date.now() - status.startTime) / 1000).toFixed(1);
      log('Recording already in progress');
      log(`Duration: ${duration} seconds`);
      log(`PID: ${status.pid}`);
      log('Use "dashcam stop" to stop the recording');
      process.exit(0);
    }

    // Check authentication
    if (!await auth.isAuthenticated()) {
      log('You need to login first. Run: dashcam auth <api-key>');
      process.exit(1);
    }

    // Check screen recording permissions (macOS only)
    const { ensurePermissions } = await import('../lib/permissions.js');
    const hasPermissions = await Promise.race([
      ensurePermissions(),
      new Promise((resolve) => setTimeout(() => {
        logger.warn('Permission check timed out, assuming permissions granted');
        resolve(true);
      }, 2000))
    ]);
    if (!hasPermissions) {
      log('\nCannot start recording without screen recording permission.');
      process.exit(1);
    }

    // Start recording in background mode
    log('Starting recording in background...');
    
    try {

      const timeoutPromise = new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Recording start timed out after 10 seconds')), 10000)
      );

      // Add timeout to prevent hanging
      const startRecordingPromise = processManager.startRecording({
        fps: parseInt(options.fps) || 10,
        audio: options.audio,
        output: options.output,
        title: options.title,
        description: options.description,
        project: options.project || options.k // Support both -p and -k for project
      });
      
      const result = await Promise.race([startRecordingPromise, timeoutPromise]);

      log(`Recording started successfully (PID: ${result.pid})`);
      log(`Output: ${result.outputPath}`);
      log('');
      log('Use "dashcam status" to check progress');
      log('Use "dashcam stop" to stop recording and upload');
      
      // Force immediate exit - don't wait for event loop to drain
      // This is necessary when called from scripts/automation
      setImmediate(() => {
        process.exit(0);
      });
    } catch (error) {
      logError('Failed to start recording:', error.message);
      process.exit(1);
    }
  } catch (error) {
    logger.error('Failed to start recording:', error);
    if (!options.silent) console.error('Failed to start recording:', error.message);
    process.exit(1);
  }
}

// 'create' command - creates a clip from current recording (like stop but with more options)
program
  .command('create')
  .description('Create a clip and output the resulting url or markdown. Will launch desktop app for local editing before publishing.')
  .option('-t, --title <string>', 'Title of the replay. Automatically generated if not supplied.')
  .option('-d, --description [text]', 'Replay markdown body')
  .option('--md', 'Returns code for a rich markdown image link.')
  .option('-k, --project <project>', 'Project ID to publish to')
  .action(async (options) => {
    try {
      if (!processManager.isRecordingActive()) {
        console.log('No active recording to create clip from');
        console.log('Start a recording first with "dashcam record" or "dashcam start"');
        process.exit(0);
      }

      const activeStatus = processManager.getActiveStatus();
      
      console.log('Creating clip from recording...');
      
      const result = await processManager.stopActiveRecording();
      
      if (!result) {
        console.log('Failed to stop recording');
        process.exit(1);
      }

      console.log('Recording stopped successfully');
      
      // Upload the recording
      console.log('Uploading clip...');
      try {
        const uploadResult = await upload(result.outputPath, {
          title: options.title || activeStatus?.options?.title || 'Dashcam Recording',
          description: options.description || activeStatus?.options?.description,
          project: options.project || options.k || activeStatus?.options?.project,
          duration: result.duration,
          clientStartDate: result.clientStartDate,
          apps: result.apps,
          icons: result.icons,
          gifPath: result.gifPath,
          snapshotPath: result.snapshotPath
        });
        
        // Output based on format option
        if (options.md) {
          const replayId = uploadResult.replay?.id;
          const shareKey = uploadResult.shareLink.split('share=')[1];
          console.log(`[![Dashcam - ${options.title || 'New Replay'}](https://replayable-api-production.herokuapp.com/replay/${replayId}/gif?shareKey=${shareKey})](${uploadResult.shareLink})`);
          console.log('');
          console.log(`Watch [Dashcam - ${options.title || 'New Replay'}](${uploadResult.shareLink}) on Dashcam`);
        } else {
          console.log(uploadResult.shareLink);
        }
      } catch (uploadError) {
        console.error('Upload failed:', uploadError.message);
        console.log('Recording saved locally:', result.outputPath);
      }
      
      process.exit(0);
    } catch (error) {
      logger.error('Error creating clip:', error);
      console.error('Failed to create clip:', error.message);
      process.exit(1);
    }
  });

// 'record' command - the main recording command with all options
program
  .command('record')
  .description('Start a recording terminal to be included in your dashcam video recording')
  .option('-a, --audio', 'Include audio in the recording')
  .option('-f, --fps <fps>', 'Frames per second (default: 10)', '10')
  .option('-o, --output <path>', 'Custom output path')
  .option('-t, --title <title>', 'Title for the recording')
  .option('-d, --description <description>', 'Description for the recording (supports markdown)')
  .option('-p, --project <project>', 'Project ID to upload the recording to')
  .option('-s, --silent', 'Silent mode - suppress all output')
  .action(recordingAction);

program
  .command('pipe')
  .description('Pipe command output to dashcam to be included in recorded video')
  .action(async () => {
    try {
      // Check if recording is active
      if (!processManager.isRecordingActive()) {
        console.error('No active recording. Start a recording first with "dashcam record" or "dashcam start"');
        process.exit(1);
      }

      // Read from stdin
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
        // Also output to stdout so pipe continues to work
        process.stdout.write(chunk);
      }
      const content = Buffer.concat(chunks).toString('utf-8');

      // Import the log tracker to add the piped content
      const { logsTrackerManager } = await import('../lib/logs/index.js');
      
      // Add piped content as a log entry
      logsTrackerManager.addPipedLog(content);
      
      process.exit(0);
    } catch (error) {
      logger.error('Failed to pipe content:', error);
      console.error('Failed to pipe content:', error.message);
      process.exit(1);
    }
  });

program
  .command('status')
  .description('Show current recording status')
  .action(() => {
    const activeStatus = processManager.getActiveStatus();
    if (activeStatus) {
      const duration = ((Date.now() - activeStatus.startTime) / 1000).toFixed(1);
      console.log('Recording in progress');
      console.log(`Duration: ${duration} seconds`);
      console.log(`PID: ${activeStatus.pid}`);
      console.log(`Started: ${new Date(activeStatus.startTime).toLocaleString()}`);
      if (activeStatus.options.title) {
        console.log(`Title: ${activeStatus.options.title}`);
      }
    } else {
      console.log('No active recording');
    }
    process.exit(0);
  });



// 'start' command - alias for record with simple instant replay mode
program
  .command('start')
  .description('Start instant replay recording on dashcam')
  .action(async () => {
    // Call recordingAction with minimal options for instant replay
    await recordingAction({ 
      fps: '30', 
      audio: false, 
      silent: false 
    }, null);
  });

program
  .command('track')
  .description('Add a logs config to Dashcam')
  .option('--name <name>', 'Name for the tracking configuration (required)')
  .option('--type <type>', 'Type of tracker: "application" or "web" (required)')
  .option('--pattern <pattern>', 'Pattern to track (can be used multiple times)', (value, previous) => {
    return previous ? previous.concat([value]) : [value];
  })
  .option('--web <pattern>', 'Web URL pattern to track (can use wildcards like *) - deprecated, use --type=web --pattern instead')
  .option('--app <pattern>', 'Application file pattern to track (can use wildcards like *) - deprecated, use --type=application --pattern instead')
  .action(async (options) => {
    try {
      // Support both old and new syntax
      // New syntax: --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"
      // Old syntax: --web <pattern> --app <pattern>
      
      if (options.type && options.pattern) {
        // New syntax validation
        if (!options.name) {
          console.error('Error: --name is required when using --type and --pattern');
          console.log('Example: dashcam track --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
          process.exit(1);
        }
        
        if (options.type !== 'web' && options.type !== 'application') {
          console.error('Error: --type must be either "web" or "application"');
          process.exit(1);
        }
        
        const config = {
          name: options.name,
          type: options.type,
          patterns: options.pattern,
          enabled: true
        };
        
        await createPattern(config);
        console.log(`${options.type === 'web' ? 'Web' : 'Application'} tracking pattern added successfully:`, options.name);
        console.log('Patterns:', options.pattern.join(', '));
        
      } else if (options.web || options.app) {
        // Old syntax for backward compatibility
        if (options.web) {
          const config = {
            name: options.name || 'Web Pattern',
            type: 'web',
            patterns: [options.web],
            enabled: true
          };
          
          await createPattern(config);
          console.log('Web tracking pattern added successfully:', options.web);
        }

        if (options.app) {
          const config = {
            name: options.name || 'App Pattern',
            type: 'application',
            patterns: [options.app],
            enabled: true
          };
          
          await createPattern(config);
          console.log('Application tracking pattern added successfully:', options.app);
        }
      } else {
        console.error('Error: Must provide either:');
        console.log('  --name --type --pattern (new syntax)');
        console.log('  --web or --app (old syntax)');
        console.log('\nExamples:');
        console.log('  dashcam track --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
        console.log('  dashcam track --web "*facebook.com*"');
        process.exit(1);
      }
      
      process.exit(0);
    } catch (error) {
      console.error('Failed to add tracking pattern:', error.message);
      process.exit(1);
    }
  });

program
  .command('stop')
  .description('Stop the current recording and wait for upload completion')
  .action(async () => {

    console.log('!!!! Updated Stop')

    try {
      // Enable verbose logging for stop command
      setVerbose(true);
      
      logger.debug('Stop command invoked', {
        platform: process.platform,
        cwd: process.cwd(),
        pid: process.pid,
        processDir: path.join(os.homedir(), '.dashcam-cli')
      });
      
      const isActive = processManager.isRecordingActive();
      logger.debug('Recording active check result', { isActive });
      
      if (!isActive) {
        console.log('No active recording to stop');
        
        const statusPath = path.join(os.homedir(), '.dashcam-cli', 'status.json');
          
        logger.warn('Stop command called but no active recording found', {
          platform: process.platform,
          statusFile: statusPath,
          statusFileExists: fs.existsSync(statusPath)
        });
        
        // Try to read and display status file for debugging
        try {
          if (fs.existsSync(statusPath)) {
            const statusContent = fs.readFileSync(statusPath, 'utf8');
            logger.debug('Status file contents', { content: statusContent });
            console.log('Status file exists but recording not detected as active');
            console.log('Status file location:', statusPath);
          } else {
            console.log('Status file does not exist');
            console.log('Expected status file location:', statusPath);
          }
        } catch (err) {
          logger.error('Failed to read status file for debugging', { error: err.message });
        }
        
        process.exit(0);
      }

      const activeStatus = processManager.getActiveStatus();
      const logFile = path.join(process.cwd(), '.dashcam', 'recording.log');

      console.log('Stopping recording...');
      logger.debug('Active status before stop:', activeStatus);
      
      try {
        logger.debug('Calling stopActiveRecording...');
        const result = await processManager.stopActiveRecording();
        
        if (!result) {
          console.log('Failed to stop recording');
          logger.error('stopActiveRecording returned null/false');
          process.exit(1);
        }

        console.log('Recording stopped successfully');
        logger.debug('Stop result:', result);
        
        // Try to read the recording result saved by the background process
        // This includes performance data and other tracking information
        const RECORDING_RESULT_FILE = path.join(os.homedir(), '.dashcam-cli', 'recording-result.json');
        let backgroundResult = null;
        if (fs.existsSync(RECORDING_RESULT_FILE)) {
          try {
            const resultData = fs.readFileSync(RECORDING_RESULT_FILE, 'utf8');
            backgroundResult = JSON.parse(resultData);
            logger.info('Loaded recording result from background process', {
              outputPath: backgroundResult.outputPath,
              duration: backgroundResult.duration,
              performanceSamples: backgroundResult.performance?.summary?.sampleCount || 0
            });
          } catch (error) {
            logger.warn('Failed to read background recording result', { error: error.message });
          }
        }
        
        // Reconstruct recording data from status and fix video with FFmpeg
        console.log('Processing recording...');
        logger.debug('Reconstructing recording data from status file');
        
        const { fixVideoContainer } = await import('../lib/recorder.js');
        
        // Get temp file path
        const tempFileInfoPath = path.join(os.tmpdir(), 'dashcam', 'temp-file.json');
        let tempFileInfo = null;
        try {
          tempFileInfo = JSON.parse(fs.readFileSync(tempFileInfoPath, 'utf8'));
        } catch (error) {
          logger.error('Failed to read temp file info', { error });
        }
        
        // Fallback: look for temp files in the same directory
        let tempFile = tempFileInfo?.tempFile;
        if (!tempFile || !fs.existsSync(tempFile)) {
          // Try to find any temp-*.webm file in the output directory
          const outputDir = path.dirname(result.outputPath);
          if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir);
            const tempFiles = files.filter(f => f.startsWith('temp-') && f.endsWith('.webm'));
            if (tempFiles.length > 0) {
              // Use the most recent temp file
              tempFiles.sort().reverse();
              tempFile = path.join(outputDir, tempFiles[0]);
              logger.info('Found temp file in output directory', { tempFile });
            }
          }
        }
        
        const outputPath = result.outputPath;
        
        // Verify we have a temp file to work with
        if (!tempFile) {
          console.error('No temp file found for recording');
          logger.error('Temp file missing', { 
            tempFileInfo, 
            outputDir: path.dirname(result.outputPath),
            expectedPattern: 'temp-*.webm'
          });
          process.exit(1);
        }
        
        // Fix the video with FFmpeg (handle incomplete recordings)
        logger.info('Fixing video with FFmpeg', { tempFile, outputPath });
        if (fs.existsSync(tempFile)) {
          try {
            await fixVideoContainer(tempFile, outputPath);
            logger.info('Video fixed successfully');
          } catch (error) {
            logger.warn('FFmpeg fix failed, using temp file as-is', { error: error.message });
            // If fix fails, just copy the temp file
            fs.copyFileSync(tempFile, outputPath);
          }
        } else {
          logger.warn('Temp file not found, using output path directly', { tempFile });
        }
        
        // Verify the output file exists before proceeding
        if (!fs.existsSync(outputPath)) {
          console.error('Recording file not found after processing');
          logger.error('Output file missing', { outputPath, tempFile, tempFileExists: fs.existsSync(tempFile) });
          process.exit(1);
        }
        
        logger.info('Output file ready for upload', { 
          outputPath, 
          size: fs.statSync(outputPath).size 
        });
        
        // Generate paths for additional assets
        const basePath = outputPath.substring(0, outputPath.lastIndexOf('.'));
        const gifPath = `${basePath}.gif`;
        const snapshotPath = `${basePath}.png`;
        
        // Create GIF and snapshot (non-blocking, don't fail if these fail)
        console.log('Creating preview assets...');
        const { createGif, createSnapshot } = await import('../lib/ffmpeg.js');
        
        // Add timeout wrapper to prevent hanging on large files
        const withTimeout = (promise, timeoutMs, name) => {
          return Promise.race([
            promise,
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs)
            )
          ]);
        };
        
        try {
          await Promise.all([
            withTimeout(
              createGif(outputPath, gifPath),
              30000, // 30 second timeout
              'GIF creation'
            ).catch(err => {
              logger.warn('Failed to create GIF', { error: err.message });
            }),
            withTimeout(
              createSnapshot(outputPath, snapshotPath, 0),
              10000, // 10 second timeout
              'Snapshot creation'
            ).catch(err => {
              logger.warn('Failed to create snapshot', { error: err.message });
            })
          ]);
          logger.debug('Preview assets created successfully');
        } catch (error) {
          logger.warn('Failed to create preview assets', { error: error.message });
        }
        
        // Collect logs and app tracking data
        console.log('Collecting tracking data...');
        
        // Get app tracking data
        const { applicationTracker } = await import('../lib/applicationTracker.js');
        const appTrackingResults = applicationTracker.stop();
        logger.info('Collected app tracking results', {
          apps: appTrackingResults.apps?.length || 0,
          icons: appTrackingResults.icons?.length || 0,
          events: appTrackingResults.events?.length || 0
        });
        
        // Get log tracking data - read directly from files since background process was killed
        const recordingDir = path.dirname(outputPath);
        let logTrackingResults = [];
        
        try {
          // Check for CLI logs file
          const cliLogsFile = path.join(recordingDir, 'dashcam_logs_cli.jsonl');
          if (fs.existsSync(cliLogsFile)) {
            const { jsonl } = await import('../lib/utilities/jsonl.js');
            const cliLogs = jsonl.read(cliLogsFile);
            if (cliLogs && cliLogs.length > 0) {
              logTrackingResults.push({
                type: 'cli',
                name: 'CLI Logs',
                fileLocation: cliLogsFile,
                count: cliLogs.length,
                trimmedFileLocation: cliLogsFile
              });
              logger.info('Found CLI logs', { count: cliLogs.length, file: cliLogsFile });
            }
          }
          
          // Check for web logs file
          const webLogsFile = path.join(recordingDir, 'dashcam_logs_web_events.jsonl');
          if (fs.existsSync(webLogsFile)) {
            const { jsonl } = await import('../lib/utilities/jsonl.js');
            const webLogs = jsonl.read(webLogsFile);
            if (webLogs && webLogs.length > 0) {
              // Load web config to get patterns
              const webConfigFile = path.join(process.cwd(), '.dashcam', 'web-config.json');
              let webPatterns = ['*']; // Default to all patterns
              if (fs.existsSync(webConfigFile)) {
                try {
                  const webConfig = JSON.parse(fs.readFileSync(webConfigFile, 'utf8'));
                  // Extract all patterns from all enabled configs
                  webPatterns = Object.values(webConfig)
                    .filter(config => config.enabled !== false)
                    .flatMap(config => config.patterns || []);
                  if (webPatterns.length === 0) {
                    webPatterns = ['*'];
                  }
                } catch (error) {
                  logger.warn('Failed to load web config for patterns', { error: error.message });
                }
              }
              
              logTrackingResults.push({
                type: 'web',
                name: 'Web Logs',
                fileLocation: webLogsFile,
                count: webLogs.length,
                trimmedFileLocation: webLogsFile,
                patterns: webPatterns // Include patterns for filtering
              });
              logger.info('Found web logs', { count: webLogs.length, file: webLogsFile, patterns: webPatterns });
            }
          }
          
          logger.info('Collected log tracking results', { 
            trackers: logTrackingResults.length,
            totalEvents: logTrackingResults.reduce((sum, result) => sum + result.count, 0)
          });
        } catch (error) {
          logger.warn('Failed to collect log tracking results', { error: error.message });
        }
        
        // Read performance data from file if available
        let performanceData = null;
        try {
          const performanceFile = path.join(recordingDir, 'performance.jsonl');
          if (fs.existsSync(performanceFile)) {
            logger.info('Found performance file, reading data', { file: performanceFile });
            
            // Read the file directly and parse samples
            const fileContent = fs.readFileSync(performanceFile, 'utf8');
            const lines = fileContent.trim().split('\n').filter(line => line.length > 0);
            const samples = lines.map(line => JSON.parse(line));
            
            logger.info('Parsed performance samples from file', { sampleCount: samples.length });
            
            // Calculate summary statistics
            if (samples.length > 0) {
              const firstSample = samples[0];
              const lastSample = samples[samples.length - 1];
              
              let totalProcessCPU = 0;
              let totalProcessMemory = 0;
              let totalSystemMemoryUsage = 0;
              let maxProcessCPU = 0;
              let maxProcessMemory = 0;
              let maxSystemMemoryUsage = 0;
              
              samples.forEach(sample => {
                const processCPU = sample.process?.cpu || 0;
                const processMemory = sample.process?.memory || 0;
                const systemMemoryUsage = sample.system?.memoryUsagePercent || 0;
                
                totalProcessCPU += processCPU;
                totalProcessMemory += processMemory;
                totalSystemMemoryUsage += systemMemoryUsage;
                
                maxProcessCPU = Math.max(maxProcessCPU, processCPU);
                maxProcessMemory = Math.max(maxProcessMemory, processMemory);
                maxSystemMemoryUsage = Math.max(maxSystemMemoryUsage, systemMemoryUsage);
              });
              
              const count = samples.length;
              const finalSample = samples[samples.length - 1];
              const totalBytesReceived = finalSample.network?.bytesReceived || 0;
              const totalBytesSent = finalSample.network?.bytesSent || 0;
              
              const summary = {
                durationMs: lastSample.timestamp - firstSample.timestamp,
                sampleCount: count,
                monitorInterval: 5000,
                avgProcessCPU: totalProcessCPU / count,
                maxProcessCPU,
                avgProcessMemoryBytes: totalProcessMemory / count,
                avgProcessMemoryMB: (totalProcessMemory / count) / (1024 * 1024),
                maxProcessMemoryBytes: maxProcessMemory,
                maxProcessMemoryMB: maxProcessMemory / (1024 * 1024),
                avgSystemMemoryUsagePercent: totalSystemMemoryUsage / count,
                maxSystemMemoryUsagePercent: maxSystemMemoryUsage,
                totalSystemMemoryBytes: firstSample.system?.totalMemory || 0,
                totalSystemMemoryGB: (firstSample.system?.totalMemory || 0) / (1024 * 1024 * 1024),
                totalBytesReceived,
                totalBytesSent,
                totalMBReceived: totalBytesReceived / (1024 * 1024),
                totalMBSent: totalBytesSent / (1024 * 1024)
              };
              
              performanceData = { samples, summary };
              
              logger.info('Calculated performance summary', {
                sampleCount: summary.sampleCount,
                avgCPU: summary.avgProcessCPU.toFixed(1),
                maxCPU: summary.maxProcessCPU.toFixed(1),
                avgMemoryMB: summary.avgProcessMemoryMB.toFixed(1)
              });
            }
          } else {
            logger.debug('No performance file found', { expectedPath: performanceFile });
          }
        } catch (error) {
          logger.warn('Failed to load performance data', { error: error.message, stack: error.stack });
        }
        
        // The recording is on disk and can be uploaded with full metadata
        const recordingResult = {
          outputPath,
          gifPath,
          snapshotPath,
          duration: result.duration,
          fileSize: fs.statSync(outputPath).size,
          clientStartDate: activeStatus.startTime,
          apps: backgroundResult?.apps || appTrackingResults.apps,
          icons: backgroundResult?.icons || appTrackingResults.icons,
          logs: backgroundResult?.logs || logTrackingResults,
          performance: performanceData || backgroundResult?.performance || null, // Prefer file data, fallback to background result
          title: activeStatus?.options?.title,
          description: activeStatus?.options?.description,
          project: activeStatus?.options?.project
        };
        
        logger.info('Recording result prepared for upload', {
          hasPerformanceData: !!recordingResult.performance,
          performanceSamples: recordingResult.performance?.summary?.sampleCount || 0,
          avgCPU: recordingResult.performance?.summary?.avgProcessCPU?.toFixed(1) || 'N/A',
          maxCPU: recordingResult.performance?.summary?.maxProcessCPU?.toFixed(1) || 'N/A'
        });
        
        if (!recordingResult || !recordingResult.outputPath) {
          console.error('Failed to process recording');
          logger.error('No recording result', { recordingResult });
          process.exit(1);
        }
        
        console.log('Uploading recording...');
        logger.debug('Recording result:', recordingResult);
        
        try {
          const uploadResult = await upload(recordingResult.outputPath, {
            title: recordingResult.title || activeStatus?.options?.title || 'Dashcam Recording',
            description: recordingResult.description || activeStatus?.options?.description,
            project: recordingResult.project || activeStatus?.options?.project,
            duration: recordingResult.duration,
            clientStartDate: recordingResult.clientStartDate,
            apps: recordingResult.apps,
            icons: recordingResult.icons,
            logs: recordingResult.logs,
            performance: recordingResult.performance, // Include performance data
            gifPath: recordingResult.gifPath,
            snapshotPath: recordingResult.snapshotPath
          });
          
          console.log('Watch your recording:', uploadResult.shareLink);
          logger.info('Upload succeeded');
          
          // Clean up the result file and recording result file
          processManager.cleanup();
          
          // Also clean up recording result file from background process
          const RECORDING_RESULT_FILE = path.join(os.homedir(), '.dashcam-cli', 'recording-result.json');
          if (fs.existsSync(RECORDING_RESULT_FILE)) {
            try {
              fs.unlinkSync(RECORDING_RESULT_FILE);
              logger.debug('Cleaned up recording result file');
            } catch (error) {
              logger.warn('Failed to clean up recording result file', { error: error.message });
            }
          }
        } catch (uploadError) {
          console.error('Upload failed:', uploadError.message);
          logger.error('Upload error details:', {
            message: uploadError.message,
            stack: uploadError.stack,
            code: uploadError.code,
            statusCode: uploadError.response?.statusCode
          });
          console.log('Recording saved locally:', recordingResult.outputPath);
        }
      } catch (error) {
        console.error('Failed to stop recording:', error.message);
        logger.error('Stop recording error details:', {
          message: error.message,
          stack: error.stack
        });
        process.exit(1);
      }
      
      process.exit(0);
    } catch (error) {
      logger.error('Error stopping recording:', error);
      console.error('Failed to stop recording:', error.message);
      process.exit(1);
    }
  });

program
  .command('logs')
  .description('Manage log tracking for recordings')
  .option('--add', 'Add a new log tracker')
  .option('--remove <id>', 'Remove a log tracker by ID')
  .option('--list', 'List all configured log trackers')
  .option('--status', 'Show log tracking status')
  .option('--view [directory]', 'View logs from recording directory (defaults to most recent in /tmp/dashcam/recordings)')
  .option('--name <name>', 'Name for the log tracker (required with --add)')
  .option('--type <type>', 'Type of tracker: "web" or "file" (required with --add)')
  .option('--pattern <pattern>', 'Pattern to track (can be used multiple times)', (value, previous) => {
    return previous ? previous.concat([value]) : [value];
  })
  .option('--file <file>', 'File path for file type trackers')
  .action(async (options) => {
    try {
      // Import logsTrackerManager only when needed to avoid unwanted initialization
      const { logsTrackerManager } = await import('../lib/logs/index.js');
      
      if (options.add) {
        // Validate required options for add
        if (!options.name) {
          console.error('Error: --name is required when adding a tracker');
          console.log('Example: dashcam logs --add --name=social --type=web --pattern="*facebook.com*"');
          process.exit(1);
        }
        if (!options.type) {
          console.error('Error: --type is required when adding a tracker (web or file)');
          process.exit(1);
        }
        if (options.type !== 'web' && options.type !== 'file') {
          console.error('Error: --type must be either "web" or "file"');
          process.exit(1);
        }

        if (options.type === 'web') {
          if (!options.pattern || options.pattern.length === 0) {
            console.error('Error: At least one --pattern is required for web trackers');
            console.log('Example: dashcam logs --add --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
            process.exit(1);
          }
          
          const webConfig = {
            id: options.name.toLowerCase().replace(/[^a-z0-9]/g, '-'),
            name: options.name,
            type: 'web',
            enabled: true,
            patterns: options.pattern
          };
          
          logsTrackerManager.addWebTracker(webConfig);
          console.log(`Added web tracker "${options.name}" with patterns:`, options.pattern);
        } else if (options.type === 'file') {
          if (!options.file) {
            console.error('Error: --file is required for file trackers');
            console.log('Example: dashcam logs --add --name=app-logs --type=file --file=/var/log/app.log');
            process.exit(1);
          }
          if (!fs.existsSync(options.file)) {
            console.error('Log file does not exist:', options.file);
            process.exit(1);
          }
          
          logsTrackerManager.addCliLogFile(options.file);
          console.log(`Added file tracker "${options.name}" for:`, options.file);
        }
      } else if (options.remove) {
        logsTrackerManager.removeTracker(options.remove);
        console.log('Removed tracker:', options.remove);
      } else if (options.list) {
        const status = logsTrackerManager.getStatus();
        console.log('Currently configured trackers:');
        
        if (status.cliFiles.length > 0) {
          console.log('\nFile trackers:');
          status.cliFiles.forEach((filePath, index) => {
            console.log(`  file-${index + 1}: ${filePath}`);
          });
        }
        
        if (status.webApps.length > 0) {
          console.log('\nWeb trackers:');
          status.webApps.forEach(app => {
            console.log(`  ${app.id}: ${app.name}`);
            console.log(`    Patterns: ${app.patterns.join(', ')}`);
          });
        }
        
        if (status.cliFiles.length === 0 && status.webApps.length === 0) {
          console.log('  (none configured)');
          console.log('\nExamples:');
          console.log('  dashcam logs --add --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
          console.log('  dashcam logs --add --name=app-logs --type=file --file=/var/log/app.log');
        }
      } else if (options.status) {
        const status = logsTrackerManager.getStatus();
        console.log('Log tracking status:');
        console.log(`  Active recording instances: ${status.activeInstances}`);
        console.log(`  File trackers: ${status.cliFilesCount}`);
        console.log(`  Web trackers: ${status.webAppsCount}`);
        console.log(`  Total recent events: ${status.totalEvents}`);
        console.log(`  Web daemon running: ${status.webDaemonRunning ? 'Yes' : 'No'}`);
        
        // Show WebSocket server info
        const { server } = await import('../lib/websocket/server.js');
        if (server.isListening.value) {
          console.log(`  WebSocket server: Listening on port ${server.port}`);
          console.log(`  WebSocket clients: ${server._socket?.clients?.size || 0} connected`);
        } else {
          console.log(`  WebSocket server: Not listening`);
        }
        
        if (status.fileTrackerStats.length > 0) {
          console.log('\n  File tracker activity (last minute):');
          status.fileTrackerStats.forEach(stat => {
            console.log(`    ${stat.filePath}: ${stat.count} events`);
          });
        }
        
        if (status.webApps.length > 0) {
          console.log('\n  Web tracker patterns:');
          status.webApps.forEach(app => {
            console.log(`    ${app.name}: ${app.patterns.join(', ')}`);
          });
        }
      } else if (options.view !== undefined) {
        // View logs from a recording directory
        const { jsonl } = await import('../lib/utilities/jsonl.js');
        
        let targetDir = options.view;
        
        // If no directory specified, find the most recent recording directory
        if (!targetDir || targetDir === true) {
          const recordingsDir = path.join(os.tmpdir(), 'dashcam', 'recordings');
          if (!fs.existsSync(recordingsDir)) {
            console.error('No recordings directory found at:', recordingsDir);
            process.exit(1);
          }
          
          const entries = fs.readdirSync(recordingsDir, { withFileTypes: true });
          const dirs = entries
            .filter(entry => entry.isDirectory())
            .map(entry => ({
              name: entry.name,
              path: path.join(recordingsDir, entry.name),
              mtime: fs.statSync(path.join(recordingsDir, entry.name)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime);
          
          if (dirs.length === 0) {
            console.error('No recording directories found in:', recordingsDir);
            process.exit(1);
          }
          
          targetDir = dirs[0].path;
          console.log('Viewing logs from most recent recording:', path.basename(targetDir));
        } else if (!fs.existsSync(targetDir)) {
          console.error('Directory does not exist:', targetDir);
          process.exit(1);
        }
        
        console.log('Directory:', targetDir);
        console.log('');
        
        // Check for CLI logs
        const cliLogsFile = path.join(targetDir, 'dashcam_logs_cli.jsonl');
        if (fs.existsSync(cliLogsFile)) {
          const cliLogs = jsonl.read(cliLogsFile);
          if (cliLogs && cliLogs.length > 0) {
            console.log(`📄 CLI Logs (${cliLogs.length} events):`);
            cliLogs.slice(0, 50).forEach((log, index) => {
              const timeSeconds = ((log.time || 0) / 1000).toFixed(2);
              const logFile = log.logFile || 'unknown';
              const content = (log.line || log.content || '').substring(0, 100);
              console.log(`  [${timeSeconds}s] ${logFile}: ${content}`);
            });
            if (cliLogs.length > 50) {
              console.log(`  ... and ${cliLogs.length - 50} more events`);
            }
            console.log('');
          }
        } else {
          console.log('📄 CLI Logs: No logs found');
          console.log('');
        }
        
        // Check for web logs
        const webLogsFile = path.join(targetDir, 'dashcam_logs_web_events.jsonl');
        if (fs.existsSync(webLogsFile)) {
          const webLogs = jsonl.read(webLogsFile);
          if (webLogs && webLogs.length > 0) {
            console.log(`🌐 Web Logs (${webLogs.length} events):`);
            
            // Group by event type
            const eventTypes = {};
            webLogs.forEach(log => {
              eventTypes[log.type] = (eventTypes[log.type] || 0) + 1;
            });
            
            console.log('  Event types:');
            Object.entries(eventTypes).forEach(([type, count]) => {
              console.log(`    ${type}: ${count}`);
            });
            console.log('');
            
            // Show first 20 events
            console.log('  Recent events:');
            webLogs.slice(0, 20).forEach((log, index) => {
              const timeSeconds = ((log.time || 0) / 1000).toFixed(2);
              const type = log.type || 'unknown';
              
              if (type === 'LOG_EVENT' || type === 'LOG_ERROR') {
                const message = log.payload?.message || '';
                console.log(`  [${timeSeconds}s] ${type}: ${message.substring(0, 80)}`);
              } else if (type.startsWith('NETWORK_')) {
                const url = log.payload?.url || '';
                console.log(`  [${timeSeconds}s] ${type}: ${url.substring(0, 80)}`);
              } else {
                console.log(`  [${timeSeconds}s] ${type}`);
              }
            });
            if (webLogs.length > 20) {
              console.log(`  ... and ${webLogs.length - 20} more events`);
            }
            console.log('');
          }
        } else {
          console.log('🌐 Web Logs: No logs found');
          console.log('');
        }
      } else {
        console.log('Please specify an action: --add, --remove, --list, --status, or --view');
        console.log('\nExamples:');
        console.log('  dashcam logs --add --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
        console.log('  dashcam logs --add --name=app-logs --type=file --file=/var/log/app.log');
        console.log('  dashcam logs --list');
        console.log('  dashcam logs --status');
        console.log('  dashcam logs --view                    # View logs from most recent recording');
        console.log('  dashcam logs --view /path/to/recording # View logs from specific directory');
        console.log('\nUse "dashcam logs --help" for more information');
      }
      
      // Exit successfully to prevent hanging
      process.exit(0);
    } catch (error) {
      logger.error('Error managing logs:', error);
      console.error('Failed to manage logs:', error.message);
      process.exit(1);
    }
  });

program
  .command('upload')
  .description('Upload a completed recording file or recover from interrupted recording')
  .argument('[filePath]', 'Path to the recording file to upload (optional)')
  .option('-t, --title <title>', 'Title for the recording')
  .option('-d, --description <description>', 'Description for the recording')
  .option('-p, --project <project>', 'Project ID to upload to')
  .option('--recover', 'Attempt to recover and upload from interrupted recording')
  .action(async (filePath, options) => {
    try {
      let targetFile = filePath;
      
      if (options.recover) {
        // Try to recover from interrupted recording
        const tempFileInfoPath = path.join(process.cwd(), '.dashcam', 'temp-file.json');
        
        if (fs.existsSync(tempFileInfoPath)) {
          console.log('Found interrupted recording, attempting recovery...');
          
          const tempFileInfo = JSON.parse(fs.readFileSync(tempFileInfoPath, 'utf8'));
          const tempFile = tempFileInfo.tempFile;
          
          if (fs.existsSync(tempFile) && fs.statSync(tempFile).size > 0) {
            console.log('Recovering recording from temp file...');
            
            // Import recorder to finalize the interrupted recording
            const { stopRecording } = await import('../lib/recorder.js');
            
            try {
              // This will attempt to finalize the temp file
              const result = await stopRecording();
              targetFile = result.outputPath;
              console.log('Recovery successful:', result.outputPath);
            } catch (error) {
              console.error('Recovery failed:', error.message);
              console.log('You can try uploading the temp file directly:', tempFile);
              targetFile = tempFile;
            }
            
            // Clean up temp file info after recovery attempt
            fs.unlinkSync(tempFileInfoPath);
          } else {
            console.log('No valid temp file found for recovery');
            process.exit(1);
          }
        } else {
          console.log('No interrupted recording found');
          process.exit(1);
        }
      }
      
      if (!targetFile) {
        console.error('Please provide a file path or use --recover option');
        console.log('Examples:');
        console.log('  dashcam upload /path/to/recording.mp4');
        console.log('  dashcam upload --recover');
        process.exit(1);
      }
      
      if (!fs.existsSync(targetFile)) {
        console.error('File not found:', targetFile);
        process.exit(1);
      }
      
      console.log('Uploading recording...');
      const uploadResult = await upload(targetFile, {
        title: options.title,
        description: options.description,
        project: options.project
      });
      
      console.log('> Upload complete! Share link:', uploadResult.shareLink);
      process.exit(0);
      
    } catch (error) {
      console.error('Upload failed:', error.message);
      process.exit(1);
    }
  });

program.parse();
