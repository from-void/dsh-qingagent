import { builtinModules, createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { basename, dirname, extname, resolve as resolvePath } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

const require = createRequire(import.meta.url)
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]
const NODE_BUILTINS = new Set([...builtinModules, ...builtinModules.map((id) => `node:${id}`)])
const INLINE_SAFE = /^@deepseek-ai\/dsh-(session|llm|tools|brand)(\/|$)/
const CSS_PREFIX = '\0dsh-qing-css:'
const CSS_SUFFIX = '.mjs'
const QING_ROOT = '/home/jimmy/proj/qingagent/wt/dsh-bridge'
const QING_WEB_SOURCE = `${QING_ROOT}/apps/web/src`
const QING_SYSTEM_SOURCE = `${QING_WEB_SOURCE}/system`
const QING_UPLOAD_ASSET_SOURCE = `${QING_WEB_SOURCE}/pages/workspace/data/uploadAsset`
const QING_PANEL_SELECTOR = '[data-qingagent-doc-panel]'
const FFLATE_BROWSER = resolvePath(dirname(require.resolve('fflate/package.json')), 'esm/browser.js')
const UUID_BROWSER = resolvePath(dirname(require.resolve('uuid/package.json')), 'dist/esm-browser/index.js')
const QING_SOURCE_ALIASES = {
  fflate: FFLATE_BROWSER,
  uuid: UUID_BROWSER,
  '@qingagent/contract-ts/schemas': `${QING_ROOT}/packages/contract-ts/src/schemas/index.ts`,
  '@qingagent/contract-ts': `${QING_ROOT}/packages/contract-ts/src/index.ts`,
  '@qingagent/diagram-engine': `${QING_ROOT}/packages/diagram-engine/src/index.ts`,
  '@qingagent/pm-schema/tiptap': `${QING_ROOT}/packages/pm-schema/src/tiptap/createQingagentExtensions.ts`,
  '@qingagent/pm-schema': `${QING_ROOT}/packages/pm-schema/src/index.ts`,
  '@qingweb': QING_WEB_SOURCE,
  '@qingcore': `${QING_ROOT}/packages/core/src`,
}

type BuildPlugin = NonNullable<UserConfig['plugins']>

function purityGate(): BuildPlugin {
  return {
    name: 'dsh-qingagent-client-purity',
    resolveId(source: string, importer?: string) {
      if (NODE_BUILTINS.has(source)) throw new Error(`客户端包不能引用 Node 内置模块：${source}（来自 ${importer ?? 'unknown'}）`)
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source) || INLINE_SAFE.test(source)) return null
      throw new Error(`客户端包引用了未共享的 DSH 值模块：${source}`)
    },
  }
}

function qingSourceBridge(): BuildPlugin {
  const systemShim = resolvePath('src/qingdoc/shims/system.tsx')
  const uploadAssetShim = resolvePath('src/qingdoc/shims/uploadAsset.ts')
  const assetBridgeProvider = resolvePath('src/qingdoc/AssetBridgeProvider.tsx')
  const sealAsset = resolvePath('src/qingdoc/assets/seal-kongshengmiaoyou.png')
  let sealDataUri: string | undefined
  return {
    name: 'dsh-qingagent-source-bridge',
    resolveId(source: string, importer?: string) {
      if (!importer?.startsWith(QING_WEB_SOURCE) || !source.startsWith('.')) return null
      const target = resolvePath(dirname(importer), source)
      if (target === QING_UPLOAD_ASSET_SOURCE) return uploadAssetShim
      if (
        target === QING_SYSTEM_SOURCE ||
        target === `${QING_SYSTEM_SOURCE}/ConfirmProvider` ||
        target === `${QING_SYSTEM_SOURCE}/ToastProvider`
      ) {
        return systemShim
      }
      return null
    },
    async transform(code: string, id: string) {
      if (!id.startsWith(QING_WEB_SOURCE)) return null
      let next = code
      if (id.endsWith('/DocumentSnapshotView.tsx')) {
        next = next.replace('import { chatInputBus } from "../../../system";\n', '')
      }
      if (id.endsWith('/ImageView.tsx')) {
        next = `import { useAssetBridgeSource } from ${JSON.stringify(assetBridgeProvider)};\n${next}`
          .replace(
            'const src = String(node.attrs.src ?? "");',
            'const src = String(node.attrs.src ?? "");\n  const renderedSrc = useAssetBridgeSource(src);',
          )
          .replace(
            '  const normalizedAlign = normalizeImageAlign(align);',
            '  const renderedSrc = useAssetBridgeSource(src);\n  const normalizedAlign = normalizeImageAlign(align);',
          )
          .replaceAll('src={src}', 'src={renderedSrc}')
      }

      next = next
        .replaceAll('document.getElementById("view-workspace")', `document.querySelector("${QING_PANEL_SELECTOR}")`)
        .replaceAll('document.getElementById(\'view-workspace\')', `document.querySelector("${QING_PANEL_SELECTOR}")`)
        .replaceAll('"#view-workspace"', `"${QING_PANEL_SELECTOR}"`)
        .replaceAll("'#view-workspace'", `"${QING_PANEL_SELECTOR}"`)

      if (
        id.endsWith('/CodeBlockView.tsx') ||
        id.endsWith('/MediaZoomFullscreen.tsx') ||
        id.endsWith('/diagram/GraphDiagramView.tsx')
      ) {
        next = next.replace(
          /(,\n\s*)document\.body(,\n)/g,
          `$1(document.querySelector("${QING_PANEL_SELECTOR}") ?? document.body)$2`,
        )
      }
      if (id.endsWith('/ListItemDnD.ts')) {
        next = next.replaceAll(
          'document.body.classList',
          `(document.querySelector("${QING_PANEL_SELECTOR}") ?? document.body).classList`,
        )
      }
      if (id.endsWith('/drawioEditorLauncher.tsx')) {
        next = next.replace(
          'document.body.appendChild(host);',
          `(document.querySelector("${QING_PANEL_SELECTOR}") ?? document.body).appendChild(host);`,
        )
      }
      if (id.endsWith('/DocColophon.tsx')) {
        sealDataUri ??= `data:image/png;base64,${(await readFile(sealAsset)).toString('base64')}`
        next = next.replace(
          'const SEAL_SRC = "/chinese-masonry-assets/curated-backgrounds/seal-kongshengmiaoyou.png";',
          `const SEAL_SRC = ${JSON.stringify(sealDataUri)};`,
        )
      }
      return next === code ? null : { code: next, map: null }
    },
  }
}

function assetMime(filename: string): string {
  switch (extname(filename).toLowerCase()) {
    case '.woff2': return 'font/woff2'
    case '.woff': return 'font/woff'
    case '.png': return 'image/png'
    case '.svg': return 'image/svg+xml'
    default: return 'application/octet-stream'
  }
}

async function inlineLocalCssAssets(
  source: string,
  filename: string,
  addWatchFile: (filename: string) => void,
): Promise<string> {
  const matches = [...source.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)]
  let result = source
  for (const match of matches) {
    const url = match[2]!
    if (/^(?:data:|https?:|#|\/)/.test(url)) continue
    const asset = resolvePath(dirname(filename), url)
    addWatchFile(asset)
    const dataUri = `data:${assetMime(asset)};base64,${(await readFile(asset)).toString('base64')}`
    result = result.replace(match[0], `url(${JSON.stringify(dataUri)})`)
  }
  return result
}

function cssPlugin(pluginId: string): BuildPlugin {
  return {
    name: 'dsh-qingagent-css-inline',
    resolveId(source: string, importer?: string) {
      if (!source.endsWith('.css')) return null
      const absolute = source.startsWith('.') || source.startsWith('/')
        ? resolvePath(importer ? dirname(importer) : '.', source)
        : require.resolve(source)
      return `${CSS_PREFIX}${absolute}${CSS_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(filename)
      let source = await readFile(filename, 'utf8')
      source = await inlineLocalCssAssets(source, filename, (asset) => this.addWatchFile(asset))
      if (filename.startsWith(`${QING_WEB_SOURCE}/pages/workspace/`)) {
        source = `@scope (${QING_PANEL_SELECTOR}) {\n${source}\n}`
      }
      const { code, exports } = transform({
        filename,
        code: Buffer.from(source),
        cssModules: filename.endsWith('.module.css') ? { pattern: '[hash]_[local]' } : undefined,
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, value] of Object.entries(exports ?? {})) classMap[local] = (value as { name: string }).name
      const tagId = `${pluginId}/${basename(filename)}`
      return [
        `const css=${JSON.stringify(code.toString())};`,
        `const tagId=${JSON.stringify(tagId)};`,
        `if(typeof document!=="undefined"&&!document.querySelector('style[data-plugin-css="'+tagId+'"]')){const tag=document.createElement("style");tag.dataset.plugin=${JSON.stringify(pluginId)};tag.dataset.pluginCss=tagId;tag.textContent=css;document.head.appendChild(tag);}`,
        `export default ${JSON.stringify(classMap)};`,
      ].join('\n')
    },
  }
}

const client: UserConfig = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  dts: false,
  clean: false,
  sourcemap: true,
  external: CLIENT_EXTERNALS,
  noExternal: (id: string) => CLIENT_EXTERNALS.includes(id) ? undefined : true,
  alias: QING_SOURCE_ALIASES,
  inputOptions: { resolve: { conditionNames: ['browser', 'import', 'require', 'default'] } },
  plugins: [qingSourceBridge(), purityGate(), cssPlugin('dsh-qingagent')],
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    'import.meta.resolve': 'undefined',
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-qingagent", factory: (require) => {',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
    codeSplitting: false,
  },
}

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: 'esm',
    platform: 'node',
    target: 'es2023',
    fixedExtension: false,
    dts: false,
    clean: false,
    external: [/^@deepseek-ai\//, 'zod'],
  },
  client,
] satisfies UserConfig[]
