/**
 * 插件 API 实现（docs/02 §J.4，动机 #7）。
 *
 * - `export/unexport`：把本插件服务标记为可导出，并登记所需能力。
 * - `useCapability`：经 CapabilityGuard 校验后解析其他插件导出的服务。
 * - `registerCapability`：运行期登记能力实现（供能力发现）。
 *
 * 安全要点（动机 #7）：插件**不得**取得父容器引用。因此"导出后反向挂载到父容器"
 * 这一动作由内核通过注入的 `hooks` 完成，插件 API 自身不持有也不读取父容器。
 */

import type { PluginApi, ExportOptions } from '../contracts/context.js';
import type { ServiceToken } from '../contracts/service-token.js';
import type { Container } from '../di/container.js';
import type { CapabilityGuard } from '../security/capability-guard.js';

/** 内核注入的挂载钩子（由内核持有 root 容器并完成挂载）。 */
export interface PluginApiHooks {
  /** 把插件子容器挂载到父容器，使其余插件可解析其导出项。 */
  mountExported(child: Container): void;
  /** 卸载插件子容器（当其不再导出任何服务时）。 */
  unmountExported(child: Container): void;
}

/**
 * 插件 API 实现。
 */
export class PluginApiImpl implements PluginApi {
  private readonly capabilities = new Map<string, unknown>();

  constructor(
    private readonly pluginId: string,
    private readonly container: Container,
    private readonly guard: CapabilityGuard,
    private readonly hooks: PluginApiHooks,
  ) {}

  export<T>(token: ServiceToken<T>, opts?: ExportOptions): void {
    // 1) 标记本服务可被导出（父容器解析时可下探到子容器）。
    this.container.markExported(token);
    // 2) 反向挂载：由内核把本子容器挂到父容器，从而让**兄弟插件**也能解析到。
    this.hooks.mountExported(this.container);
    // 3) 登记该服务所需能力（消费方解析时将被代理校验）。
    if (opts?.capability) {
      this.guard.declareServiceCapability(token.id, opts.capability);
    }
  }

  unexport<T>(token: ServiceToken<T>): void {
    this.container.markUnexported(token);
    this.guard.retractServiceCapability(token.id);
    // 仅当本容器已无任何导出项时才卸载，避免影响同容器内其他已导出服务。
    if (!this.container.hasExports()) {
      this.hooks.unmountExported(this.container);
    }
  }

  useCapability<T>(token: ServiceToken<T>): T {
    // 先经能力代理校验（未授权 → 抛 CapabilityDeniedError，绝不静默放行）。
    this.guard.assert(token.id, this.pluginId);
    // 解析顺序：自身容器 → 向上委派父容器（父容器含已挂载的兄弟插件导出项）。
    return this.container.resolve(token);
  }

  registerCapability(name: string, impl: unknown): void {
    this.capabilities.set(name, impl);
  }

  /** 读取本插件登记的能力（内核/测试用）。 */
  getCapability(name: string): unknown {
    return this.capabilities.get(name);
  }

  listCapabilities(): string[] {
    return Array.from(this.capabilities.keys()).sort();
  }
}
