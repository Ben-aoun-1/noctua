import { buildServer } from "./server.js"
import { config } from "./config.js"

const app = await buildServer()
await app.listen({ port: config.port, host: "0.0.0.0" })
console.log(`noctua listening on http://0.0.0.0:${config.port}`)
