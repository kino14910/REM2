/**
 * 内核版本与契约版本常量（单一事实源）。
 *
 * - `KERNEL_VERSION`：内核实现版本，遵循 semver。
 * - `CONTRACT_VERSION`：插件契约版本，仅比较 major（见 docs/02 §C.3）。
 * - `KERNEL_ID`：内核实例默认 id。
 */

/** 内核实现版本（semver）。 */
export const KERNEL_VERSION = '1.0.0';

/** 插件契约版本（整数 major；只允许加法演进）。 */
export const CONTRACT_VERSION = '1';

/** 内核默认 id。 */
export const KERNEL_ID = 'rem2-kernel';

/** 主推的插件清单文件名。 */
export const MANIFEST_FILENAME = 'plugin.json';

/** 兼容逃生舱：旧式清单文件名（默认关闭）。 */
export const LEGACY_MANIFEST_FILENAME = 'manifest.json';
