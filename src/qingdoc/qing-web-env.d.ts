interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface ElectronBackendConnectionSnapshot {
  mode: 'embedded' | 'attach'
  status:
    | 'connecting' | 'authenticating' | 'attached' | 'revalidating'
    | 'reauthenticating' | 'dead' | 'incompatible' | 'conflict'
  generation: number
  libraryId: string | null
  instanceId: string | null
  effectiveCapabilities: Record<string, boolean>
  errorCode: string | null
  conflictKind: 'pending-conflict' | 'conflict' | null
}

interface Window {
  electron?: {
    isDesktop: boolean
    dataOrigin?: string
    getBackendConnection?: () => ElectronBackendConnectionSnapshot | null
    onBackendConnectionChanged?: (
      callback: (snapshot: ElectronBackendConnectionSnapshot) => void,
    ) => () => void
  }
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
