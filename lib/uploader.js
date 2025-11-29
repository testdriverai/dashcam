import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import { logger, logFunctionCall } from './logger.js';
import path from 'path';
import { auth } from './auth.js';
import got from 'got';
import { getSystemInfo } from './systemInfo.js';
import { API_ENDPOINT } from './config.js';

class Uploader {
  constructor() {
    this.uploadCallbacks = new Map();
  }

  createS3Client(sts) {
    const logExit = logFunctionCall('createS3Client', { region: sts.region });
    
    logger.verbose('Creating S3 client', {
      region: sts.region,
      fallbackRegion: 'us-east-2',
      bucket: sts.bucket,
      hasAccessKey: !!sts.accessKeyId,
      hasSecretKey: !!sts.secretAccessKey,
      hasSessionToken: !!sts.sessionToken
    });
    
    const clientRegion = sts.region || 'us-east-2';
    
    const client = new S3Client({
      credentials: {
        accessKeyId: sts.accessKeyId,
        secretAccessKey: sts.secretAccessKey,
        sessionToken: sts.sessionToken
      },
      region: clientRegion,
      maxAttempts: 3
    });
    
    logger.debug('S3 client created', { 
      configuredRegion: clientRegion,
      bucket: sts.bucket 
    });
    
    logExit();
    return client;
  }

  generateUploadParams(sts, fileType, extension) {
    // Use the key from STS directly - it already includes proper extension
    const key = sts.file;
    
    logger.debug('Generating upload params:', {
      bucket: sts.bucket,
      key,
      contentType: `${fileType}/${extension}`
    });

    return {
      Bucket: sts.bucket,
      Key: key,
      ContentType: `${fileType}/${extension}`,
      ACL: 'private'
    };
  }

  async uploadFile(sts, clip, file, fileType, extension) {
    const logExit = logFunctionCall('uploadFile', { fileType, extension, file });
    
    logger.info(`Starting upload of ${fileType}`, { 
      file: path.basename(file),
      fileType,
      extension,
      clipId: clip.id 
    });

    const client = this.createS3Client(sts);
    const uploadParams = this.generateUploadParams(sts, fileType, extension);
    
    // Get file stats for logging
    const fileStats = fs.statSync(file);
    logger.verbose('File upload details', {
      fileSizeBytes: fileStats.size,
      fileSizeMB: (fileStats.size / (1024 * 1024)).toFixed(2),
      bucket: sts.bucket,
      key: uploadParams.Key,
      contentType: uploadParams.ContentType
    });
    
    const fileStream = fs.createReadStream(file);

    try {
      const upload = new Upload({
        client,
        params: {
          ...uploadParams,
          Body: fileStream
        },
        partSize: 20 * 1024 * 1024, // 20 MB
        queueSize: 5
      });

      upload.on('httpUploadProgress', (progress) => {
        if (progress.loaded && progress.total) {
          const percent = Math.round((progress.loaded / progress.total) * 100);
          const speedMBps = progress.loaded / (1024 * 1024) / ((Date.now() - upload.startTime) / 1000);
          
          if (percent % 10 === 0) { // Log every 10%
            logger.verbose(`Upload ${fileType} progress: ${percent}%`, {
              loaded: progress.loaded,
              total: progress.total,
              speedMBps: speedMBps.toFixed(2)
            });
            
            // Also output to console for user feedback
            if (fileType === 'video') {
              console.log(`Uploading video: ${percent}%`);
            }
          }
          
          // Call progress callback if registered
          const callbacks = this.uploadCallbacks.get(clip.id);
          if (callbacks?.onProgress) {
            callbacks.onProgress(percent);
          }
        }
      });

      upload.startTime = Date.now();
      const result = await upload.done();
      const uploadDuration = (Date.now() - upload.startTime) / 1000;
      
      if (extension !== 'png') {
        console.log(`Uploaded ${fileType} successfully (${uploadDuration.toFixed(1)}s)`);
        logger.info(`Successfully uploaded ${fileType}`, {
          key: result.Key,
          location: result.Location,
          duration: `${uploadDuration.toFixed(1)}s`,
          averageSpeed: `${(fileStats.size / (1024 * 1024) / uploadDuration).toFixed(2)} MB/s`
        });
        
        // Call complete callback if registered
        const callbacks = this.uploadCallbacks.get(clip.id);
        if (callbacks?.onComplete) {
          callbacks.onComplete(result);
        }
      }

      // Don't delete files here - let the main upload function handle cleanup
      logExit();
      return result;
    } catch (error) {
      console.error(`Failed to upload ${fileType}: ${error.message}`);
      logger.error('Upload error:', { 
        fileType,
        file: path.basename(file),
        error: error.message,
        code: error.code,
        statusCode: error.$metadata?.httpStatusCode,
        requestId: error.$metadata?.requestId,
        stack: error.stack 
      });
      
      // Don't delete files on error - let the main upload function handle cleanup
      logExit();
      throw error;
    } finally {
      fileStream.destroy();
    }
  }

  // Methods that match the desktop app's interface
  async uploadVideo(meta, sts, clip) {
    const file = clip.file;
    await this.uploadFile(sts, clip, file, 'video', 'webm');
  }

  async uploadLog(app, sts, clip) {
    const file = app.trimmedFileLocation;
    await this.uploadFile(sts, clip, file, 'log', 'jsonl');
  }

  // Register callbacks for progress and completion
  registerCallbacks(clipId, { onProgress, onComplete }) {
    this.uploadCallbacks.set(clipId, { onProgress, onComplete });
  }

  // Remove callbacks
  clearCallbacks(clipId) {
    this.uploadCallbacks.delete(clipId);
  }
}

// Create a singleton instance
const uploader = new Uploader();

// Export a simplified upload function for CLI use
export async function upload(filePath, metadata = {}) {
  const logExit = logFunctionCall('upload', { filePath, metadata });
  
  const extension = path.extname(filePath).substring(1);
  const fileType = extension === 'webm' ? 'video' : 'log';
  
  // Get current date for default title if none provided
  const defaultTitle = `Recording ${new Date().toLocaleString()}`;
  
  logger.info('Starting upload process', {
    filePath: path.basename(filePath),
    fileType,
    extension,
    title: metadata.title || defaultTitle,
    hasProject: !!metadata.project
  });

  // Collect system information
  logger.debug('Collecting system information...');
  const systemInfo = await getSystemInfo();
  logger.verbose('System information collected for upload', {
    cpuBrand: systemInfo.cpu?.brand,
    osDistro: systemInfo.os?.distro,
    totalMemGB: systemInfo.mem?.total ? (systemInfo.mem.total / (1024 * 1024 * 1024)).toFixed(2) : 'unknown'
  });

  // Handle project ID - use provided project or fetch first available project
  let projectId = metadata.project;
  if (!projectId) {
    logger.debug('No project ID provided, fetching user projects...');
    try {
      const projects = await auth.getProjects();
      if (projects && projects.length > 0) {
        projectId = projects[0].id;
        logger.info('Automatically selected first project', {
          projectId,
          projectName: projects[0].name || 'Unknown'
        });
      } else {
        logger.warn('No projects found for user, proceeding without project ID');
      }
    } catch (error) {
      logger.warn('Failed to fetch projects, proceeding without project ID', {
        error: error.message
      });
    }
  } else {
    logger.debug('Using provided project ID', { projectId });
  }

  // First, create a replay in the cloud (like the desktop app does)
  // Note: Performance data is uploaded separately to S3 as JSONL to reduce DB storage
  const replayConfig = {
    duration: metadata.duration || 0,
    apps: metadata.apps && metadata.apps.length > 0 ? metadata.apps : ['Screen Recording'], // Use tracked apps or fallback
    title: metadata.title || defaultTitle,
    system: systemInfo, // Include system information
    clientStartDate: metadata.clientStartDate || Date.now() // Use actual recording start time
    // performance data is now uploaded to S3 separately
  };

  // Add project if we have one
  if (projectId) {
    replayConfig.project = projectId;
  }

  if (metadata.description) {
    replayConfig.description = metadata.description;
  }

  logger.verbose('Creating replay with config', {
    ...replayConfig,
    performanceDataWillBeUploaded: !!metadata.performanceFile
  });

  console.log('Creating replay on server...');
  logger.info('Creating replay', {
    title: replayConfig.title,
    duration: replayConfig.duration,
    apps: replayConfig.apps,
    hasPerformanceFile: !!metadata.performanceFile
  });

  // Create the replay first
  const token = await auth.getToken();
  
  let newReplay;
  try {
    logger.debug('Sending replay creation request...', { apiEndpoint: API_ENDPOINT });
    newReplay = await got.post(`${API_ENDPOINT}/api/v1/replay`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      json: replayConfig,
      timeout: 30000
    }).json();

    console.log('Replay created successfully');
    logger.info('Replay created successfully', {
      replayId: newReplay.replay.id,
      shareKey: newReplay.replay.shareKey,
      shareLink: newReplay.replay.shareLink
    });
  } catch (error) {
    console.error('Failed to create replay on server');
    logger.error('Failed to create replay', {
      status: error.response?.statusCode,
      statusText: error.response?.statusMessage,
      body: error.response?.body,
      message: error.message,
      replayConfig: replayConfig
    });
    throw error;
  }

  // Create a clip object that matches what the desktop app expects
  const clip = {
    id: Date.now().toString(),
    file: filePath,
    title: metadata.title || defaultTitle,
    description: metadata.description || '',
    project: projectId || undefined,
    duration: metadata.duration || 0,
    clientStartDate: metadata.clientStartDate || Date.now() // Use actual recording start time
  };

  // Get STS credentials with replay data (like the desktop app)
  const replayData = {
    id: newReplay.replay.id,
    duration: metadata.duration || 0,
    apps: metadata.apps && metadata.apps.length > 0 ? metadata.apps : ['Screen Recording'], // Use tracked apps or fallback
    title: metadata.title || defaultTitle,
    icons: metadata.icons || [] // Include icons metadata for STS token generation
  };

  // Add project if we have one
  if (projectId) {
    replayData.project = projectId;
  }

  logger.verbose('Getting STS credentials for replay', { replayId: newReplay.replay.id });
  console.log('Getting upload credentials...');
  const sts = await auth.getStsCredentials(replayData);

  console.log('Starting file uploads...');
  logger.verbose('STS credentials received', {
    hasVideo: !!sts.video,
    hasImage: !!sts.image,
    hasGif: !!sts.gif
  });

  // Upload all assets
  const promises = [
    // Upload the main video as mp4 (even though it's actually webm)
    uploader.uploadFile(sts.video, clip, filePath, 'video', 'mp4')
  ];

  // Track files to cleanup after successful upload
  const filesToCleanup = [filePath];

  // Upload GIF if available
  if (metadata.gifPath && fs.existsSync(metadata.gifPath)) {
    logger.debug('Adding GIF upload to queue', { gifPath: metadata.gifPath });
    promises.push(uploader.uploadFile(sts.gif, clip, metadata.gifPath, 'image', 'gif'));
    filesToCleanup.push(metadata.gifPath);
  }

  // Upload snapshot if available
  if (metadata.snapshotPath && fs.existsSync(metadata.snapshotPath)) {
    logger.debug('Adding snapshot upload to queue', { snapshotPath: metadata.snapshotPath });
    promises.push(uploader.uploadFile(sts.image, clip, metadata.snapshotPath, 'image', 'png'));
    filesToCleanup.push(metadata.snapshotPath);
  }

  logger.info('Starting asset uploads', { totalUploads: promises.length });
  console.log(`Uploading ${promises.length} file(s)...`);

  // Upload performance data to S3 if available (uses STS from replay-upload)
  if (metadata.performanceFile && fs.existsSync(metadata.performanceFile) && sts.performance) {
    logger.debug('Adding performance data upload to queue', { performanceFile: metadata.performanceFile });
    promises.push(uploader.uploadFile(sts.performance, clip, metadata.performanceFile, 'application', 'jsonl'));
    filesToCleanup.push(metadata.performanceFile);
    logger.info('Performance data upload queued', { file: metadata.performanceFile });
  }
  
  // Process and upload logs if available
  if (metadata.logs && metadata.logs.length > 0) {
    logger.debug('Processing logs for upload', { logCount: metadata.logs.length });
    
    // Import trimLogs function
    const { trimLogs } = await import('./logs/index.js');
    
    // Trim logs to recording duration
    const recordingStartTime = metadata.clientStartDate || Date.now();
    const recordingEndTime = recordingStartTime + (metadata.duration || 0);
    
    logger.debug('Trimming logs', {
      startTime: recordingStartTime,
      endTime: recordingEndTime,
      duration: metadata.duration
    });
    
    const trimmedLogs = await trimLogs(
      metadata.logs,
      0, // startMS (relative to recording start)
      metadata.duration || 0, // endMS 
      recordingStartTime, // clientStartDate
      newReplay.replay.id // clipId
    );
    
    logger.debug('Logs trimmed', { 
      trimmedCount: trimmedLogs.length,
      logsWithContent: trimmedLogs.filter(log => log.count > 0).length
    });
    
    // Upload each log file that has content
    for (const logStatus of trimmedLogs) {
      if (logStatus.count > 0 && logStatus.trimmedFileLocation && fs.existsSync(logStatus.trimmedFileLocation)) {
        try {
          // Use the name from the status, or a default descriptive name
          // The name is what shows in the "App" dropdown, not the file path
          let logName = logStatus.name || 'File Logs';
          
          logger.debug('Creating log STS credentials', {
            name: logName,
            type: logStatus.type,
            count: logStatus.count
          });
          
          const logSts = await auth.createLogSts(
            newReplay.replay.id,
            logStatus.id || `log-${Date.now()}`,
            logName,
            logStatus.type || 'application'
          );
          
          logger.debug('Uploading log file', {
            file: path.basename(logStatus.trimmedFileLocation),
            size: fs.statSync(logStatus.trimmedFileLocation).size
          });
          
          promises.push(
            uploader.uploadFile(logSts, clip, logStatus.trimmedFileLocation, 'log', 'jsonl')
          );
          
          // Add to cleanup list
          filesToCleanup.push(logStatus.trimmedFileLocation);
        } catch (error) {
          logger.warn('Failed to upload log', {
            logId: logStatus.id,
            error: error.message
          });
        }
      }
    }
    
    logger.info('Added log uploads to queue', { 
      totalUploads: promises.length,
      logUploads: promises.length - (metadata.gifPath ? 2 : 1) - (metadata.snapshotPath ? 1 : 0)
    });
  }

  logger.debug('Waiting for all uploads to complete...');
  console.log('Finalizing uploads...');
  await Promise.all(promises);

  // Clean up uploaded files after all uploads complete successfully
  logger.debug('Cleaning up uploaded files', { files: filesToCleanup.map(f => path.basename(f)) });
  
  for (const file of filesToCleanup) {
    try {
      fs.unlinkSync(file);
      logger.debug(`Deleted uploaded file: ${path.basename(file)}`);
    } catch (err) {
      logger.warn(`Failed to delete file: ${path.basename(file)}`, { error: err.message });
    }
  }

  // Publish the replay (like the desktop app does)
  logger.debug('Publishing replay...');
  console.log('Publishing replay...');
  
  try {
    await got.post(`${API_ENDPOINT}/api/v1/replay/publish`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      json: { id: newReplay.replay.id },
      timeout: 30000
    }).json();
    
    console.log('Replay published successfully');
  } catch (error) {
    console.error('Failed to publish replay:', error.message);
    logger.error('Publish error:', {
      message: error.message,
      statusCode: error.response?.statusCode,
      body: error.response?.body
    });
    throw error;
  }

  logger.info('Upload process completed successfully', {
    replayId: newReplay.replay.id,
    shareLink: newReplay.replay.shareLink
  });

  logExit();
  
  const shareLink = newReplay.replay.shareLink;
  
  return {
    replay: newReplay.replay,
    shareLink: shareLink
  };
}

export { uploader };
