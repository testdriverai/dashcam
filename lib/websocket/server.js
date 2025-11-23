import { WebSocketServer } from 'ws';
import { logger } from '../logger.js';

// Simple ref implementation for reactivity (adapted from Vue's ref)
function ref(value) {
  return {
    value,
    _isRef: true
  };
}

class WSServer {
  #socket = null;
  #handlers = {};
  
  constructor(ports) {
    this.ports = ports;
    this.port = null;
    this.isListening = ref(false);
  }

  on(event, handler) {
    if (!this.#handlers[event]) this.#handlers[event] = [];
    if (this.#handlers[event].find((cb) => cb === handler))
      throw new Error('Handler already registered');
    this.#handlers[event].push(handler);
    return () => {
      this.#handlers[event] = this.#handlers[event].filter((cb) => cb !== handler);
    };
  }

  emit(event, payload) {
    if (!this.#handlers[event]) return;
    for (const cb of this.#handlers[event]) {
      try {
        cb(payload);
      } catch (err) {
        logger.error(
          'Failed calling handler for event ' +
            event +
            ' with error ' +
            err.message
        );
      }
    }
  }

  async start() {
    if (this.#socket) {
      logger.error('The websocket server is already started');
      return;
    }
    
    logger.info('WebSocketServer: Starting server, trying ports...', { ports: this.ports });
    for (const port of this.ports) {
      const ws = await new Promise((resolve) => {
        logger.debug('WebSocketServer: Trying port ' + port);
        const ws = new WebSocketServer({ port, host: '127.0.0.1' });
        
        // Unref the server to prevent it from keeping the process alive
        if (ws._server && ws._server.unref) {
          ws._server.unref();
          logger.debug('WebSocketServer: Unreffed server to allow process exit');
        }
        
        ws.on('error', () => {
          logger.debug('WebSocketServer: Failed to listen on port ' + port);
          resolve();
        });
        ws.on('listening', () => {
          logger.debug('WebSocketServer: Successfully listening on port ' + port);
          resolve(ws);
        });
      });

      if (ws) return this.#setup(ws, port);
    }
    throw new Error('Unable to listen to any of the provided ports');
  }

    #setup(socket, port) {
    logger.debug('WebSocketServer: Setting up server on port', { port });
    
    const states = {
      NEW: 'NEW',
      SENT_HEADERS: 'SENT_HEADERS',
      CONNECTED: 'CONNECTED',
    };

    this.port = port;
    this.#socket = socket;

    this.#socket.on('close', (arg) => {
      logger.debug('WebSocketServer: Server closed', { arg });
      this.#socket = null;
      this.isListening.value = false;
      this.emit('close', arg);
    });
    this.#socket.on('error', (arg) => {
      logger.error('WebSocketServer: Server error', { error: arg });
      this.#socket = null;
      this.isListening.value = false;
      this.emit('error', arg);
    });

    this.#socket.on('connection', (client) => {
      logger.info('WebSocketServer: New client connection established', {
        clientAddress: client._socket?.remoteAddress,
        clientPort: client._socket?.remotePort,
        totalClients: this.#socket.clients.size
      });
      
      let state = states.NEW;
      const failValidation = () => {
        logger.warn('WebSocketServer: Client validation failed, closing connection');
        client.send(
          JSON.stringify({ error: 'Unidentified client, closing socket' })
        );
        client.close();
      };

      const timeout = setTimeout(() => {
        if (state === states.CONNECTED) return;
        logger.warn('WebSocketServer: Client validation timeout, closing connection');
        failValidation();
        clearTimeout(timeout);
      }, 10000);

      client.on('message', (data, isBinary) => {
        let message = isBinary ? data : data.toString();
        logger.info('WebSocketServer: Received message from client', { 
          isBinary, 
          messageLength: message.length,
          messagePreview: message.substring(0, 100),
          state 
        });
        
        try {
          message = JSON.parse(message);
          logger.info('WebSocketServer: Parsed message', { 
            type: message.type, 
            hasPayload: !!message.payload,
            payloadKeys: message.payload ? Object.keys(message.payload) : []
          });
        } catch (err) {
          logger.info('WebSocketServer: Message is not JSON, treating as raw string', { rawMessage: message });
        }
        
        if (state === states.SENT_HEADERS) {
          if (message === 'dashcam_extension_socket_confirm') {
            state = states.CONNECTED;
            logger.info('WebSocketServer: Client successfully validated and connected');
            this.emit('connection', client);
            return;
          }
          logger.warn('WebSocketServer: Invalid confirmation message from client');
          failValidation();
          clearTimeout(timeout);
        }

        this.emit('message', message, client);
      });

      logger.info('WebSocketServer: Sending connection header to client');
      client.send('dashcam_desktop_socket_connected', (err) => {
        if (err) {
          logger.error('WebSocketServer: Failed to send connection header', { error: err.message });
          client.close();
          clearTimeout(timeout);
        } else {
          logger.info('WebSocketServer: Connection header sent, waiting for confirmation');
          state = states.SENT_HEADERS;
        }
      });
    });
    
    this.isListening.value = true;
    logger.info('WebSocketServer: Setup complete, server is listening', { port });
    this.emit('listening', port);
  }

  broadcast(message) {
    if (!this.#socket) {
      logger.error('WebSocketServer: Cannot broadcast, server not currently running');
      throw new Error('Server not currently running');
    }
    
    logger.info('WebSocketServer: Broadcasting message to all clients', { 
      clientCount: this.#socket.clients.size,
      messageType: message.type || 'raw',
      messagePayload: message.payload ? JSON.stringify(message.payload).substring(0, 100) : 'none'
    });
    
    this.#socket.clients.forEach((client) => {
      try {
        this.send(client, message);
      } catch (err) {
        logger.error('WebSocketServer: Failed to send message to client', { error: err.message });
      }
    });
  }

  send(client, message) {
    if (!this.#socket) {
      logger.error('WebSocketServer: Cannot send, server not currently running');
      throw new Error('Server not currently running');
    }
    
    logger.debug('WebSocketServer: Sending message to client', { 
      messageType: message.type || 'raw',
      messageLength: JSON.stringify(message).length
    });
    
    client.send(
      typeof message === 'string' ? message : JSON.stringify(message)
    );
  }

  async stop() {
    if (this.#socket) {
      logger.debug('WebSocketServer: Stopping server...');
      this.#socket.close();
      this.#socket = null;
      this.isListening.value = false;
      logger.info('WebSocketServer: Server stopped');
    } else {
      logger.debug('WebSocketServer: Server already stopped');
    }
  }
}

// This list of ports is randomly generated of ports between 10000 and 65000
// Using a different range than desktop app to avoid conflicts
// Desktop app uses: 10368, 16240, 21855, 24301, 25928, etc.
// CLI uses a separate range starting from higher ports
const server = new WSServer([
  50368, 51240, 52855, 53301, 54928,
  // 55074, 56899, 57205, 58109, 59479, 60986,
  // 61618, 62890, 63096, 64736, 65893,
]);

export { server, ref };
