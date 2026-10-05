import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'path'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

function serveGameModels() {
  const modelsDir = path.resolve(__dirname, 'game/models')

  const handler = (req, res, next) => {
    const pathname = decodeURIComponent((req.url ?? '/').split('?')[0])
    const relativePath = pathname.replace(/^\/models\//, '').replace(/^\//, '')
    if (!relativePath) {
      next()
      return
    }

    const filePath = path.resolve(modelsDir, relativePath)
    const relativeToModels = path.relative(modelsDir, filePath)
    if (relativeToModels.startsWith('..') || path.isAbsolute(relativeToModels)) {
      next()
      return
    }

    fs.stat(filePath, (error, stat) => {
      if (error || !stat.isFile()) {
        next()
        return
      }

      res.statusCode = 200
      const contentType = filePath.toLowerCase().endsWith('.png')
        ? 'image/png'
        : 'model/gltf-binary';
      res.setHeader('Content-Type', contentType);
      res.setHeader('Content-Length', stat.size)
      fs.createReadStream(filePath).pipe(res)
    })
  }

  return {
    name: 'serve-game-models',
    configureServer(server) {
      server.middlewares.use('/models', handler)
    },
    configurePreviewServer(server) {
      server.middlewares.use('/models', handler)
    },
  }
}


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  plugins: [
    serveGameModels(),
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],
})
