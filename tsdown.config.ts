import { builtinModules, createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
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

type BuildPlugin = NonNullable<UserConfig['plugins']>

function purityGate(): BuildPlugin {
  return {
    name: 'dsh-qingagent-client-purity',
    resolveId(source: string) {
      if (NODE_BUILTINS.has(source)) throw new Error(`客户端包不能引用 Node 内置模块：${source}`)
      if (!source.startsWith('@deepseek-ai/')) return null
      if (CLIENT_EXTERNALS.includes(source) || INLINE_SAFE.test(source)) return null
      throw new Error(`客户端包引用了未共享的 DSH 值模块：${source}`)
    },
  }
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
      const source = await readFile(filename)
      const { code, exports } = transform({
        filename,
        code: source,
        cssModules: { pattern: '[hash]_[local]' },
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
  inputOptions: { resolve: { conditionNames: ['browser', 'import', 'require', 'default'] } },
  plugins: [purityGate(), cssPlugin('dsh-qingagent')],
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
