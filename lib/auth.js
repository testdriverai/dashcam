import got from 'got';
import { auth0Config, API_ENDPOINT } from './config.js';
import { logger, logFunctionCall } from './logger.js';
import { Store } from './store.js';

const tokenStore = new Store('auth0-store');
const TOKEN_KEY = 'tokens';

const auth = {
  async login(apiKey) {
    const logExit = logFunctionCall('auth.login');
    
    try {
      logger.info('Authenticating with API key');
      logger.verbose('Starting API key exchange', {
        apiKeyLength: apiKey?.length,
        hasApiKey: !!apiKey,
        apiEndpoint: API_ENDPOINT
      });
      
      // Exchange API key for token
      const { token } = await got.post(`${API_ENDPOINT}/auth/exchange-api-key`, {
        json: { apiKey },
        timeout: 30000 // 30 second timeout
      }).json();

      if (!token) {
        throw new Error('Failed to exchange API key for token');
      }

      logger.verbose('Successfully exchanged API key for token', {
        tokenLength: token.length,
        tokenPrefix: token.substring(0, 10) + '...'
      });

      // Get user info to verify the token works
      logger.debug('Fetching user information to validate token...');
      const user = await got.get(`${API_ENDPOINT}/api/v1/whoami`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 30000
      }).json();

      logger.verbose('User information retrieved', {
        userId: user.id,
        userEmail: user.email || 'not provided',
        userName: user.name || 'not provided'
      });

      // Store both token and user info
      const tokenData = {
        token,
        user,
        expires_at: Date.now() + (24 * 60 * 60 * 1000) // 24 hours
      };
      
      tokenStore.set(TOKEN_KEY, tokenData);

      logger.info('Successfully authenticated and stored token', {
        expiresAt: new Date(tokenData.expires_at).toISOString(),
        userId: user.id
      });
      
      logExit();
      return token;

    } catch (error) {
      logger.error('Authentication failed:', {
        message: error.message,
        statusCode: error.response?.statusCode,
        responseBody: error.response?.body
      });
      logExit();
      throw error;
    }
  },

  async logout() {
    try {
      tokenStore.delete(TOKEN_KEY);
      logger.info('Successfully logged out');
    } catch (error) {
      logger.error('Failed to logout:', error);
      throw error;
    }
  },

  async getToken() {
    const tokens = tokenStore.get(TOKEN_KEY);
    if (!tokens || Date.now() >= tokens.expires_at) {
      throw new Error('No valid token found. Please login with an API key first');
    }
    return tokens.token;
  },

  async isAuthenticated() {
    const tokens = tokenStore.get(TOKEN_KEY);
    return tokens && tokens.expires_at && Date.now() < tokens.expires_at;
  },

  async getProjects() {
    const logExit = logFunctionCall('auth.getProjects');
    
    logger.debug('Fetching user projects...');
    const token = await this.getToken();
    
    try {
      const response = await got.get(`${API_ENDPOINT}/api/v1/projects`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        timeout: 30000
      }).json();
      
      logger.verbose('Projects fetched successfully', {
        projectCount: response.length
      });
      
      logExit();
      return response;
    } catch (error) {
      logger.error('Failed to fetch projects:', {
        message: error.message,
        statusCode: error.response?.statusCode
      });
      logExit();
      throw error;
    }
  },

  async getStsCredentials(replayData = {}) {
    const logExit = logFunctionCall('auth.getStsCredentials');
    
    logger.debug('Fetching STS credentials for upload...');
    const token = await this.getToken();
    
    logger.verbose('Making STS request', {
      tokenPrefix: token.substring(0, 10) + '...',
      replayData: {
        id: replayData.id,
        duration: replayData.duration,
        title: replayData.title,
        hasApps: !!replayData.apps,
        hasIcons: !!replayData.icons,
        hasProject: !!replayData.project
      }
    });
    
    // Prepare the request body to match the desktop app
    const requestBody = {
      id: replayData.id,
      duration: replayData.duration || 0,
      apps: replayData.apps || [],
      title: replayData.title || 'CLI Recording',
      icons: replayData.icons || []
    };

    // Include project if provided
    if (replayData.project) {
      requestBody.project = replayData.project;
    }
    
    const response = await got.post(`${API_ENDPOINT}/api/v1/replay/upload`, {
      headers: {
        Authorization: `Bearer ${token}`
      },
      json: requestBody,
      timeout: 30000
    }).json();
    
    logger.verbose('STS response received', {
      hasVideo: !!response.video,
      hasGif: !!response.gif,
      hasImage: !!response.image,
      hasIcons: !!response.icons
    });

    // The API returns separate STS credentials for video, gif, and image
    // Each contains: accessKeyId, secretAccessKey, sessionToken, bucket, region, file
    logExit();
    return response;
  },

  async createLogSts(replayId, appId, name, type) {
    const logExit = logFunctionCall('auth.createLogSts');
    
    logger.debug('Creating log STS credentials', { replayId, appId, name, type });
    const token = await this.getToken();
    
    try {
      const response = await got.post(`${API_ENDPOINT}/api/v1/logs`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        json: {
          replayId,
          appId,
          name,
          type
        },
        timeout: 30000
      }).json();
      
      logger.verbose('Log STS credentials created', {
        logId: response.id,
        hasCredentials: !!response.bucket
      });
      
      logExit();
      return response;
    } catch (error) {
      logger.error('Failed to create log STS credentials:', {
        message: error.message,
        statusCode: error.response?.statusCode
      });
      logExit();
      throw error;
    } // Return the full response with video, gif, image objects
  },

  async createPerformanceSts(replayId) {
    const logExit = logFunctionCall('auth.createPerformanceSts');
    
    logger.debug('Creating performance STS credentials', { replayId });
    const token = await this.getToken();
    
    try {
      const response = await got.post(`${API_ENDPOINT}/api/v1/replay/performance`, {
        headers: {
          Authorization: `Bearer ${token}`
        },
        json: {
          replayId
        },
        timeout: 30000
      }).json();
      
      logger.verbose('Performance STS credentials created', {
        hasCredentials: !!response.bucket,
        file: response.file
      });
      
      logExit();
      return response;
    } catch (error) {
      logger.error('Failed to create performance STS credentials:', {
        message: error.message,
        statusCode: error.response?.statusCode
      });
      logExit();
      throw error;
    }
  }
};

export { auth };
