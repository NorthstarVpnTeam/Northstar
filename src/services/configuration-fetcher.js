'use strict';

/**
 * Configuration fetching service (main process only).
 *
 * Downloads a configuration document with explicit timeouts, bounded response
 * size, and honest progress reporting. Never logs document contents.
 */

const { DEFAULT_CONFIG_SOURCE, LIMITS } = require('../shared/constants');

class FetchError extends Error {
  constructor(message, code, status = 0) {
    super(message);
    this.name = 'FetchError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Fetches a configuration document.
 * @param {object} options
 * @param {string} [options.url]
 * @param {AbortSignal} [options.signal]
 * @param {(progress:{phase:string,loaded:number})=>void} [options.onProgress]
 * @returns {Promise<string>}
 */
async function fetchConfiguration({ url = DEFAULT_CONFIG_SOURCE, signal, onProgress } = {}) {
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new FetchError('The configuration source URL is invalid.', 'invalid-url');
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new FetchError('The configuration source must use http or https.', 'invalid-url');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort('timeout'), LIMITS.FETCH_TIMEOUT_MS);
  const onOuterAbort = () => controller.abort('cancelled');
  if (signal) {
    if (signal.aborted) onOuterAbort();
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  try {
    onProgress && onProgress({ phase: 'connecting', loaded: 0 });
    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'NorthstarV2Ray/2.0' },
    });

    if (!response.ok) {
      throw new FetchError(
        `The configuration source returned HTTP ${response.status}.`,
        'http-error',
        response.status
      );
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    if (contentType && !/text|json|plain|octet-stream/.test(contentType)) {
      throw new FetchError(
        `The configuration source returned an unexpected content type (${contentType}).`,
        'bad-content-type'
      );
    }

    const contentLength = Number(response.headers.get('content-length') || 0);
    if (contentLength > LIMITS.FETCH_MAX_BYTES) {
      throw new FetchError('The configuration document is too large.', 'too-large');
    }

    // Stream with a byte cap so a hostile source cannot exhaust memory.
    const chunks = [];
    let total = 0;
    if (response.body) {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > LIMITS.FETCH_MAX_BYTES) {
          try {
            await reader.cancel();
          } catch {
            /* ignore */
          }
          throw new FetchError('The configuration document is too large.', 'too-large');
        }
        chunks.push(Buffer.from(value));
        onProgress && onProgress({ phase: 'downloading', loaded: total });
      }
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      total = buf.byteLength;
      if (total > LIMITS.FETCH_MAX_BYTES) {
        throw new FetchError('The configuration document is too large.', 'too-large');
      }
      chunks.push(buf);
      onProgress && onProgress({ phase: 'downloading', loaded: total });
    }

    const text = Buffer.concat(chunks).toString('utf8');
    onProgress && onProgress({ phase: 'done', loaded: total });
    return text;
  } catch (err) {
    if (err instanceof FetchError) throw err;
    const reason =
      controller.signal.reason === undefined ? null : String(controller.signal.reason);
    if (reason === 'cancelled') {
      throw new FetchError('The refresh was cancelled.', 'cancelled');
    }
    if (reason === 'timeout') {
      throw new FetchError('The configuration source did not respond in time.', 'timeout');
    }
    if (err && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new FetchError('The configuration source did not respond in time.', 'timeout');
    }
    const cause = err && err.cause ? err.cause.code : err && err.code;
    if (cause === 'ENOTFOUND' || cause === 'EAI_AGAIN') {
      throw new FetchError('The configuration host could not be resolved (DNS failure).', 'dns');
    }
    if (cause === 'ECONNREFUSED') {
      throw new FetchError('The configuration source refused the connection.', 'refused');
    }
    if (cause === 'ECONNRESET' || cause === 'UND_ERR_SOCKET') {
      throw new FetchError('The network connection was interrupted.', 'network');
    }
    throw new FetchError(
      `Could not download configurations: ${err && err.message ? err.message : 'unknown error'}`,
      'network'
    );
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
  }
}

module.exports = { fetchConfiguration, FetchError };