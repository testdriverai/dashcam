import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { homedir } from 'os';
import { readFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read version from package.json
const packageJson = JSON.parse(
  readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')
);

export const ENV = process.env.NODE_ENV || 'production';

export const auth0Config = {
  domain: 'replayable.us.auth0.com',
  clientId: 'aYo59XVgKhhfrY9lFb35quLdMtF2j6WJ',
  audience: 'https://replayable.us.auth0.com/api/v2/',
  scopes: 'given_name profile email offline_access',
};

export const apiEndpoints = {
  development: process.env.API_ENDPOINT || 'http://localhost:3000',
  staging: 'https://replayable-api-staging.herokuapp.com',
  production: 'https://testdriver-api.onrender.com'
};

export const API_ENDPOINT = apiEndpoints[ENV];

// App configuration
export const APP = {
  id: 'dashcam-cli',
  name: ENV === 'production' ? 'Dashcam CLI' : `Dashcam CLI - ${ENV}`,
  version: packageJson.version,
  configDir: join(homedir(), '.dashcam'),
  logsDir: join(homedir(), '.dashcam', 'logs'),
  recordingsDir: join(homedir(), '.dashcam', 'recordings'),
  minRecordingDuration: 3000 // 3 seconds, matching desktop
};
