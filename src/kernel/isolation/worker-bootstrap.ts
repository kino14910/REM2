/**
 * Inline bootstrap source for the worker thread, injected via `eval`
 * (see worker-host.ts).
 *
 * Why inline instead of a separate file:
 * - Avoids path resolution differences across dev (tsx), test (vitest) and
 *   build (vite bundling).
 * - The worker bootstrap must be plain JS (there is no TS compiler pipeline
 *   inside the worker), so inlining keeps host-side type checking while the
 *   bootstrap itself stays dependency-free and directly evaluable.
 *
 * The protocol's single source of truth lives in `worker-protocol.ts`; this
 * file only mirrors it as string literals, because the worker runs plain JS
 * and has no types to reference.
 */
export const WORKER_BOOTSTRAP_SOURCE = String.raw`
'use strict';

const { parentPort } = require('node:worker_threads');
const path = require('node:path');

/** Whitelist of extension points a worker may contribute to (kept in sync with worker-protocol.ts). */
const WORKER_ALLOWED_POINTS = ['log.sink', 'metrics.sink', 'trace.exporter'];

if (!parentPort) throw new Error('worker-bootstrap must run inside a Worker thread');
const port = parentPort;

/** Plugin instance and context (populated after init). */
let instance = null;
let ctx = null;
let configSnapshot = {};
let permissionsSnapshot = { granted: [], denied: [] };

/** Pending table for Worker -> kernel context calls. */
let ctxSeq = 0;
const ctxPending = new Map();

/** Local event subscriptions: subId -> handler. */
const localSubs = new Map();

/** Send a context call to the kernel and await the reply. */
function ctxCall(pathSegs, args) {
  const id = ++ctxSeq;
  return new Promise((resolve, reject) => {
    ctxPending.set(id, { resolve, reject });
    port.postMessage({ t: 'ctx', id, path: pathSegs, args });
  });
}

/** Build the worker-side plugin context proxy. */
function buildContext(init) {
  const pluginId = init.manifest.id;
  const configApi = {
    get(key, defaultValue) {
      const parts = String(key).split('.');
      let cur = configSnapshot;
      for (const p of parts) {
        if (cur === null || typeof cur !== 'object') return defaultValue;
        cur = cur[p];
      }
      return cur === undefined ? defaultValue : cur;
    },
    has(key) {
      return configApi.get(key, undefined) !== undefined;
    },
    getOrThrow(key) {
      const v = configApi.get(key, undefined);
      if (v === undefined) throw new Error('Missing config key: ' + key);
      return v;
    },
    onDidChange() {
      // Config change subscription is not supported on the worker side
      // (the snapshot is pushed by the kernel and takes effect on the next call).
      return () => undefined;
    },
  };

  const eventsApi = {
    emit(event, payload) {
      return ctxCall(['events', 'emit'], [event, payload]);
    },
    request(topic, payload, opts) {
      return ctxCall(['events', 'request'], [topic, payload, opts && opts.timeoutMs]);
    },
    on(pattern, handler) {
      const subId = ++ctxSeq;
      localSubs.set(subId, handler);
      port.postMessage({ t: 'subscribe', subId, pattern });
      return () => {
        localSubs.delete(subId);
        port.postMessage({ t: 'unsub', subId });
      };
    },
    once(pattern, handler) {
      const unsub = eventsApi.on(pattern, (payload) => {
        unsub();
        return handler(payload);
      });
      return unsub;
    },
    off() {
      // On the worker side, unsubscribe via the returned disposer; off is
      // not supported across the boundary.
    },
    respond() {
      throw new Error('Worker plugins do not support events.respond (RPC responders must live in the kernel process)');
    },
  };

  const metricsApi = {
    counter(name, labels) {
      return { add(value) { void ctxCall(['metrics', 'counter.add'], [name, labels, value]); } };
    },
    gauge(name, labels) {
      return { set(value) { void ctxCall(['metrics', 'gauge.set'], [name, labels, value]); } };
    },
    histogram(name, labels) {
      return { observe(value) { void ctxCall(['metrics', 'histogram.observe'], [name, labels, value]); } };
    },
  };

  const logApi = {};
  for (const level of ['trace', 'debug', 'info', 'warn', 'error', 'fatal']) {
    logApi[level] = (msg, data) => {
      void ctxCall(['log', level], [String(msg), data]);
    };
  }

  const unsupported = (name) => () => {
    throw new Error('Under worker isolation ' + name + ' is not supported (collaborate via the event bus instead)');
  };

  return {
    pluginId,
    manifest: init.manifest,
    phase: 'Loaded',
    log: logApi,
    config: configApi,
    events: eventsApi,
    metrics: metricsApi,
    permissions: {
      pluginId,
      get granted() { return permissionsSnapshot.granted; },
      get denied() { return permissionsSnapshot.denied; },
      isGranted(cap) { return permissionsSnapshot.granted.includes(cap); },
    },
    resolvePath(rel) {
      return path.resolve(init.rootDir, rel);
    },
    dataPath(rel) {
      return path.resolve(init.dataRoot, rel);
    },
    container: { register: unsupported('container'), registerInstance: unsupported('container') },
    services: {
      register: unsupported('services.register'),
      registerInstance: unsupported('services.registerInstance'),
      resolve: unsupported('services.resolve'),
      tryResolve: unsupported('services.tryResolve'),
      has: unsupported('services.has'),
      list: unsupported('services.list'),
    },
    api: {
      export: unsupported('api.export'),
      unexport: unsupported('api.unexport'),
      useCapability: unsupported('api.useCapability'),
    },
    // Workers may only contribute the three sink extension points
    // (values must be structured-cloneable).
    // Contributing UI extension points from a worker is meaningless:
    // the renderer is unreachable across the process boundary.
    extensions: {
      contribute(point, contribution) {
        if (WORKER_ALLOWED_POINTS.indexOf(point) < 0) {
          throw new Error(
            'Under worker isolation only ' + WORKER_ALLOWED_POINTS.join(' / ') +
            ' contributions are allowed, received: ' + point,
          );
        }
        void ctxCall(['extensions', 'contribute'], [point, contribution]);
      },
      retract: unsupported('extensions.retract'),
    },
    plugins: {
      has: unsupported('plugins.has'),
      isStarted: unsupported('plugins.isStarted'),
      get: unsupported('plugins.get'),
      all: unsupported('plugins.all'),
      byState: unsupported('plugins.byState'),
    },
  };
}

/**
 * Instantiate the plugin: the only supported form is
 * export default definePlugin(manifest, setup).
 *
 * No shape guessing: the worker side and the kernel side used to each guess a
 * different set of accepted shapes, which is a bug farm by itself.
 */
async function instantiate(mod, ctx) {
  const factory = mod && mod.default;
  if (typeof factory !== 'function') {
    throw new Error('Plugin must export default definePlugin(manifest, setup)');
  }
  const hooks = await factory(ctx);
  if (!hooks || typeof hooks !== 'object') {
    throw new Error('definePlugin setup must return a hooks object');
  }
  return hooks;
}

port.on('message', async (msg) => {
  switch (msg.t) {
    case 'init': {
      try {
        configSnapshot = msg.configSnapshot || {};
        permissionsSnapshot = msg.permissions || { granted: [], denied: [] };
        const mod = await import(msg.entrySpecifier);
        ctx = buildContext(msg);
        instance = await instantiate(mod, ctx);
        port.postMessage({ t: 'ready' });
      } catch (error) {
        port.postMessage({ t: 'init-error', message: String((error && error.message) || error) });
      }
      return;
    }
    case 'call': {
      const { id, hook, args } = msg;
      try {
        if (!instance) throw new Error('Plugin not initialized yet');
        const fn = instance[hook];
        let value;
        if (typeof fn === 'function') {
          value = hook === 'onHealthCheck'
            ? await fn.call(instance)
            : await fn.call(instance, ctx, ...(args || []));
        }
        port.postMessage({ t: 'result', id, ok: true, value: value === undefined ? null : value });
      } catch (error) {
        port.postMessage({ t: 'result', id, ok: false, error: String((error && error.message) || error) });
      }
      return;
    }
    case 'event': {
      const handler = localSubs.get(msg.subId);
      if (handler) {
        try {
          await handler(msg.payload);
        } catch (error) {
          void ctxCall(['log', 'error'], ['Worker event handler failed: ' + String((error && error.message) || error)]);
        }
      }
      return;
    }
    case 'config': {
      configSnapshot = msg.snapshot || {};
      return;
    }
    case 'ctx-result': {
      const p = ctxPending.get(msg.id);
      if (p) {
        ctxPending.delete(msg.id);
        if (msg.ok) p.resolve(msg.value);
        else p.reject(new Error(msg.error || 'Context call failed'));
      }
      return;
    }
    default:
  }
});
`
