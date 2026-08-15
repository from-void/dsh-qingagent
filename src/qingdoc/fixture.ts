import type { PmDoc } from '@qingagent/pm-schema'

/** 第一阶段固定验收稿：覆盖青简正文岛的主要结构节点与行内 marks。 */
export const QINGDOC_FIXTURE_PM_DOC = {
  type: 'doc',
  attrs: { schemaVersion: 1 },
  content: [
    {
      type: 'heading',
      attrs: { blockId: 'fixture-h1', level: 1, anchor: 'fixture-title' },
      content: [{ type: 'text', text: '青简文档右栏移植样稿' }],
    },
    {
      type: 'paragraph',
      attrs: { blockId: 'fixture-lead' },
      content: [
        { type: 'text', text: '这是一页直接由青简 ' },
        { type: 'text', text: 'DocumentSnapshotView', marks: [{ type: 'code' }] },
        { type: 'text', text: ' 挂载的暖纸样稿，包含 ' },
        { type: 'text', text: '高亮文字', marks: [{ type: 'highlight', attrs: { color: 'amber' } }] },
        { type: 'text', text: ' 与行内公式 ' },
        { type: 'inlineMath', attrs: { latex: 'E=mc^2' } },
        { type: 'text', text: '。' },
      ],
    },
    {
      type: 'heading',
      attrs: { blockId: 'fixture-h2-structure', level: 2, anchor: 'fixture-structure' },
      content: [{ type: 'text', text: '层级、任务与提示' }],
    },
    {
      type: 'bulletList',
      attrs: { blockId: 'fixture-list' },
      content: [
        {
          type: 'listItem',
          attrs: { blockId: 'fixture-list-item-1' },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-list-item-1-p' },
              content: [{ type: 'text', text: '一级条目：正文岛保持原生列表语义' }],
            },
            {
              type: 'bulletList',
              attrs: { blockId: 'fixture-list-nested' },
              content: [
                {
                  type: 'listItem',
                  attrs: { blockId: 'fixture-list-nested-item' },
                  content: [
                    {
                      type: 'paragraph',
                      attrs: { blockId: 'fixture-list-nested-p' },
                      content: [{ type: 'text', text: '二级条目：缩进、拖拽与 blockId 均来自青简' }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        {
          type: 'listItem',
          attrs: { blockId: 'fixture-list-item-2' },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-list-item-2-p' },
              content: [{ type: 'text', text: '一级条目：同一份 PM 文档在编辑与只读间切换' }],
            },
          ],
        },
      ],
    },
    {
      type: 'taskList',
      attrs: { blockId: 'fixture-tasks' },
      content: [
        {
          type: 'taskItem',
          attrs: { blockId: 'fixture-task-done', checked: true },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-task-done-p' },
              content: [{ type: 'text', text: '纸面尺寸与暖纸令牌对齐' }],
            },
          ],
        },
        {
          type: 'taskItem',
          attrs: { blockId: 'fixture-task-open', checked: false },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-task-open-p' },
              content: [{ type: 'text', text: '下一阶段接入真实保存与流式状态' }],
            },
          ],
        },
      ],
    },
    {
      type: 'callout',
      attrs: { blockId: 'fixture-callout', emoji: '灯', tone: 'ochre' },
      content: [
        {
          type: 'paragraph',
          attrs: { blockId: 'fixture-callout-p' },
          content: [
            { type: 'text', text: '本阶段只验证岛与纸面；SSE、保存和审阅链路将在下一阶段接入。' },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { blockId: 'fixture-h2-table', level: 2, anchor: 'fixture-table' },
      content: [{ type: 'text', text: '暖色表格' }],
    },
    {
      type: 'table',
      attrs: { blockId: 'fixture-table' },
      content: [
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableHeader',
              attrs: { backgroundColor: 'amber' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { blockId: 'fixture-th-a' },
                  content: [{ type: 'text', text: '验收项', marks: [{ type: 'bold' }] }],
                },
              ],
            },
            {
              type: 'tableHeader',
              attrs: { backgroundColor: 'sand' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { blockId: 'fixture-th-b' },
                  content: [{ type: 'text', text: '目标值', marks: [{ type: 'bold' }] }],
                },
              ],
            },
          ],
        },
        {
          type: 'tableRow',
          content: [
            {
              type: 'tableCell',
              attrs: { backgroundColor: 'rose' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { blockId: 'fixture-td-a' },
                  content: [{ type: 'text', text: '纸宽 / padding' }],
                },
              ],
            },
            {
              type: 'tableCell',
              attrs: { backgroundColor: 'sage' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { blockId: 'fixture-td-b' },
                  content: [{ type: 'text', text: '800px / 52px 64px' }],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'heading',
      attrs: { blockId: 'fixture-h2-columns', level: 2, anchor: 'fixture-columns' },
      content: [{ type: 'text', text: '分栏与代码' }],
    },
    {
      type: 'columnList',
      attrs: { blockId: 'fixture-columns' },
      content: [
        {
          type: 'column',
          attrs: { blockId: 'fixture-column-left', widthRatio: 0.42 },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-column-left-p' },
              content: [
                { type: 'text', text: '左栏：宋体、直角、暖金描边。', marks: [{ type: 'italic' }] },
              ],
            },
          ],
        },
        {
          type: 'column',
          attrs: { blockId: 'fixture-column-right', widthRatio: 0.58 },
          content: [
            {
              type: 'paragraph',
              attrs: { blockId: 'fixture-column-right-p' },
              content: [
                { type: 'text', text: '右栏：NodeView、拖拽边界与结构保持青简原样。' },
              ],
            },
          ],
        },
      ],
    },
    {
      type: 'codeBlock',
      attrs: { blockId: 'fixture-code', language: 'typescript' },
      content: [{ type: 'text', text: 'const paper = { width: 800, padding: [52, 64] }\n' }],
    },
  ],
} satisfies PmDoc

export const QINGDOC_FIXTURE_SNAPSHOT = {
  version: 1,
  ts: '2026-08-15T00:00:00.000Z',
  sections: [],
  pmDoc: QINGDOC_FIXTURE_PM_DOC,
}
