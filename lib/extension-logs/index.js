import path from 'path';
import { logger } from '../logger.js';
import { jsonl } from '../utilities/jsonl.js';
import {
  verifyPattern,
  updateTabsState,
  shouldCountEvent,
  eventTypeToStatType,
  sanitizeWebLogEventPayload,
} from './helpers.js';

// Simple ref implementation for reactivity (adapted from Vue's ref)
function ref(value) {
  return {
    value,
    _isRef: true
  };
}

function computed(fn) {
  // Don't cache - always recompute to ensure reactivity
  return {
    get value() {
      return fn();
    },
    _isComputed: true
  };
}

function effect(fn) {
  fn();
  return () => {}; // Simplified cleanup
}

// Simple getStats function (same as used in FileTracker)
function getStats(eventTimes = []) {
  const endTime = Date.now();
  const startTime = Date.now() - 60000;

  let startIndex = 0;
  let count = 0;

  for (const time of eventTimes) {
    if (time < startTime) startIndex++;
    else if (time <= endTime) {
      count++;
    } else break;
  }

  return {
    eventTimes: eventTimes.slice(startIndex),
    count,
  };
}

const filename = 'dashcam_logs_web_events.jsonl';

class WebLogsTracker {
  // Omitting a directory puts it in a watch only mode where it
  // only collect per minute stats
  constructor({ config, webTrackerManager, directory }) {
    logger.debug('WebLogsTracker: Initializing', { 
      isWatchOnly: !directory, 
      configKeys: Object.keys(config),
      configCount: Object.keys(config).length
    });
    
    // if watchOnly, the configs in the argument will be a ref
    // but if tracked for a recording the configs will be static
    // we wrap it in a ref just for a consistent way to access it
    this.tabs = {};
    this.events = new Set();
    this.config = ref(config);
    this.trackedPatterns = {};
    this.eventTimesByUrl = {};
    this.lastActiveTabId = null;
    this.isWatchOnly = !directory;
    this.webTrackerManager = webTrackerManager;
    this.fullLogs = { tabs: {}, activeTabs: [] };
    this.fileLocation = this.isWatchOnly ? '' : path.join(directory, filename);
    
    this.patterns = computed(
      () =>
        new Set(
          Object.values(this.config.value)
            .map((config) => config.patterns)
            .flat()
        )
    );

    logger.debug('WebLogsTracker: Subscribing to global tabs and navigation events');
    this.unsubscribeFromGlobalTabsAndNavigation =
      this.webTrackerManager.subscribeToGlobalTabsAndNavigation((event) =>
        this.#handleEvent(event)
      );

    this.watchPatternsEffect = effect(() => {
      const patternsToRemove = Object.keys(this.trackedPatterns).filter(
        (pattern) => !this.patterns.value.has(pattern)
      );
      const newPatterns = [...this.patterns.value].filter(
        (pattern) => !this.trackedPatterns[pattern]
      );

      logger.debug('WebLogsTracker: Updating pattern subscriptions', { 
        patternsToRemove: patternsToRemove.length, 
        newPatterns: newPatterns.length,
        totalPatterns: this.patterns.value.size
      });

      newPatterns.forEach((pattern) => this.#startWatchingPattern(pattern));
      patternsToRemove.forEach((pattern) => this.#stopWatchingPattern(pattern));
    });
  }

  updateConfig(config) {
    this.config.value = config;
  }

  #startWatchingPattern(pattern) {
    if (this.trackedPatterns[pattern]) {
      logger.debug('WebLogsTracker: Pattern already being watched', { pattern });
      return;
    }
    
    logger.debug('WebLogsTracker: Starting to watch pattern', { pattern });
    this.trackedPatterns[pattern] = this.webTrackerManager.subscribe(
      pattern,
      (event) => this.#handleEvent(event)
    );
  }

  #stopWatchingPattern(pattern) {
    const unsubscribe = this.trackedPatterns[pattern];
    if (unsubscribe) {
      logger.debug('WebLogsTracker: Stopping watch for pattern', { pattern });
      unsubscribe();
      Object.keys(this.eventTimesByUrl)
        .filter((shortUrl) => verifyPattern(pattern, shortUrl))
        .forEach((shortUrl) => {
          logger.debug('WebLogsTracker: Removing event times for URL', { shortUrl, pattern });
          delete this.eventTimesByUrl[shortUrl];
        });
      delete this.trackedPatterns[pattern];
    } else {
      logger.debug('WebLogsTracker: Pattern not being watched', { pattern });
    }
  }

  getStatus() {
    const statuses = Object.values(this.config.value).map(
      ({ id, type, name, patterns }) => {
        const items = Object.values(this.eventTimesByUrl)
          .filter(({ shortUrl }) =>
            patterns.some((pattern) => verifyPattern(pattern, shortUrl))
          )
          .map(({ stats, shortUrl, logsCount, errorsCount, networkCount }) => {
            if (this.isWatchOnly) {
              const { eventTimes: l, count: lCount } = getStats(stats.logs);
              const { eventTimes: e, count: eCount } = getStats(stats.errors);
              const { eventTimes: n, count: nCount } = getStats(stats.network);

              stats.logs = l;
              stats.errors = e;
              stats.network = n;
              logsCount = lCount;
              errorsCount = eCount;
              networkCount = nCount;
            }

            return {
              item: shortUrl,
              count: logsCount + errorsCount + networkCount,
              counts: {
                logs: logsCount,
                errors: errorsCount,
                network: networkCount,
              },
            };
          });

        return {
          id,
          type,
          name,
          items,
          fileLocation: this.fileLocation,
          count: items.reduce((sum, item) => sum + item.count, 0),
        };
      }
    );

    return statuses;
  }

  #handleEvent(event) {
    if (this.events.has(event)) {
      logger.debug('WebLogsTracker: Ignoring duplicate event', { type: event.type });
      return;
    }
    this.events.add(event);

    logger.debug('WebLogsTracker: Processing event', { 
      type: event.type, 
      time: event.time,
      tabId: event.payload?.tabId,
      url: event.payload?.url?.substring(0, 100)
    });

    this.tabs = updateTabsState(event, this.tabs);

    const { type, time, payload } = event;
    const patterns = [...this.patterns.value];

    let newEvent = { ...event };
    switch (type) {
      case 'INITIAL_TABS':
        newEvent.payload = event.payload.filter((tab) =>
          patterns.some((pattern) => verifyPattern(pattern, tab.url))
        );
        logger.debug('WebLogsTracker: Filtered initial tabs', { 
          originalCount: event.payload.length, 
          filteredCount: newEvent.payload.length 
        });
        break;

      case 'TAB_REMOVED':
        logger.debug('WebLogsTracker: Tab removed event, marking as null');
        newEvent = null;
        break;

      case 'TAB_ACTIVATED':
        const tabId = patterns.some((pattern) =>
          verifyPattern(pattern, this.tabs[payload.tabId]?.url)
        )
          ? payload.tabId
          : null;

        if (tabId !== this.lastActiveTabId) {
          logger.debug('WebLogsTracker: Active tab changed', { 
            from: this.lastActiveTabId, 
            to: tabId,
            url: this.tabs[tabId]?.url?.substring(0, 100)
          });
          this.lastActiveTabId = tabId;
          if (!tabId) {
            newEvent.payload = { tabId: null, windowId: null };
          }
        } else {
          logger.debug('WebLogsTracker: Active tab unchanged, ignoring event');
          newEvent = null;
        }
        break;

      case 'NAVIGATION_STARTED':
      case 'NAVIGATION_COMPLETED':
        if (
          !patterns.some((ptrn) =>
            verifyPattern(ptrn, this.tabs[payload.tabId]?.url)
          )
        ) {
          logger.debug('WebLogsTracker: Navigation event does not match patterns, ignoring', { 
            type, 
            url: this.tabs[payload.tabId]?.url?.substring(0, 100)
          });
          newEvent = null;
        } else {
          logger.debug('WebLogsTracker: Navigation event matches pattern', { 
            type, 
            url: this.tabs[payload.tabId]?.url?.substring(0, 100)
          });
        }
        break;

      case 'LOG_EVENT':
      case 'LOG_ERROR':
      case 'NETWORK_BEFORE_REQUEST':
      case 'NETWORK_COMPLETED_REQUEST':
      case 'NETWORK_RESPONSE':
      case 'NETWORK_RESPONSE_BODY':
        // These events are already filtered by pattern in WebTrackerManager
        // They should be written as-is
        logger.debug('WebLogsTracker: Processing web event', { 
          type, 
          tabId: payload?.tabId,
          url: this.tabs[payload.tabId]?.url?.substring(0, 100)
        });
        break;
        
      default:
        logger.debug('WebLogsTracker: Unknown event type, passing through', { type });
        break;
    }

    if (!newEvent) {
      logger.debug('WebLogsTracker: Event filtered out, not processing further');
      return;
    }

    if (!this.isWatchOnly) {
      logger.debug('WebLogsTracker: Writing event to file', { fileLocation: this.fileLocation });
      jsonl.append(this.fileLocation, {
        ...newEvent,
        payload: sanitizeWebLogEventPayload(newEvent.payload),
      });
    }

    if (this.tabs[payload.tabId] && shouldCountEvent(type)) {
      const shortUrl = this.tabs[payload.tabId].url.split('?')[0];
      this.eventTimesByUrl[shortUrl] ??= {
        shortUrl,
        stats: {
          logs: [],
          errors: [],
          network: [],
        },
        logsCount: 0,
        errorsCount: 0,
        networkCount: 0,
      };

      const statType = eventTypeToStatType[type];
      if (statType) {
        this.eventTimesByUrl[shortUrl][`${statType}Count`]++;
        this.eventTimesByUrl[shortUrl].stats[statType].push(time);
        logger.debug('WebLogsTracker: Updated stats for URL', { 
          shortUrl, 
          statType, 
          newCount: this.eventTimesByUrl[shortUrl][`${statType}Count`]
        });
      }
    }
  }

  destroy() {
    const status = this.getStatus();
    // stop(this.watchPatternsEffect); // Simplified for CLI
    this.events.clear();
    this.unsubscribeFromGlobalTabsAndNavigation();
    Object.keys(this.trackedPatterns).forEach((pattern) => {
      this.#stopWatchingPattern(pattern);
    });
    return status;
  }
}

export { WebLogsTracker };
