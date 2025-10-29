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
    for (const port of this.ports) {
      const ws = await new Promise((resolve) => {
        logger.debug('Trying port ' + port);
        const ws = new WebSocketServer({ port, host: '127.0.0.1' });
        ws.on('error', () => {
          logger.error('Failed to listen on port ' + port);
          resolve();
        });
        ws.on('listening', () => {
          logger.debug('Listening on port ' + port);
          resolve(ws);
        });
      });

      if (ws) return this.#setup(ws, port);
    }
    throw new Error('Unable to listen to any of the provided ports');
  }

  #setup(socket, port) {
    const states = {
      NEW: 'NEW',
      SENT_HEADERS: 'SENT_HEADERS',
      CONNECTED: 'CONNECTED',
    };

    this.port = port;
    this.#socket = socket;

    this.#socket.on('close', (arg) => {
      this.#socket = null;
      this.isListening.value = false;
      this.emit('close', arg);
    });
    this.#socket.on('error', (arg) => {
      this.#socket = null;
      this.isListening.value = false;
      this.emit('error', arg);
    });

    this.#socket.on('connection', (client) => {
      let state = states.NEW;
      const failValidation = () => {
        client.send(
          JSON.stringify({ error: 'Unidentified client, closing socket' })
        );
        client.close();
      };

      const timeout = setTimeout(() => {
        if (state === states.CONNECTED) return;
        failValidation();
      }, 10000);

      client.on('message', (data, isBinary) => {
        let message = isBinary ? data : data.toString();
        try {
          message = JSON.parse(message);
        } catch (err) {}
        if (state === states.SENT_HEADERS) {
          if (message === 'dashcam_extension_socket_confirm') {
            state = states.CONNECTED;
            this.emit('connection', client);
            return;
          }
          failValidation();
          clearTimeout(timeout);
        }

        this.emit('message', message, client);
      });

      client.send('dashcam_desktop_socket_connected', (err) => {
        if (err) {
          client.close();
          clearTimeout(timeout);
        } else state = states.SENT_HEADERS;
      });
    });
    this.isListening.value = true;
    this.emit('listening', port);
  }

  broadcast(message) {
    if (!this.#socket) throw new Error('Server not currently running');
    this.#socket.clients.forEach((client) => {
      try {
        this.send(client, message);
      } catch (err) {
        logger.error('Failed to send message to client: ' + err.message);
      }
    });
  }

  send(client, message) {
    if (!this.#socket) throw new Error('Server not currently running');
    client.send(
      typeof message === 'string' ? message : JSON.stringify(message)
    );
  }

  async stop() {
    if (this.#socket) {
      this.#socket.close();
      this.#socket = null;
      this.isListening.value = false;
    }
  }
}

// This list of ports is randomly generated of ports between 10000 and 65000
// This exact same list of ports needs to be used on the desktop app's websocket server
const server = new WSServer([
  10368, 16240, 21855, 24301, 25928,
  // 27074, 31899, 34205, 36109, 37479, 38986,
  // 39618, 41890, 47096, 48736, 49893, 53659, 55927, 56001, 62895,
]);

export { server, ref };
