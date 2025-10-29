import { ref } from '../websocket/server.js';
import { verifyPattern, updateTabsState } from './helpers.js';
import { logger } from '../logger.js';

// Simple reactive implementation adapted from Vue
function reactive(obj) {
  return obj; // Simplified for CLI - no deep reactivity needed
}

function computed(fn) {
  let cached = null;
  return {
    get value() {
      if (cached === null) {
        cached = fn();
      }
      return cached;
    },
    _isComputed: true
  };
}

function effect(fn) {
  fn();
  return () => {}; // Simplified cleanup
}

const startMessage = {
  type: 'START_RECORDING',
  payload: ['*'],
};
const endMessage = {
  type: 'STOP_RECORDING',
};

class WebTrackerManager {
  constructor(server) {
    this.tabs = {};
    this.cleanups = [];
    this.server = server;
    this.isListening = ref(server.isListening?.value || false);
    this.patternsByCallback = reactive(new Map());
    this.globalTabsAndNavigationCallbacks = reactive(new Set());
    this.eventCallbacks = computed(
      () => new Set(this.patternsByCallback.keys())
    );

    this.watchCallbacksSizeEffect = effect(() => {
      const size =
        this.eventCallbacks.value.size +
        this.globalTabsAndNavigationCallbacks.size;
      const isListening = this.isListening.value;
      if (!isListening || size === 0) {
        this.#stop();
      } else this.#start();
    });
  }

  get isStarted() {
    return this.cleanups.length > 0 && this.isListening.value;
  }

  #start() {
    if (!this.isListening.value) {
      logger.debug('WebTrackerManager: Not starting because WebSocket server is not listening');
      return;
    }
    
    logger.debug('WebTrackerManager: Starting tracking...');
    this.server.broadcast(startMessage);
    logger.debug('WebTrackerManager: Broadcasted start message to all clients');

    const messageCleanup = this.server.on('message', (event) => {
      logger.debug('WebTrackerManager: Received message from server', { eventType: event.type, hasPayload: !!event.payload });
      this.#handleEvent(event);
    });
    const connectionCleanup = this.server.on('connection', (client) => {
      logger.debug('WebTrackerManager: New client connected, sending start message');
      this.server.send(client, startMessage);
    });

    this.cleanups.push(messageCleanup, connectionCleanup);
    logger.debug('WebTrackerManager: Started successfully, registered event handlers');
  }

  #stop() {
    logger.debug('WebTrackerManager: Stopping tracking...');
    if (this.isListening.value) {
      this.server.broadcast(endMessage);
      logger.debug('WebTrackerManager: Broadcasted stop message to all clients');
    }
    
    this.cleanups.forEach((cleanupFn) => cleanupFn());
    this.cleanups = [];
    logger.debug('WebTrackerManager: Stopped and cleaned up event handlers');
  }

  subscribeToGlobalTabsAndNavigation(callback) {
    logger.debug('WebTrackerManager: Subscribing to global tabs/navigation events');
    this.globalTabsAndNavigationCallbacks.add(callback);
    this.#tryCallback(callback, this.#getInitialTabs());
    return () => this.unsubscribeFromGlobalTabsAndNavigation(callback);
  }

  unsubscribeFromGlobalTabsAndNavigation(callback) {
    logger.debug('WebTrackerManager: Unsubscribing from global tabs/navigation events');
    this.globalTabsAndNavigationCallbacks.delete(callback);
  }

  subscribe(pattern, callback) {
    logger.debug('WebTrackerManager: Subscribing to pattern', { pattern });
    this.patternsByCallback.set(callback, pattern);
    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback) {
    const pattern = this.patternsByCallback.get(callback);
    logger.debug('WebTrackerManager: Unsubscribing from pattern', { pattern });
    this.patternsByCallback.delete(callback);
  }

  #getInitialTabs(time = Date.now()) {
    return {
      time,
      type: 'INITIAL_TABS',
      payload: Object.values(this.tabs).map(({ previousUrl, ...tab }) => tab),
    };
  }

  #shouldSendEvent(pattern, event, cache = {}) {
    if (cache[pattern] !== undefined) return cache[pattern];

    if (
      this.tabs[event.payload.tabId] &&
      (verifyPattern(pattern, this.tabs[event.payload.tabId].url) ||
        verifyPattern(pattern, this.tabs[event.payload.tabId].previousUrl))
    ) {
      cache[pattern] = true;
    } else {
      cache[pattern] = false;
    }

    return cache[pattern];
  }

  #handleEvent(event) {
    logger.debug('WebTrackerManager: Handling event', { 
      type: event.type, 
      tabId: event.payload?.tabId,
      url: event.payload?.url?.substring(0, 100) // Truncate long URLs
    });
    
    this.tabs = updateTabsState(event, this.tabs);
    const { payload, type } = event;
    switch (type) {
      case 'INITIAL_TABS':
      case 'TAB_REMOVED':
      case 'TAB_ACTIVATED':
      case 'NAVIGATION_STARTED':
      case 'NAVIGATION_COMPLETED':
        logger.debug('WebTrackerManager: Broadcasting global tabs/navigation event', { type, tabCount: event.payload?.length || 1 });
        this.globalTabsAndNavigationCallbacks.forEach((callback) => {
          this.#tryCallback(callback, event);
        });
        break;

      default:
        const cache = {};
        let matchedCallbacks = 0;
        
        this.eventCallbacks.value.forEach((callback) => {
          const pattern = this.patternsByCallback.get(callback);
          if (pattern && this.#shouldSendEvent(pattern, event, cache)) {
            logger.debug('WebTrackerManager: Event matches pattern, sending to callback', { 
              type, 
              pattern,
              tabUrl: this.tabs[event.payload?.tabId]?.url?.substring(0, 100)
            });
            this.#tryCallback(callback, event);
            matchedCallbacks++;
          }
        });
        
        if (matchedCallbacks === 0) {
          logger.debug('WebTrackerManager: Event did not match any patterns', { type, availablePatterns: this.patternsByCallback.size });
        }
    }
  }

  #tryCallback(callback, event) {
    try {
      callback(event);
    } catch (error) {
      logger.error(
        'Failed sending ExtensionTracker event',
        { event, error }
      );
    }
  }

  destroy() {
    this.#stop();
    this.patternsByCallback.clear();
    this.globalTabsAndNavigationCallbacks.clear();
  }
}

export { WebTrackerManager, reactive, computed, effect };
