import { defineConfig } from 'vitest/config'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// 青简仓位置:默认 vendor/qingagent submodule,环境变量 QING_ROOT 可覆盖(与构建/提取脚本一致)。
const qingRoot = process.env.QING_ROOT ?? resolve('vendor/qingagent')
const qingWebSource = `${qingRoot}/apps/web/src`
const systemSource = `${qingWebSource}/system`
const systemShim = resolve('src/qingdoc/shims/system.tsx')
const uploadAssetSource = `${qingWebSource}/pages/workspace/data/uploadAsset`
const uploadAssetShim = resolve('src/qingdoc/shims/uploadAsset.ts')
const assetBridgeProvider = resolve('src/qingdoc/AssetBridgeProvider.tsx')
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
      { find: /^@deepseek-ai\/dsh-client-runtime\/client$/, replacement: resolve('tests/stubs/dsh-client-runtime-client.ts') },
      { find: /^react$/, replacement: resolve('node_modules/react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve('node_modules/react/jsx-runtime.js') },
      { find: /^react-dom$/, replacement: resolve('node_modules/react-dom/index.js') },
      { find: /^react-dom\/client$/, replacement: resolve('node_modules/react-dom/client.js') },
      ...tiptapAliases,
      { find: /^@qingagent\/ui-kit$/, replacement: `${qingRoot}/packages/ui-kit/src/index.ts` },
      { find: '@qingagent/pm-schema/tiptap', replacement: `${qingRoot}/packages/pm-schema/src/tiptap/createQingagentExtensions.ts` },
      { find: '@qingagent/pm-schema', replacement: `${qingRoot}/packages/pm-schema/src/index.ts` },
      { find: '@qingagent/contract-ts/schemas', replacement: `${qingRoot}/packages/contract-ts/src/schemas/index.ts` },
      { find: '@qingagent/contract-ts', replacement: `${qingRoot}/packages/contract-ts/src/index.ts` },
      { find: '@qingagent/diagram-engine', replacement: `${qingRoot}/packages/diagram-engine/src/index.ts` },
      { find: '@qingweb', replacement: qingWebSource },
      { find: '@qingcore', replacement: `${qingRoot}/packages/core/src` },
    ],
  },
  plugins: [{
    name: 'qing-source-test-bridge',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer?.startsWith(qingWebSource) || !source.startsWith('.')) return null
      const target = resolve(dirname(importer), source)
      if (target === uploadAssetSource) return uploadAssetShim
      return target === systemSource || target === `${systemSource}/ConfirmProvider` || target === `${systemSource}/ToastProvider`
        ? systemShim
        : null
    },
    transform(code, id) {
      if (id.endsWith('/DocumentSnapshotView.tsx')) {
        return code.replace('import { chatInputBus } from "../../../system";\n', '')
      }
      if (id.endsWith('/ImageView.tsx')) {
        // 新版真源自带 renderedSrc = desktopDataUrl(src)(桌面数据 URL);插件语境资产走 bridge。
        return `import { useAssetBridgeSource } from ${JSON.stringify(assetBridgeProvider)};\n${code}`
          .replaceAll('const renderedSrc = desktopDataUrl(src);', 'const renderedSrc = useAssetBridgeSource(src);')
      }
      return null
    },
  }],
  test: {
    // vendor/qingagent 作为源码依赖参与编译，但上游仓测试不属于本插件测试套件。
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    server: {
      deps: {
        inline: [/@tiptap\/react/],
      },
    },
    coverage: { reporter: ['text', 'json-summary'] },
  },
})
