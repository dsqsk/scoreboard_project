// Development-only DOM harness; not a Taro H5 target and never deployed with the miniapp.
import { build } from 'esbuild'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { resolve, join } from 'node:path'

const output = resolve('.preview')
await mkdir(output, { recursive: true })
await build({
  entryPoints: ['scripts/preview/index.tsx'],
  outfile: join(output, 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  jsx: 'automatic',
  loader: { '.svg': 'dataurl' },
  alias: {
    '@tarojs/components': resolve('scripts/preview/components.tsx'),
    '@tarojs/taro': resolve('scripts/preview/taro.ts'),
  },
  define: {
    'process.env.NODE_ENV': '"development"',
    'process.env.TARO_APP_BACKEND': '"mock"',
    'process.env.TARO_APP_CLOUD_ENV': '""',
  },
})
const featureCss = await readFile(join(output, 'app.css'), 'utf8')
const css =
  (await readFile('src/styles/tokens.css', 'utf8')) +
  (await readFile('src/app.css', 'utf8')).replace(/^@import .*;$/m, '') +
  featureCss
await writeFile(
  join(output, 'app.css'),
  css.replace(/(^|\n)page(\s*\{)/g, '$1body$2') +
    `
  html{background:#dce5e1}body{margin:0;max-width:var(--preview-width,390px);margin-inline:auto;position:relative;min-height:100vh}
  #root{position:relative;min-height:100vh}div,input{box-sizing:border-box}button,input{font:inherit;cursor:pointer}button{border:0}span{box-sizing:border-box}button:disabled{cursor:default}
  .preview-header{padding:12px 16px;background:#e6eee9;color:#234439;display:flex;flex-direction:column;font:12px sans-serif;gap:4px}
  .preview-nav{display:flex;align-items:center;gap:16px;padding:6px 16px;min-height:44px}.preview-nav button{background:transparent;color:var(--muted);min-height:44px}
  .sheet-overlay{left:50%;transform:translateX(-50%);width:min(100vw,var(--preview-width,390px))}
  .preview-tools{padding:16px;color:var(--muted);font-size:12px}.preview-tools button{display:block;margin-top:8px;padding:8px}
`,
)
await writeFile(
  join(output, 'index.html'),
  `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>把分记好 · 前端走查</title><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script>var w=Number(new URLSearchParams(location.search).get('width'));if(w>=320&&w<=430)document.documentElement.style.setProperty('--preview-width',w+'px')</script><script src="/app.js"></script></body></html>`,
)
const files = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/app.js': 'app.js',
  '/app.css': 'app.css',
}
const server = createServer(async (request, response) => {
  const file = files[new URL(request.url, 'http://127.0.0.1').pathname]
  if (!file) {
    response.writeHead(404)
    response.end()
    return
  }
  response.setHeader(
    'Content-Type',
    file.endsWith('.css')
      ? 'text/css'
      : file.endsWith('.js')
        ? 'application/javascript'
        : 'text/html; charset=utf-8',
  )
  response.end(await readFile(join(output, file)))
})
server.on('error', (error) => {
  console.error(`DOM preview could not start: ${error.message}`)
  process.exitCode = 1
})
server.listen(8766, '127.0.0.1', () =>
  console.log('DOM preview: http://127.0.0.1:8766 (not WeChat runtime)'),
)
