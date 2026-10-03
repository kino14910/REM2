/**
 * 服务令牌（运行时容器键）。内部再导出契约层的 `ServiceToken`，
 * 使内核实现层与契约层共用同一个令牌类型。
 */

export { ServiceToken } from '../contracts/service-token.js';
export type {
  ServiceDescriptor,
  ServiceFactory,
  Lifetime as LifetimeType,
} from '../contracts/service-token.js';
