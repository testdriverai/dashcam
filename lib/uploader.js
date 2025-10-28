import { S3Client } from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import fs from 'fs';
import { logger, logFunctionCall } from './logger.js';
import path from 'path';
import { auth } from './auth.js';
import got from 'got';

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

      fs.unlink(file, (err) => {
        if (err) {
          logger.warn(`Failed to delete file after upload: ${file}`, { error: err.message });
        } else {
          logger.debug(`Deleted file after successful upload: ${file}`);
        }
      });

      logExit();
      return result;
    } catch (error) {
      logger.error('Upload error:', { 
        fileType,
        file: path.basename(file),
        error: error.message,
        stack: error.stack 
      });
      
      fs.unlink(file, (err) => {
        if (err) {
          logger.warn(`Failed to delete file after upload error: ${file}`, { error: err.message });
        } else {
          logger.debug(`Deleted file after upload error: ${file}`);
        }
      });
      
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
  const replayConfig = {
    duration: metadata.duration || 0,
    apps: metadata.apps && metadata.apps.length > 0 ? metadata.apps : ['Screen Recording'], // Use tracked apps or fallback
    title: metadata.title || defaultTitle,
    system: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    },
    clientStartDate: metadata.clientStartDate || Date.now() // Use actual recording start time
  };

  // Add project if we have one
  if (projectId) {
    replayConfig.project = projectId;
  }

  if (metadata.description) {
    replayConfig.description = metadata.description;
  }

  logger.verbose('Creating replay with config', replayConfig);

  logger.info('Creating replay', replayConfig);

  // Create the replay first
  const token = await auth.getToken();
  
  let newReplay;
  try {
    newReplay = await got.post('https://api.testdriver.ai/api/v1/replay', {
      headers: {
        Authorization: `Bearer ${token}`
      },
      json: replayConfig,
      timeout: 30000
    }).json();

    logger.info('Replay created successfully', {
      replayId: newReplay.replay.id,
      shareKey: newReplay.replay.shareKey,
      shareLink: newReplay.replay.shareLink
    });
  } catch (error) {
    logger.error('Failed to create replay', {
      status: error.response?.statusCode,
      statusText: error.response?.statusMessage,
      body: error.response?.body,
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
  const sts = await auth.getStsCredentials(replayData);

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

  // Upload GIF if available
  if (metadata.gifPath && fs.existsSync(metadata.gifPath)) {
    logger.debug('Adding GIF upload to queue', { gifPath: metadata.gifPath });
    promises.push(uploader.uploadFile(sts.gif, clip, metadata.gifPath, 'image', 'gif'));
  }

  // Upload snapshot if available
  if (metadata.snapshotPath && fs.existsSync(metadata.snapshotPath)) {
    logger.debug('Adding snapshot upload to queue', { snapshotPath: metadata.snapshotPath });
    promises.push(uploader.uploadFile(sts.image, clip, metadata.snapshotPath, 'image', 'png'));
  }

  logger.info('Starting asset uploads', { totalUploads: promises.length });
  await Promise.all(promises);

  // Publish the replay (like the desktop app does)
  logger.debug('Publishing replay...');
  await got.post('https://api.testdriver.ai/api/v1/replay/publish', {
    headers: {
      Authorization: `Bearer ${token}`
    },
    json: { id: newReplay.replay.id },
    timeout: 30000
  }).json();

  logger.info('Upload process completed successfully', {
    replayId: newReplay.replay.id,
    shareLink: newReplay.replay.shareLink
  });

  logExit();
  return {
    replay: newReplay.replay,
    shareLink: newReplay.replay.shareLink
  };
}

export { uploader };
