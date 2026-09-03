import { createApp } from './app.js'
import { env } from './config/env.js'
import fs from 'node:fs'
import path from 'node:path'

const uploadDir = path.resolve(env.UPLOAD_DIR)
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true })
}

const app = createApp()

app.listen(env.PORT, () => {
  console.log(`API server running on http://localhost:${env.PORT}`)
})
