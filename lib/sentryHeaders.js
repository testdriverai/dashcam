import { Store } from './store.js';
import { logger } from './logger.js';

const sentryStore = new Store('sentry-headers');
const HEADERS_KEY = 'headers';

/**
 * Manages Sentry trace headers for distributed tracing.
 * These headers are used to correlate API requests with Sentry transactions.
 */
const sentryHeaders = {
  /**
   * Set Sentry trace headers for future API requests
   * @param {string} sentryTrace - The sentry-trace header value
   * @param {string} baggage - The baggage header value
   */
  setHeaders(sentryTrace, baggage) {
    const headers = {
      'sentry-trace': sentryTrace,
      'baggage': baggage,
      updatedAt: Date.now()
    };
    
    sentryStore.set(HEADERS_KEY, headers);
    
    logger.verbose('Sentry headers configured', {
      sentryTracePrefix: sentryTrace?.substring(0, 20) + '...',
      baggageLength: baggage?.length
    });
  },

  /**
   * Get stored Sentry headers for API requests
   * @returns {Object} Object with 'sentry-trace' and 'baggage' keys, or empty object
   */
  getHeaders() {
    const stored = sentryStore.get(HEADERS_KEY);
    
    if (!stored || !stored['sentry-trace'] || !stored['baggage']) {
      return {};
    }

    logger.verbose('Using stored Sentry headers', {
      sentryTracePrefix: stored['sentry-trace']?.substring(0, 20) + '...',
      age: stored.updatedAt ? ((Date.now() - stored.updatedAt) / 1000).toFixed(1) + 's' : 'unknown'
    });

    return {
      'sentry-trace': stored['sentry-trace'],
      'baggage': stored['baggage']
    };
  },

  /**
   * Clear stored Sentry headers
   */
  clearHeaders() {
    sentryStore.delete(HEADERS_KEY);
    logger.info('Sentry headers cleared');
  },

  /**
   * Check if Sentry headers are configured
   * @returns {boolean}
   */
  hasHeaders() {
    const stored = sentryStore.get(HEADERS_KEY);
    return !!(stored && stored['sentry-trace'] && stored['baggage']);
  }
};

export { sentryHeaders };
