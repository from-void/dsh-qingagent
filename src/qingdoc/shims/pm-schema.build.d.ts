export interface PmDoc {
  type: 'doc'
  attrs: { schemaVersion: 1 }
  content: Array<Record<string, unknown>>
}
