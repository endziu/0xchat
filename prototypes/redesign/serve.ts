// PROTOTYPE — `bun prototypes/redesign/serve.ts`, then open the printed URL.
// Listens on the LAN too, so a phone on the same network can open it.
import { networkInterfaces } from 'node:os'
import board from './index.html'

const port = Number(process.env.REDESIGN_PORT ?? 4173)
Bun.serve({ port, hostname: '0.0.0.0', development: true, routes: { '/': board } })

const lan = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
console.log(`0xChat redesign prototype\n  http://localhost:${port}/${lan ? `\n  http://${lan}:${port}/  (phone on the same network)` : ''}`)
