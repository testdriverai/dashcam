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

program
  .name('dashcam')
  .description('CLI version of Dashcam screen recorder')
  .version(APP.version)
  .option('-v, --verbose', 'Enable verbose logging output')
  .hook('preAction', (thisCommand) => {
    // Enable verbose logging if the flag is set
    if (thisCommand.opts().verbose) {
      setVerbose(true);
      logger.info('Verbose logging enabled');
    }
  });

program
  .command('auth')
  .description('Authenticate with TestDriver using an API key')
  .argument('<apiKey>', 'Your TestDriver API key')
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

program
  .command('record')
  .description('Start a background screen recording')
  .option('-a, --audio', 'Include audio in the recording')
  .option('-f, --fps <fps>', 'Frames per second (default: 30)', '30')
  .option('-o, --output <path>', 'Custom output path')
  .option('-t, --title <title>', 'Title for the recording')
  .option('-d, --description <description>', 'Description for the recording (supports markdown)')
  .option('-p, --project <project>', 'Project ID to upload the recording to')
  .action(async (options, command) => {
    try {
      // Check if recording is already active
      if (processManager.isRecordingActive()) {
        const status = processManager.getActiveStatus();
        const duration = ((Date.now() - status.startTime) / 1000).toFixed(1);
        console.log('Recording already in progress');
        console.log(`Duration: ${duration} seconds`);
        console.log(`PID: ${status.pid}`);
        console.log('Use "dashcam stop" to stop the recording');
        process.exit(0);
      }

      // Check authentication
      if (!await auth.isAuthenticated()) {
        console.log('You need to login first. Run: dashcam auth <api-key>');
        process.exit(1);
      }

      // Check screen recording permissions (macOS only)
      const { ensurePermissions } = await import('../lib/permissions.js');
      const hasPermissions = await ensurePermissions();
      if (!hasPermissions) {
        console.log('\n⚠️  Cannot start recording without screen recording permission.');
        process.exit(1);
      }

      // Always use background mode
      console.log('Starting recording...');
      
      try {
        const result = await processManager.startRecording({
          fps: parseInt(options.fps) || 30,
          audio: options.audio,
          output: options.output,
          title: options.title,
          description: options.description,
          project: options.project
        });

        console.log(`Recording started successfully (PID: ${result.pid})`);
        console.log(`Output: ${result.outputPath}`);
        console.log('Use "dashcam status" to check progress');
        console.log('Use "dashcam stop" to stop recording and upload');
        
        // Keep this process alive for background recording
        console.log('Recording is running in background...');
        
        // Set up signal handlers for graceful shutdown
        let isShuttingDown = false;
        const handleShutdown = async (signal) => {
          if (isShuttingDown) {
            console.log('Shutdown already in progress...');
            return;
          }
          isShuttingDown = true;
          
          console.log(`\nReceived ${signal}, stopping background recording...`);
          try {
            // Stop the recording using the recorder directly (not processManager)
            const { stopRecording } = await import('../lib/recorder.js');
            const stopResult = await stopRecording();
            
            if (stopResult) {
              console.log('Recording stopped:', stopResult.outputPath);
              
              // Import and call upload function with the correct format
              const { upload } = await import('../lib/uploader.js');
              
              console.log('Starting upload...');
              await upload(stopResult.outputPath, {
                title: options.title || 'Dashcam Recording',
                description: options.description || 'Recorded with Dashcam CLI',
                project: options.project,
                duration: stopResult.duration,
                clientStartDate: stopResult.clientStartDate,
                apps: stopResult.apps,
                logs: stopResult.logs,
                gifPath: stopResult.gifPath,
                snapshotPath: stopResult.snapshotPath
              });
              
              console.log('Upload completed successfully!');
            }
            
            // Clean up process files
            processManager.cleanup();
          } catch (error) {
            console.error('Error during shutdown:', error.message);
            logger.error('Error during shutdown:', error);
          }
          process.exit(0);
        };
        
        process.on('SIGINT', () => handleShutdown('SIGINT'));
        process.on('SIGTERM', () => handleShutdown('SIGTERM'));
        
        // Keep the process alive
        await new Promise(() => {});
      } catch (error) {
        console.error('Failed to start recording:', error.message);
        process.exit(1);
      }
    } catch (error) {
      logger.error('Failed to start recording:', error);
      console.error('Failed to start recording:', error.message);
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



program
  .command('track')
  .description('Track logs from web URLs or application files')
  .option('--web <pattern>', 'Web URL pattern to track (can use wildcards like *)')
  .option('--app <pattern>', 'Application file pattern to track (can use wildcards like *)')
  .option('--name <name>', 'Name for the tracking configuration')
  .action(async (options) => {
    try {
      // Validate that at least one pattern is provided
      if (!options.web && !options.app) {
        console.error('Error: Must provide either --web or --app pattern');
        process.exit(1);
      }

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
    try {
      // Enable verbose logging for stop command
      setVerbose(true);
      
      if (!processManager.isRecordingActive()) {
        console.log('No active recording to stop');
        process.exit(0);
      }

      const activeStatus = processManager.getActiveStatus();
      const logFile = path.join(process.cwd(), '.dashcam', 'recording.log');

      console.log('Stopping recording...');
      
      try {
        const result = await processManager.stopActiveRecording();
        
        if (!result) {
          console.log('Failed to stop recording');
          process.exit(1);
        }

        console.log('Recording stopped successfully');
        console.log('Output saved to:', result.outputPath);
        
        // Check if files still exist - if not, background process already uploaded
        const filesExist = fs.existsSync(result.outputPath) && 
                          (!result.gifPath || fs.existsSync(result.gifPath)) && 
                          (!result.snapshotPath || fs.existsSync(result.snapshotPath));
        
        if (!filesExist) {
          console.log('✅ Recording was already uploaded by background process');
          console.log('✅ Recording stopped and uploaded');
          process.exit(0);
        }
        
        // Always attempt to upload - let upload function find project if needed
        console.log('Uploading recording...');
        try {
          const uploadResult = await upload(result.outputPath, {
            title: activeStatus?.options?.title,
            description: activeStatus?.options?.description,
            project: activeStatus?.options?.project, // May be undefined, that's ok
            duration: result.duration,
            clientStartDate: result.clientStartDate,
            apps: result.apps,
            icons: result.icons,
            gifPath: result.gifPath,
            snapshotPath: result.snapshotPath
          });
          
          console.log('✅ Upload complete! Share link:', uploadResult.shareLink);
        } catch (uploadError) {
          console.error('Upload failed:', uploadError.message);
          console.log('Recording saved locally:', result.outputPath);
        }
      } catch (error) {
        console.error('Failed to stop recording:', error.message);
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
        
        if (status.fileTrackerStats.length > 0) {
          console.log('\n  File tracker activity (last minute):');
          status.fileTrackerStats.forEach(stat => {
            console.log(`    ${stat.filePath}: ${stat.count} events`);
          });
        }
      } else {
        console.log('Please specify an action: --add, --remove, --list, or --status');
        console.log('\nExamples:');
        console.log('  dashcam logs --add --name=social --type=web --pattern="*facebook.com*" --pattern="*twitter.com*"');
        console.log('  dashcam logs --add --name=app-logs --type=file --file=/var/log/app.log');
        console.log('  dashcam logs --list');
        console.log('  dashcam logs --status');
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
        console.log('  dashcam upload /path/to/recording.webm');
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
      
      console.log('✅ Upload complete! Share link:', uploadResult.shareLink);
      process.exit(0);
      
    } catch (error) {
      console.error('Upload failed:', error.message);
      process.exit(1);
    }
  });

program.parse();
