/**
 * Electron 渲染进程入口（可选外壳，最小 demo）。
 *
 * 用原生 DOM 呈现一个输入框：输入命令 → 经 preload 的 `window.rem2.execute` 转发到内核。
 * 外壳是插件载体，内核不关心 UI（docs/02 §M.5）。
 */

interface Rem2Api {
  execute(method: string, args?: unknown): Promise<unknown>;
  onBroadcast(handler: (payload: unknown) => void): () => void;
}

declare global {
  interface Window {
    rem2?: Rem2Api;
  }
}

const app = document.getElementById('app');
if (app) {
  app.innerHTML = `
    <main style="font-family: system-ui; padding: 24px; color: #e6e6e6; background: #0f1115; min-height: 100vh;">
      <h1 style="margin: 0 0 12px;">rem2 内核控制台</h1>
      <p style="color: #9aa4b2; margin: 0 0 16px;">
        Electron 仅为可选外壳；内核与插件系统可独立运行。
      </p>
      <form id="cmd-form" style="display: flex; gap: 8px; margin-bottom: 16px;">
        <input id="cmd-input" value="hello" style="flex: 1; padding: 8px; background: #161922; color: #e6e6e6; border: 1px solid #232838; border-radius: 6px;" />
        <button type="submit" style="padding: 8px 16px; background: #4f9cf9; color: #0f1115; border: 0; border-radius: 6px; cursor: pointer;">执行</button>
      </form>
      <pre id="output" style="background: #161922; border: 1px solid #232838; border-radius: 6px; padding: 12px; white-space: pre-wrap;"></pre>
    </main>
  `;

  const form = document.getElementById('cmd-form') as HTMLFormElement | null;
  const input = document.getElementById('cmd-input') as HTMLInputElement | null;
  const output = document.getElementById('output');

  const append = (text: string): void => {
    if (output) output.textContent = `${output.textContent ?? ''}${text}\n`;
  };

  if (window.rem2) {
    window.rem2.onBroadcast((payload) => {
      append(`[broadcast] ${JSON.stringify(payload)}`);
    });
  }

  form?.addEventListener('submit', (e) => {
    e.preventDefault();
    const command = input?.value ?? 'hello';
    if (!window.rem2) {
      append('未检测到 Electron preload 桥（在纯浏览器/测试环境运行）');
      return;
    }
    window.rem2
      .execute('command:execute', { command })
      .then((result) => append(`[ok] ${JSON.stringify(result)}`))
      .catch((error: Error) => append(`[error] ${error.message}`));
  });
}
