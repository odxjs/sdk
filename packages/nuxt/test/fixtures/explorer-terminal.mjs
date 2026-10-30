import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import process from 'node:process'

const base = process.env.ODX_EXPLORER_CLIENT_BASE
const started = Date.now()
const server = createServer((request, response) => {
  if (request.url === base && Date.now() - started >= Number(process.env.ODX_TEST_READY_DELAY_MS || 0)) {
    response.setHeader('Content-Type', 'text/html')
    response.end('<html><script>window.__NUXT__.config={}</script></html>')
  }
  else if (request.url === `${base}status`) {
    response.setHeader('Content-Type', 'application/json')
    response.end(JSON.stringify({ pid: process.pid, base, apiBase: process.env.NUXT_PUBLIC_ODX_API_BASE, legacyTarget: process.env.ODX_EXPLORER_API_PROXY_TARGET }))
  }
  else {
    response.statusCode = 503
    response.end('The synthetic client is still starting.')
  }
})
server.on('upgrade', (request, socket) => {
  const key = request.headers['sec-websocket-key']
  if (!request.url?.startsWith(`${base}__test_hmr`) || typeof key !== 'string') {
    socket.destroy()
    return
  }
  const accept = createHash('sha1').update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64')
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
  socket.on('data', () => socket.end())
})
server.listen(0, '127.0.0.1', () => {
  const port = process.env.ODX_TEST_ANNOUNCE_PORT || String(server.address().port)
  // Deliberately split the port across chunks to test real stream framing.
  process.stdout.write(`Local: http://127.0.0.1:${port.slice(0, 2)}`)
  setTimeout(() => {
    process.stdout.write(`${port.slice(2)}/\n`)
    if (process.env.ODX_TEST_EXIT_AFTER_ANNOUNCE)
      setTimeout(() => process.exit(7), 25)
  }, 10)
})
