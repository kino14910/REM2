/**
 * Renderer entry: mount only, no logic.
 *
 * Note: the renderer must NOT import the kernel -- the only channel to it is
 * `window.rem2` (enforced by contract test R6). Hence this file imports only
 * Svelte and local components.
 */

import './app/global.css'
import { mount } from 'svelte'
import App from './app/App.svelte'

const target = document.getElementById('app')
if (!target) {
  throw new Error('Mount point #app not found (check index.html)')
}

export default mount(App, { target })
