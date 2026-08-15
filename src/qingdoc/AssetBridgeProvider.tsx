import { createContext, useContext, type ReactNode } from 'react'
import {
  assetBridgeUrl,
  isEngineAssetReference,
  type AssetBridgeContext,
} from '../assetBridge.js'

const Context = createContext<AssetBridgeContext | null>(null)

export function AssetBridgeProvider({
  context,
  children,
}: {
  context: AssetBridgeContext | null
  children: ReactNode
}) {
  return <Context.Provider value={context}>{children}</Context.Provider>
}

/** ImageView 仅在 DOM 层换加载地址，PM attrs.src 始终保持青简 schema 允许的内部引用。 */
export function useAssetBridgeSource(source: string): string {
  const context = useContext(Context)
  return context && isEngineAssetReference(source) ? assetBridgeUrl(context, source) : source
}
