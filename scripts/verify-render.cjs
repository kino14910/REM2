/**
 * Renderer white-screen verification: load the BUILT ARTIFACTS with a real Electron,
 * capture the renderer console output and the actual DOM of #app, directly falsifying
 * or confirming a "white screen".
 *
 * Purpose (do not delete): tests/contract/build-artifact.test.ts only asserts STATICALLY
 * (the sourcemap contains no server-side svelte) — cheap and CI-friendly, but it cannot
 * prove "it really rendered". This script adds the runtime half.
 * The two complement each other: the static check guards against regression, this
 * script proves the final result.
 *
 * Prerequisite: `pnpm build:renderer` (artifacts must exist).
 * Usage: unset ELECTRON_RUN_AS_NODE && pnpm verify:render
 *
 * Environment pitfalls hit on this machine (all handled here):
 *   1. Must be .cjs — Electron only injects its built-in modules at CJS entries;
 *      in an ESM entry require('electron') returns a path string.
 *   2. Must unset ELECTRON_RUN_AS_NODE — this machine sets it, which degrades
 *      electron to plain node.
 *   3. Must disable GPU — otherwise "GPU process isn't usable. Goodbye." is a FATAL
 *      exit; disableHardwareAcceleration() alone is not enough, commandLine switches
 *      are required.
 *   4. The built HTML uses ABSOLUTE paths /assets/... which fail under file:// with
 *      ERR_FAILED; hence the copy to a temp dir with paths rewritten to relative.
 *
 * On headless CI this fails (it needs a desktop session and GPU). For CI, rely on the
 * static checks in tests/contract/build-artifact.test.ts instead.
 *
 * Verdict: lifecycle_function_unavailable in console, or #app having zero children => white screen.
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.resolve('.vite/renderer/main_window')

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')
app.commandLine.appendSwitch('disable-gpu-compositing')
app.commandLine.appendSwitch('disable-software-rasterizer')
app.commandLine.appendSwitch('in-process-gpu')
app.commandLine.appendSwitch('no-sandbox')

const errors = []
const logs = []

/** Copy artifacts to a temp dir and rewrite /assets/... to ./assets/... for file:// loading. */
function stageBuild() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rem2-verify-'))
  fs.cpSync(ROOT, dir, { recursive: true })
  const htmlPath = path.join(dir, 'index.html')
  const html = fs
    .readFileSync(htmlPath, 'utf8')
    .replace(/(src|href)="\/(?!\/)/g, '$1="./')
  fs.writeFileSync(htmlPath, html)
  return dir
}

/**
 * Only check the chunk index.html ACTUALLY references.
 *
 * Why per-file: Vite's outDir may retain STALE chunks from the previous build (content-hashed
 * names), while index.html references only one of them. `grep -c pattern *.js` counts every
 * file, so "one clean, one stale" reads as "fix failed" — while at runtime the clean one may
 * well be the only one ever loaded. Conversely, if index.html references exactly the stale
 * chunk, it really is broken.
 */
function assertReferencedChunkIsClean(dir) {
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8')
  const refs = [...html.matchAll(/(?:src|href)="\.\/([^"]+\.js)"/g)].map(
    m => m[1],
  )
  if (refs.length === 0) {
    console.log('! index.html references no js chunk, skipping static check')
    return true
  }
  const chunks = fs
    .readdirSync(path.join(dir, 'assets'))
    .filter(f => f.endsWith('.js'))
  let clean = true
  for (const f of chunks) {
    const code = fs.readFileSync(path.join(dir, 'assets', f), 'utf8')
    const isServer =
      code.includes('index-server') ||
      code.includes('lifecycle_function_unavailable')
    const isReferenced = refs.includes(`assets/${f}`)
    const tag = isReferenced
      ? '<- loaded by index.html'
      : '(stale leftover, not referenced)'
    console.log(
      `  ${f}: ${isServer ? 'x contains server-side svelte' : 'ok client build'}  ${tag}`,
    )
    // Only "referenced AND server-flavored" counts as truly broken.
    if (isReferenced && isServer) clean = false
  }
  return clean
}

app.whenReady().then(async () => {
  const dir = stageBuild()
  const page = `file:///${path.join(dir, 'index.html').replace(/\\/g, '/')}`

  console.log(
    '=== static check: per-chunk (only the one index.html actually references) ===',
  )
  const staticOk = assertReferencedChunkIsClean(dir)
  if (!staticOk)
    console.log('x the referenced chunk contains server-side svelte')

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  win.webContents.on('console-message', (_e, level, message) => {
    logs.push(message)
    if (level >= 2) errors.push(`[level=${level}] ${message}`) // 2=warning 3=error
  })
  win.webContents.on('render-process-gone', (_e, d) =>
    errors.push('render-process-gone: ' + d.reason),
  )
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    errors.push(`did-fail-load code=${code} desc=${desc} url=${url}`),
  )

  try {
    await win.loadURL(page)
  } catch (e) {
    console.log('loadURL threw:', e.message)
  }
  await new Promise(r => setTimeout(r, 4000)) // wait for mount and first paint

  let probe
  try {
    probe = await Promise.race([
      win.webContents.executeJavaScript(`
        (() => {
          const el = document.getElementById('app');
          return {
            exists: !!el,
            childCount: el ? el.children.length : 0,
            html: el ? el.innerHTML.slice(0, 300) : '',
            textLen: el ? el.innerText.trim().length : 0,
            title: document.title,
          };
        })()
      `),
      new Promise((_, rej) =>
        setTimeout(() => rej(new Error('executeJavaScript timed out')), 15000),
      ),
    ])
  } catch (e) {
    probe = { error: e.message }
  }

  console.log('=== renderer console (warning/error) ===')
  console.log(errors.length ? errors.join('\n') : '(none)')
  console.log('=== mount result ===')
  console.log(JSON.stringify(probe, null, 2))
  const lifecycle = logs.filter(l =>
    l.includes('lifecycle_function_unavailable'),
  ).length
  console.log('=== verdict ===')
  console.log('lifecycle_function_unavailable count:', lifecycle)
  // Both runtime and static checks must pass: static catches "the referenced chunk is the
  // server build", runtime catches "it really throws / white-screens" — they complement each other.
  const ok = probe && probe.childCount > 0 && lifecycle === 0 && staticOk
  console.log(
    ok ? 'OK render succeeded, not a white screen' : 'x still a white screen',
  )

  fs.rmSync(dir, { recursive: true, force: true })
  app.exit(ok ? 0 : 1)
})
