/**
 * 手写零依赖 Manifest 校验器（docs/02 §C.2 / §K）。
 *
 * 不使用 zod / ajv —— 内核必须零第三方运行时依赖（§B.2 红线）。
 * 校验器与 `manifest.schema.json` 语义保持一致，并由单测覆盖。
 */

import type {
  PluginManifest,
  ManifestContribution,
} from '../contracts/manifest.js';
import { EXTENSION_POINT_IDS } from '../extensions/definitions.js';
import { isValidRange } from '../semver/range.js';
import { isValidVersion } from '../semver/semver.js';

/** 单个校验错误。 */
export interface ManifestValidationIssue {
  path: string;
  message: string;
}

/** 校验结果。 */
export interface ManifestValidationResult {
  ok: boolean;
  issues: ManifestValidationIssue[];
  /** 校验通过时返回规范化后的 manifest。 */
  value?: PluginManifest;
}

/**
 * 插件 id：reverse-DNS 风格，小写字母/数字，段间用 `.`/`_`/`-` 分隔。
 *
 * 每段必须非空 —— 旧式 `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$` 会放行 `bad..id` 这类
 * 连续分隔符。改为「段 = [a-z0-9]+，分隔符 = [._-]」后连续分隔符被拒。
 */
const ID_RE = /^[a-z0-9]+([._-][a-z0-9]+)*$/;
const CAP_RE = /^[a-z][a-z0-9-]*(\.[a-z0-9-]+)*$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
/** entry 只允许构建产物（docs/11 §6.3：消除 dev/prod 双形态）。 */
const ENTRY_RE = /\.(js|mjs)$/;

/** 已声明的扩展点 id 集合（来自 `extensions/definitions.ts`，保证单一来源）。 */
const KNOWN_POINTS: ReadonlySet<string> = new Set(EXTENSION_POINT_IDS);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  );
}

/**
 * 校验一个原始对象是否满足 PluginManifest 契约。
 */
export function validateManifest(raw: unknown): ManifestValidationResult {
  const issues: ManifestValidationIssue[] = [];

  if (!isPlainObject(raw)) {
    return {
      ok: false,
      issues: [{ path: '$', message: 'manifest 必须是对象' }],
    };
  }

  const obj = raw;

  // id
  if (typeof obj.id !== 'string' || obj.id.length < 3) {
    issues.push({ path: '$.id', message: 'id 必须是长度 ≥3 的字符串' });
  } else if (!ID_RE.test(obj.id)) {
    issues.push({
      path: '$.id',
      message: `id 格式非法：${obj.id}（建议 reverse-DNS）`,
    });
  }

  // name
  if (typeof obj.name !== 'string' || obj.name.trim() === '') {
    issues.push({ path: '$.name', message: 'name 必须是非空字符串' });
  }

  // version
  if (
    typeof obj.version !== 'string' ||
    !VERSION_RE.test(obj.version) ||
    !isValidVersion(obj.version)
  ) {
    issues.push({
      path: '$.version',
      message: `version 非法（需 semver）：${String(obj.version)}`,
    });
  }

  // entry：必须是构建产物（.js / .mjs）。这是「dev 与 prod 同形态」的类型级落点。
  if (typeof obj.entry !== 'string' || obj.entry.trim() === '') {
    issues.push({ path: '$.entry', message: 'entry 必须是非空字符串' });
  } else if (!ENTRY_RE.test(obj.entry)) {
    issues.push({
      path: '$.entry',
      message: `entry 必须是构建产物（以 .js 或 .mjs 结尾）：${obj.entry}`,
    });
  }

  // compatibility
  const compat = obj.compatibility;
  if (!isPlainObject(compat)) {
    issues.push({
      path: '$.compatibility',
      message: 'compatibility 必须存在且为对象',
    });
  } else {
    if (
      typeof compat.minKernel !== 'string' ||
      compat.minKernel.trim() === ''
    ) {
      issues.push({
        path: '$.compatibility.minKernel',
        message: 'minKernel 必须是非空字符串',
      });
    } else if (
      !isValidRange(compat.minKernel) &&
      !isValidVersion(compat.minKernel)
    ) {
      issues.push({
        path: '$.compatibility.minKernel',
        message: `minKernel 既非合法 range 也非合法版本：${compat.minKernel}`,
      });
    }
    if (compat.maxKernel !== undefined) {
      if (
        typeof compat.maxKernel !== 'string' ||
        !isValidVersion(compat.maxKernel)
      ) {
        issues.push({
          path: '$.compatibility.maxKernel',
          message: `maxKernel 非法：${String(compat.maxKernel)}`,
        });
      }
    }
    if (
      typeof compat.contractVersion !== 'string' ||
      compat.contractVersion.trim() === ''
    ) {
      issues.push({
        path: '$.compatibility.contractVersion',
        message: 'contractVersion 必须是非空字符串',
      });
    }
  }

  // dependencies / optionalDependencies
  validateDepMap(obj.dependencies, '$.dependencies', issues);
  validateDepMap(obj.optionalDependencies, '$.optionalDependencies', issues);

  // requires（我需要什么）
  if (obj.requires !== undefined) {
    if (!Array.isArray(obj.requires)) {
      issues.push({ path: '$.requires', message: 'requires 必须是数组' });
    } else {
      const seen = new Set<string>();
      obj.requires.forEach((cap, i) => {
        if (typeof cap !== 'string' || !CAP_RE.test(cap)) {
          issues.push({
            path: `$.requires[${i}]`,
            message: `能力名非法：${String(cap)}`,
          });
        } else if (seen.has(cap)) {
          issues.push({ path: `$.requires[${i}]`, message: `能力重复：${cap}` });
        } else {
          seen.add(cap);
        }
      });
    }
  }

  // contributes（我提供什么）：point 必须是已声明的扩展点 id
  if (obj.contributes !== undefined) {
    if (!Array.isArray(obj.contributes)) {
      issues.push({ path: '$.contributes', message: 'contributes 必须是数组' });
    } else {
      const seen = new Set<string>();
      obj.contributes.forEach((raw, i) => {
        if (!isPlainObject(raw)) {
          issues.push({
            path: `$.contributes[${i}]`,
            message: 'contributes 项必须是对象',
          });
          return;
        }
        const point = raw.point;
        const cid = raw.id;
        if (typeof point !== 'string' || !KNOWN_POINTS.has(point)) {
          issues.push({
            path: `$.contributes[${i}].point`,
            message: `未声明的扩展点：${String(point)}`,
          });
        }
        if (typeof cid !== 'string' || cid.trim() === '') {
          issues.push({
            path: `$.contributes[${i}].id`,
            message: 'contributes[].id 必须是非空字符串',
          });
        }
        if (raw.capability !== undefined && typeof raw.capability !== 'string') {
          issues.push({
            path: `$.contributes[${i}].capability`,
            message: 'capability 必须是字符串',
          });
        }
        const key = `${String(point)}#${String(cid)}`;
        if (seen.has(key)) {
          issues.push({
            path: `$.contributes[${i}]`,
            message: `贡献槽位重复：${key}`,
          });
        } else {
          seen.add(key);
        }
      });
    }
  }

  // capabilities 已更名 requires；出现即视为过期字段（破坏式变更，不静默忽略）。
  if (obj.capabilities !== undefined) {
    issues.push({
      path: '$.capabilities',
      message: 'capabilities 已更名：提供什么用 contributes，需要什么用 requires',
    });
  }

  // 可选字符串字段
  for (const field of ['author', 'description', 'icon', 'homepage'] as const) {
    if (obj[field] !== undefined && typeof obj[field] !== 'string') {
      issues.push({ path: `$.${field}`, message: `${field} 必须是字符串` });
    }
  }

  // tags
  if (obj.tags !== undefined) {
    if (
      !Array.isArray(obj.tags) ||
      obj.tags.some((t) => typeof t !== 'string')
    ) {
      issues.push({ path: '$.tags', message: 'tags 必须是字符串数组' });
    }
  }

  // isolation
  if (obj.isolation !== undefined) {
    if (obj.isolation !== 'in-process' && obj.isolation !== 'worker') {
      issues.push({
        path: '$.isolation',
        message: `isolation 非法：${String(obj.isolation)}（允许 'in-process' | 'worker'）`,
      });
    }
  }

  if (issues.length > 0) {
    return { ok: false, issues };
  }

  return { ok: true, issues: [], value: normalizeManifest(obj) };
}

function validateDepMap(
  value: unknown,
  path: string,
  issues: ManifestValidationIssue[],
): void {
  if (value === undefined) return;
  if (!isPlainObject(value)) {
    issues.push({ path, message: '必须是对象（pluginId -> range）' });
    return;
  }
  for (const [depId, range] of Object.entries(value)) {
    if (!ID_RE.test(depId)) {
      issues.push({
        path: `${path}.${depId}`,
        message: `依赖 id 非法：${depId}`,
      });
    }
    if (typeof range !== 'string' || range.trim() === '') {
      issues.push({
        path: `${path}.${depId}`,
        message: '依赖 range 必须是非空字符串',
      });
    } else if (!isValidRange(range) && !isValidVersion(range)) {
      issues.push({
        path: `${path}.${depId}`,
        message: `依赖 range 非法：${range}`,
      });
    }
  }
}

/** 把原始对象规范化成 PluginManifest（补全可选字段缺省值）。 */
function normalizeManifest(obj: Record<string, unknown>): PluginManifest {
  const compat = obj.compatibility as Record<string, unknown>;
  const manifest: PluginManifest = {
    id: String(obj.id),
    name: String(obj.name),
    version: String(obj.version),
    entry: String(obj.entry),
    compatibility: {
      minKernel: String(compat.minKernel),
      contractVersion: String(compat.contractVersion),
      ...(compat.maxKernel !== undefined
        ? { maxKernel: String(compat.maxKernel) }
        : {}),
    },
  };

  if (isPlainObject(obj.dependencies)) {
    manifest.dependencies = toStringMap(obj.dependencies);
  }
  if (isPlainObject(obj.optionalDependencies)) {
    manifest.optionalDependencies = toStringMap(obj.optionalDependencies);
  }
  if (Array.isArray(obj.requires)) {
    manifest.requires = obj.requires.map((c) => String(c));
  }
  if (Array.isArray(obj.contributes)) {
    manifest.contributes = obj.contributes.map((c) => {
      const raw = c as Record<string, unknown>;
      const item: ManifestContribution = {
        point: String(raw.point),
        id: String(raw.id),
      };
      return raw.capability !== undefined
        ? { ...item, capability: String(raw.capability) }
        : item;
    });
  }
  if (typeof obj.author === 'string') manifest.author = obj.author;
  if (typeof obj.description === 'string')
    manifest.description = obj.description;
  if (typeof obj.icon === 'string') manifest.icon = obj.icon;
  if (typeof obj.homepage === 'string') manifest.homepage = obj.homepage;
  if (Array.isArray(obj.tags)) manifest.tags = obj.tags.map((t) => String(t));
  if (obj.isolation === 'in-process' || obj.isolation === 'worker') {
    manifest.isolation = obj.isolation;
  }
  if (isPlainObject(obj.configSchema)) manifest.configSchema = obj.configSchema;

  return manifest;
}

function toStringMap(input: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = String(v);
  }
  return out;
}
