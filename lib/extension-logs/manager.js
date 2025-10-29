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
    if (!this.isListening.value) return;
    this.server.broadcast(startMessage);

    const messageCleanup = this.server.on('message', (event) => {
      this.#handleEvent(event);
    });
    const connectionCleanup = this.server.on('connection', (client) =>
      this.server.send(client, startMessage)
    );

    this.cleanups.push(messageCleanup, connectionCleanup);
  }

  #stop() {
    if (this.isListening.value) this.server.broadcast(endMessage);
    this.cleanups.forEach((cleanupFn) => cleanupFn());
    this.cleanups = [];
  }

  subscribeToGlobalTabsAndNavigation(callback) {
    this.globalTabsAndNavigationCallbacks.add(callback);
    this.#tryCallback(callback, this.#getInitialTabs());
    return () => this.unsubscribeFromGlobalTabsAndNavigation(callback);
  }

  unsubscribeFromGlobalTabsAndNavigation(callback) {
    this.globalTabsAndNavigationCallbacks.delete(callback);
  }

  subscribe(pattern, callback) {
    this.patternsByCallback.set(callback, pattern);

    return () => this.unsubscribe(callback);
  }

  unsubscribe(callback) {
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
    this.tabs = updateTabsState(event, this.tabs);
    const { payload, type } = event;
    switch (type) {
      case 'INITIAL_TABS':
      case 'TAB_REMOVED':
      case 'TAB_ACTIVATED':
      case 'NAVIGATION_STARTED':
      case 'NAVIGATION_COMPLETED':
        this.globalTabsAndNavigationCallbacks.forEach((callback) => {
          this.#tryCallback(callback, event);
        });
        break;

      default:
        const cache = {};

        this.eventCallbacks.value.forEach((callback) => {
          const pattern = this.patternsByCallback.get(callback);
          if (pattern && this.#shouldSendEvent(pattern, event, cache)) {
            this.#tryCallback(callback, event);
          }
        });
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
