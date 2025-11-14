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

    // Check for piped input (description from stdin) if description option not set
    let description = options.description;
    if (!description && !process.stdin.isTTY) {
      const chunks = [];
      for await (const chunk of process.stdin) {
        chunks.push(chunk);
      }
      description = Buffer.concat(chunks).toString('utf-8');
    }

    // Check screen recording permissions (macOS only)
    const { ensurePermissions } = await import('../lib/permissions.js');
    const hasPermissions = await ensurePermissions();
    if (!hasPermissions) {
      log('\n⚠️  Cannot start recording without screen recording permission.');
      process.exit(1);
    }

    // Start recording in background mode
    log('Starting recording in background...');
    
    try {
      const result = await processManager.startRecording({
        fps: parseInt(options.fps) || 30,
        audio: options.audio,
        output: options.output,
        title: options.title,
        description: description,
        project: options.project || options.k // Support both -p and -k for project
      });

      log(`✅ Recording started successfully (PID: ${result.pid})`);
      log(`Output: ${result.outputPath}`);
      log('');
      log('Use "dashcam status" to check progress');
      log('Use "dashcam stop" to stop recording and upload');
      
      process.exit(0);
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
  .option('-d, --description [text]', 'Replay markdown body. This may also be piped in: `cat README.md | dashcam create`')
  .option('--md', 'Returns code for a rich markdown image link.')
  .option('-k, --project <project>', 'Project ID to publish to')
  .action(async (options) => {
    try {
      // Check for piped input (description from stdin)
      let description = options.description;
      if (!description && !process.stdin.isTTY) {
        const chunks = [];
        for await (const chunk of process.stdin) {
          chunks.push(chunk);
        }
        description = Buffer.concat(chunks).toString('utf-8');
      }

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
          description: description || activeStatus?.options?.description,
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
  .option('-f, --fps <fps>', 'Frames per second (default: 30)', '30')
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
        
        // Check if files still exist - if not, background process already uploaded
        const filesExist = fs.existsSync(result.outputPath) && 
                          (!result.gifPath || fs.existsSync(result.gifPath)) && 
                          (!result.snapshotPath || fs.existsSync(result.snapshotPath));
        
        if (!filesExist) {
          // Files were deleted, meaning background process uploaded
          // Wait for the upload result to be written
          logger.debug('Waiting for upload result from background process');
          await new Promise(resolve => setTimeout(resolve, 2000));
          
          // Try to read the upload result from the background process
          const uploadResult = processManager.readUploadResult();
          logger.debug('Upload result read attempt', { found: !!uploadResult, shareLink: uploadResult?.shareLink });
          
          if (uploadResult && uploadResult.shareLink) {
            console.log('📹 Watch your recording:', uploadResult.shareLink);
            // Clean up the result file now that we've read it
            processManager.cleanup();
          } else {
            console.log('✅ Recording uploaded (share link not available)');
            logger.warn('Upload result not available from background process');
          }
          
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
          
          console.log('📹 Watch your recording:', uploadResult.shareLink);
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
