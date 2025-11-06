import { AuthenticationClient } from 'auth0';
import Store from 'electron-store';
import { logger } from './logger.js';
import open from 'open';
import http from 'http';
import url from 'url';

const store = new Store();
const auth0Config = {
  domain: process.env.AUTH0_DOMAIN,
  clientId: process.env.AUTH0_CLIENT_ID
};

const auth0 = new AuthenticationClient({
  domain: auth0Config.domain,
  clientId: auth0Config.clientId
});

export async function login() {
  return new Promise((resolve, reject) => {
    // Create local server to handle callback
    const server = http.createServer(async (req, res) => {
      try {
        const { code } = url.parse(req.url, true).query;
        
        if (code) {
          const token = await auth0.oauth.passwordGrant({
            username: process.env.AUTH0_USERNAME,
            password: process.env.AUTH0_PASSWORD,
            scope: 'offline_access'
          });

          store.set('auth_token', token);
          
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.end('<h1>Successfully logged in! You can close this window.</h1>');
          server.close();
          resolve(token);
        }
      } catch (error) {
        logger.error('Auth error:', error);
        reject(error);
      }
    });

    server.listen(3000, () => {
      const authUrl = `https://${auth0Config.domain}/authorize?` +
        `client_id=${auth0Config.clientId}&` +
        `redirect_uri=http://localhost:3000&` +
        `response_type=code&` +
        `scope=offline_access`;

      open(authUrl);
    });
  });
}

export function getToken() {
  return store.get('auth_token');
}

export function isLoggedIn() {
  return !!store.get('auth_token');
}

export function logout() {
  store.delete('auth_token');
}
