/**
 * 深度合并（配置分层，docs/02 §H.2）。
 *
 * 规则：
 * - 对象递归合并；后者覆盖前者。
 * - 数组、原始值、null 直接替换（不做元素级合并，避免配置语义歧义）。
 * - 不修改输入对象（返回新对象）。
 */

/** 判断是否为「普通对象」（排除数组、null、Date 等）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * 深度合并两个对象。
 */
export function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Record<string, unknown>,
): T {
  const result: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existing = result[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      result[key] = deepMerge(existing, value);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return result as T;
}

/**
 * 依次合并多个层（后者覆盖前者）。
 */
export function deepMergeAll(
  layers: Array<Record<string, unknown>>,
): Record<string, unknown> {
  let acc: Record<string, unknown> = {};
  for (const layer of layers) {
    acc = deepMerge(acc, layer ?? {});
  }
  return acc;
}

/**
 * 扁平化读值：支持 `'a.b.c'` 形式；返回 undefined 表示不存在。
 */
export function getPath(obj: unknown, path: string): unknown {
  if (path === '') return obj;
  const segments = path.split('.');
  let cur: unknown = obj;
  for (const seg of segments) {
    if (cur === null || cur === undefined || typeof cur !== 'object') {
      return undefined;
    }
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

/**
 * 深拷贝（仅处理 JSON 可表达的结构 + 普通对象/数组）。
 */
export function deepClone<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => deepClone(v)) as unknown as T;
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepClone(v);
    }
    return out as unknown as T;
  }
  return value;
}
