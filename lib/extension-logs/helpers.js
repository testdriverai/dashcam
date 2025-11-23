import maskSensitiveData from 'mask-sensitive-data';

const escapeRegExp = (string) => string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the whole matched string

const shouldCountEvent = (eventType) => {
  return ['LOG_ERROR', 'LOG_EVENT', 'NETWORK_BEFORE_REQUEST'].includes(
    eventType
  );
};

const eventTypeToStatType = {
  LOG_EVENT: 'logs',
  LOG_ERROR: 'errors',
  NETWORK_BEFORE_REQUEST: 'network',
};

const verifyPattern = (pattern, str = '') => {
  if (typeof pattern !== 'string' || typeof str !== 'string')
    throw new Error(
      `verifyPattern expects two string arguments but instead got "pattern" of type ${typeof pattern} and "str" of type ${typeof str}`
    );
  return new RegExp(
    '^' + pattern.split('*').map(escapeRegExp).join('.*'),
    'i'
  ).test(str);
};

const updateTabsState = (event, tabs) => {
  const { type, payload } = event;
  switch (type) {
    case 'INITIAL_TABS':
      tabs = payload.reduce((tabs, tab) => {
        if (tab.url) tabs[tab.tabId] = { ...tab, previousUrl: '' };
        return tabs;
      }, {});
      break;
    case 'TAB_REMOVED':
      delete tabs[payload.tabId];
      break;
    case 'TAB_ACTIVATED':
      tabs[payload.tabId] ??= payload;
    case 'NAVIGATION_STARTED':
    case 'NAVIGATION_COMPLETED':
      if (tabs[payload.tabId] && tabs[payload.tabId].url !== payload.url) {
        tabs[payload.tabId].previousUrl = tabs[payload.tabId].url;
        tabs[payload.tabId].url = payload.url;
      }
      break;
    default:
      if (tabs[payload.tabId]) tabs[payload.tabId].previousUrl = '';
  }

  return tabs;
};

function sanitizeWebLogEventPayload(obj) {
  let result = obj;
  if (obj === null || obj === undefined) {
  } else if (typeof obj === 'string')
    result = maskSensitiveData.default(obj, {
      ...maskSensitiveData.defaultMaskOptions,
      jwtPattern: /\b(?:[A-Za-z0-9\-_=]{40,}|[A-Fa-f0-9\-_=]{40,})\b/g,
    });
  else if (Array.isArray(obj)) {
    result = obj.map((element) => sanitizeWebLogEventPayload(element));
  } else if (typeof obj === 'object') {
    result = Object.entries(obj).reduce((result, [key, value]) => {
      if (!key.toLowerCase().includes('url'))
        result[key] = sanitizeWebLogEventPayload(value);
      else result[key] = value;
      return result;
    }, {});
  }
  return result;
}

function filterWebEvents(
  events,
  groupLogsStatuses,
  startMs = events[0]?.time ?? 0,
  endMs = events[events.length - 1]?.time ?? 0
) {
  const tempEvents = events.filter(
    event => event.type === 'INITIAL_TABS' || event.payload.tabId
  );
  const patterns = groupLogsStatuses
    .map((status) => {
      // Handle cases where items might not be set (e.g., during upload)
      if (!status.items || !Array.isArray(status.items)) {
        return status.patterns || [];
      }
      return status.items.map((item) => item.item);
    })
    .flat();

  const newEvents = [];
  let tabs = {};
  let tracked;
  let map = {};

  tempEvents
    .filter((event) => event.time <= startMs)
    .forEach((event) => (tabs = updateTabsState(event, tabs)));

  tempEvents.push({
    type: 'INITIAL_TABS',
    time: startMs,
    payload: Object.values(tabs).map(({ previousUrl, ...tab }) => tab),
  });

  for (const event of tempEvents.filter(
    (event) => event.time >= startMs && event.time <= endMs
  )) {
    try {
      switch (event.type) {
        case 'NAVIGATION_STARTED':
        case 'NAVIGATION_COMPLETED':
          tracked = patterns.some((pattern) =>
            verifyPattern(pattern, event.payload.url)
          );
          if (tracked) newEvents.push(event);
          map[event.payload.tabId] = event.payload.url;
          break;

        case 'NETWORK_BEFORE_REQUEST':
          tracked = patterns.some((pattern) =>
            verifyPattern(pattern, map[event.payload.tabId])
          );
          if (tracked) newEvents.push(event);
          break;

        case 'NETWORK_COMPLETED_REQUEST':
        case 'NETWORK_ERROR_REQUEST':
          const startedEvent = newEvents.find(
            (e) =>
              e.payload.requestId === event.payload.requestId &&
              e.type === 'NETWORK_BEFORE_REQUEST'
          );
          if (startedEvent) newEvents.push(event);
          break;

        case 'NETWORK_RESPONSE_BODY':
          const completedEvent = newEvents.find(
            (e) =>
              e.payload.requestId === event.payload.requestId &&
              e.type === 'NETWORK_COMPLETED_REQUEST'
          );
          if (completedEvent) newEvents.push(event);
          break;

        case 'LOG_ERROR':
        case 'LOG_EVENT':
        case 'SPA_NAVIGATION':
          tracked = patterns.some((pattern) =>
            verifyPattern(pattern, map[event.payload.tabId])
          );
          if (tracked) newEvents.push(event);
          break;

        case 'TAB_ACTIVATED':
          tracked = patterns.some((pattern) =>
            verifyPattern(pattern, event.payload.url)
          );
          if (tracked) {
            map[event.payload.tabId] = event.payload.url;
            newEvents.push(event);
          }
          break;
          
        case 'INITIAL_TABS':
          newEvents.push(event);
          break;
      }
    } catch (err) {
      console.error(err);
    }
  }
  return newEvents;
}

export {
  verifyPattern,
  updateTabsState,
  filterWebEvents,
  shouldCountEvent,
  eventTypeToStatType,
  sanitizeWebLogEventPayload,
};
