/**
 * Worker 内引导源码（以 `eval` 形式注入 Worker 线程，见 worker-host.ts）。
 *
 * 为什么内联为字符串而不是独立文件：
 * - 避免 dev(tsx) / test(vitest) / build(vite 打包) 三种形态下的路径解析差异；
 * - Worker 引导代码必须是纯 JS（Worker 内没有 TS 编译管线），
 *   内联后类型检查仍覆盖宿主侧，引导代码本身保持零依赖、可直接 eval。
 *
 * 协议（结构化克隆消息）：
 * - 内核 → Worker：`init` / `call`（生命周期钩子 RPC）/ `event`（事件派发）
 *   / `config`（配置快照推送）/ `ctx-result`（上下文调用回包）。
 * - Worker → 内核：`ready` / `init-error` / `result` / `ctx`（上下文调用）
 *   / `subscribe` / `unsub`。
 */
export const WORKER_BOOTSTRAP_SOURCE = String.raw`
'use strict';

const { parentPort } = require('node:worker_threads');
const path = require('node:path');

if (!parentPort) throw new Error('worker-bootstrap 必须在 Worker 线程中运行');
const port = parentPort;

/** 插件实例与上下文（init 后填充）。 */
let instance = null;
let ctx = null;
let configSnapshot = {};
let permissionsSnapshot = { granted: [], denied: [] };

/** Worker → 内核 上下文调用的待决表。 */
let ctxSeq = 0;
const ctxPending = new Map();

/** 本地事件订阅：subId → handler。 */
const localSubs = new Map();

/** 向内核发上下文调用并等待回包。 */
function ctxCall(pathSegs, args) {
  const id = ++ctxSeq;
  return new Promise((resolve, reject) => {
    ctxPending.set(id, { resolve, reject });
    port.postMessage({ t: 'ctx', id, path: pathSegs, args });
  });
}

/** 构造 Worker 侧的插件上下文代理。 */
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
      if (v === undefined) throw new Error('配置项缺失：' + key);
      return v;
    },
    onDidChange() {
      // Worker 侧暂不支持订阅配置变更（快照由内核推送，下一轮调用即生效）。
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
      // Worker 侧通过返回的退订函数退订；off 不跨边界支持。
    },
    respond() {
      throw new Error('Worker 插件不支持 events.respond（RPC 响应者必须在内核进程内）');
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
    throw new Error('Worker 隔离下不支持 ' + name + '（请改用事件总线协作）');
  };

  return {
    pluginId,
    manifest: init.manifest,
    phase: 'Start',
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
      registerCapability: unsupported('api.registerCapability'),
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

/** 实例化插件模块（与内核 plugin-factory 同样的三种形态）。 */
function instantiate(mod) {
  let candidate = mod && mod.default !== undefined ? mod.default : (mod && mod.plugin !== undefined ? mod.plugin : mod && mod.Plugin);
  if (candidate && typeof candidate === 'object' && 'default' in candidate) candidate = candidate.default;
  if (typeof candidate === 'function') return new candidate();
  return candidate;
}

port.on('message', async (msg) => {
  switch (msg.t) {
    case 'init': {
      try {
        configSnapshot = msg.configSnapshot || {};
        permissionsSnapshot = msg.permissions || { granted: [], denied: [] };
        const mod = await import(msg.entrySpecifier);
        instance = instantiate(mod);
        if (!instance || typeof instance !== 'object') {
          throw new Error('插件模块未导出可识别的插件对象');
        }
        ctx = buildContext(msg);
        port.postMessage({ t: 'ready' });
      } catch (error) {
        port.postMessage({ t: 'init-error', message: String((error && error.message) || error) });
      }
      return;
    }
    case 'call': {
      const { id, hook, args } = msg;
      try {
        if (!instance) throw new Error('插件尚未初始化');
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
          void ctxCall(['log', 'error'], ['Worker 事件处理器失败: ' + String((error && error.message) || error)]);
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
        else p.reject(new Error(msg.error || '上下文调用失败'));
      }
      return;
    }
    default:
  }
});
`;
