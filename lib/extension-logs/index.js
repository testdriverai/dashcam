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

      newPatterns.forEach((pattern) => this.#startWatchingPattern(pattern));
      patternsToRemove.forEach((pattern) => this.#stopWatchingPattern(pattern));
    });
  }

  updateConfig(config) {
    this.config.value = config;
  }

  #startWatchingPattern(pattern) {
    if (this.trackedPatterns[pattern]) return;
    this.trackedPatterns[pattern] = this.webTrackerManager.subscribe(
      pattern,
      (event) => this.#handleEvent(event)
    );
  }

  #stopWatchingPattern(pattern) {
    const unsubscribe = this.trackedPatterns[pattern];
    if (unsubscribe) {
      unsubscribe();
      Object.keys(this.eventTimesByUrl)
        .filter((shortUrl) => verifyPattern(pattern, shortUrl))
        .forEach((shortUrl) => delete this.eventTimesByUrl[shortUrl]);
      delete this.trackedPatterns[pattern];
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
    if (this.events.has(event)) return;
    this.events.add(event);

    this.tabs = updateTabsState(event, this.tabs);

    const { type, time, payload } = event;
    const patterns = [...this.patterns.value];

    let newEvent = { ...event };
    switch (type) {
      case 'INITIAL_TABS':
        newEvent.payload = event.payload.filter((tab) =>
          patterns.some((pattern) => verifyPattern(pattern, tab.url))
        );
        break;

      case 'TAB_REMOVED':
        newEvent = null;
        break;

      case 'TAB_ACTIVATED':
        const tabId = patterns.some((pattern) =>
          verifyPattern(pattern, this.tabs[payload.tabId]?.url)
        )
          ? payload.tabId
          : null;

        if (tabId !== this.lastActiveTabId) {
          this.lastActiveTabId = tabId;
          if (!tabId) {
            newEvent.payload = { tabId: null, windowId: null };
          }
        } else {
          newEvent = null;
        }
        break;

      case 'NAVIGATION_STARTED':
      case 'NAVIGATION_COMPLETED':
        if (
          !patterns.some((ptrn) =>
            verifyPattern(ptrn, this.tabs[payload.tabId]?.url)
          )
        )
          newEvent = null;
        break;
    }

    if (!newEvent) return;

    if (!this.isWatchOnly) {
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
