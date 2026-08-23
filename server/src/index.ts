import { loadConfig } from './config.js'
import { buildApp } from './http/app.js'

const cfg = loadConfig()
const app = buildApp(cfg)

app
  .listen({ port: cfg.port, host: '127.0.0.1' })
  .then((address) => {
    process.stdout.write(`[lsgit] API listening on ${address}\n`)
  })
  .catch((err) => {
    process.stderr.write(`[lsgit] failed to start: ${String(err)}\n`)
    process.exit(1)
  })
