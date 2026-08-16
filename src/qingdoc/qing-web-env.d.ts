interface ImportMetaEnv {
  readonly MODE: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

interface Window {
  electron?: {
    isDesktop: boolean
    dataOrigin?: string | null
    getBackendConnection?: () => {
      mode: string
      status: string
      effectiveCapabilities: {
        folderSelection?: boolean
        skillMutation?: boolean
        connectors?: boolean
      }
    } | null
    onBackendConnectionChanged?: (listener: (snapshot: {
      mode: string
      status: string
      effectiveCapabilities: {
        folderSelection?: boolean
        skillMutation?: boolean
        connectors?: boolean
      }
    }) => void) => () => void
  }
  showDirectoryPicker?: (options?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>
}
