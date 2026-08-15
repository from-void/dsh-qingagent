import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const qingRoot = '/home/jimmy/proj/qingagent/main'
const qingWebSource = `${qingRoot}/apps/web/src`
const systemSource = `${qingWebSource}/system`
const systemShim = resolve('src/qingdoc/shims/system.tsx')
const tiptapSpecifiers = [
  '@tiptap/core',
  '@tiptap/extension-code-block-lowlight',
  '@tiptap/extension-highlight',
  '@tiptap/extension-image',
  '@tiptap/extension-link',
  '@tiptap/extension-list',
  '@tiptap/extension-mathematics',
  '@tiptap/extension-placeholder',
  '@tiptap/extension-table',
  '@tiptap/extension-text-align',
  '@tiptap/extension-underline',
  '@tiptap/pm/history',
  '@tiptap/pm/model',
  '@tiptap/pm/state',
  '@tiptap/pm/tables',
  '@tiptap/pm/view',
  '@tiptap/react',
  '@tiptap/starter-kit',
]
const tiptapAliases = tiptapSpecifiers.map((specifier) => ({
  find: specifier,
  replacement: fileURLToPath(import.meta.resolve(specifier)),
}))

export default defineConfig({
  resolve: {
    dedupe: ['react', 'react-dom', '@tiptap/core', '@tiptap/pm', '@tiptap/react'],
    alias: [
      { find: /^react$/, replacement: resolve('node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve('node_modules/react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: resolve('node_modules/react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: resolve('node_modules/react-dom/client.js') },
      ...tiptapAliases,
      { find: '@qingagent/pm-schema/tiptap', replacement: `${qingRoot}/packages/pm-schema/src/tiptap/createQingagentExtensions.ts` },
      { find: '@qingagent/pm-schema', replacement: `${qingRoot}/packages/pm-schema/src/index.ts` },
      { find: '@qingagent/contract-ts/schemas', replacement: `${qingRoot}/packages/contract-ts/src/schemas/index.ts` },
      { find: '@qingagent/contract-ts', replacement: `${qingRoot}/packages/contract-ts/src/index.ts` },
      { find: '@qingagent/diagram-engine', replacement: `${qingRoot}/packages/diagram-engine/src/index.ts` },
      { find: '@qingweb', replacement: qingWebSource },
    ],
  },
  plugins: [{
    name: 'qing-source-test-bridge',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.startsWith(qingWebSource) || !source.startsWith('.')) return null
      const target = resolve(dirname(importer), source)
      return target === systemSource || target === `${systemSource}/ConfirmProvider` || target === `${systemSource}/ToastProvider`
        ? systemShim
        : null
    },
    transform(code, id) {
      if (!id.endsWith('/DocumentSnapshotView.tsx')) return null
      return code.replace('import { chatInputBus } from "../../../system";\n', '')
    },
  }],
  test: {
    environment: 'node',
    server: {
      deps: {
        inline: [/@tiptap\/react/],
      },
    },
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
