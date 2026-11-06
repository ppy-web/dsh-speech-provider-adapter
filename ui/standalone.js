import { mountManager } from './app.js'

const dispose = mountManager(document)
window.addEventListener('pagehide', dispose, { once: true })
