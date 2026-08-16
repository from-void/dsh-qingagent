import { useEffect, useMemo, useRef } from 'react'
import type { Editor } from '@tiptap/react'
import type { AnnotationGroup } from '@qingagent/contract-ts'
import type { ExternalAnnotation } from '../contracts.js'
import { AnnotationCarousel } from '@qingweb/pages/workspace/components/AnnotationCarousel'
import {
  installAnnotationGroupDecorations,
  updateAnnotationGroupDecorations,
} from '@qingweb/pages/workspace/data/annotationDecorations'

export function externalAnnotationsToGroups(
  annotations: readonly ExternalAnnotation[],
): AnnotationGroup[] {
  return annotations.map((annotation) => ({
    ...annotation,
    anchors: annotation.anchors.map((anchor) => ({
      ...anchor,
      // external 的公开锚契约省略 textHash；产品装饰器只消费 PM 坐标/quote，
      // 这里保留新版引擎可能透传的值，并为旧契约补齐产品类型所需占位。
      textHash: 'textHash' in anchor && typeof anchor.textHash === 'string'
        ? anchor.textHash
        : '',
    })),
  }))
}

export function QingAnnotationCarousel(props: {
  annotations: readonly ExternalAnnotation[]
  editor: Editor | null
  onAccept: (group: AnnotationGroup, suggestion: string) => boolean
  onIgnore: (group: AnnotationGroup) => void
}) {
  const groups = useMemo(
    () => externalAnnotationsToGroups(props.annotations),
    [props.annotations],
  )
  const groupsRef = useRef(groups)
  groupsRef.current = groups

  useEffect(() => {
    const editor = props.editor
    if (!editor || editor.isDestroyed) return
    return installAnnotationGroupDecorations(editor, groupsRef.current)
    // 权威 annotations 换代走下方原子 update；这里只随编辑器实例装卸插件。
  }, [props.editor])

  useEffect(() => {
    const editor = props.editor
    if (!editor || editor.isDestroyed) return
    updateAnnotationGroupDecorations(editor, groups)
  }, [groups, props.editor])

  if (!groups.some((group) => group.status === 'reviewing')) return null
  return (
    <AnnotationCarousel
      groups={groups}
      editorDom={props.editor && !props.editor.isDestroyed ? props.editor.view.dom : null}
      onAccept={props.onAccept}
      onIgnore={props.onIgnore}
    />
  )
}
