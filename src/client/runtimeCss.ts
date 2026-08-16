// dsh 的插件 CSS 注入管线会剥掉 backdrop-filter 与 ::-webkit-scrollbar 伪元素规则
// (实测:打包产物里有、CSSOM 里整段消失)。这里绕开管线,面板挂载时直接向
// document.head 追加原生 <style>,浏览器自行解析,不经任何转换。
const RUNTIME_STYLE_ID = 'qingdoc-runtime-css'

const RUNTIME_CSS = `
[data-qingagent-doc-panel] .patch-nav:not(.is-confirming) {
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
}
[data-qingagent-doc-panel] .ws-find-bar {
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
}
/* 青简 workspace-ink-skin.css:2558-2575；导出/审查菜单绕过 dsh CSS 管线。 */
[data-qingagent-doc-panel] .ws-export-menu {
  backdrop-filter: blur(18px) saturate(1.3);
  -webkit-backdrop-filter: blur(18px) saturate(1.3);
}
/* 青简 workspace-ink-skin.css:2584-2593,2632-2636；管线可能剥 @keyframes。 */
@keyframes ws-export-pop {
  from { opacity: 0; transform: translateY(-6px) scale(0.96); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}
@keyframes ws-export-spin {
  to { transform: rotate(360deg); }
}
[data-qingagent-doc-panel] .ws-right::-webkit-scrollbar { width: 10px; }
[data-qingagent-doc-panel] .ws-right::-webkit-scrollbar-thumb {
  background: rgba(120, 90, 50, .38);
  border-radius: 5px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
[data-qingagent-doc-panel] .ws-right::-webkit-scrollbar-thumb:hover {
  background: rgba(120, 90, 50, .6);
  background-clip: padding-box;
}
[data-qingagent-doc-panel] .ws-right::-webkit-scrollbar-track { background: transparent; }
/* P20:超长标题(百字级)与长英文串强制可折行,防纸面横向溢出裁切正文。 */
[data-qingagent-doc-panel] :is(.wf-doc, .doc-typography) :is(h1, h2, h3) {
  overflow-wrap: anywhere;
  word-break: break-word;
}
/* 写作/繁忙态内发光呼吸(青简原版 ws-paper-breathe 逐值移植):亮起规则的全部视觉在
   keyframes 的 box-shadow 里,dsh 管线可能剥 @keyframes(同 backdrop-filter 前科),
   故整段走运行时注入并改名防撞。 */
:is([data-qingagent-doc-panel][data-tool="agentBusy"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow,
:is([data-qingagent-doc-panel][data-tool="imageProgress"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow,
:is([data-qingagent-doc-panel][data-patch-revealing="1"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow {
  /* !important:基础规则(opacity:0)在 dsh 的 constructed stylesheet 里,同 specificity 平局必输。 */
  opacity: 1 !important;
  animation: qingdoc-paper-breathe 3.6s ease-in-out infinite;
}
@keyframes qingdoc-paper-breathe {
  0%,
  100% {
    box-shadow:
      inset 0 0 42px 6px rgba(181, 154, 99, 0.32),
      inset 0 0 100px 20px rgba(181, 154, 99, 0.16);
  }
  28% {
    box-shadow:
      inset 0 0 54px 11px rgba(203, 170, 108, 0.44),
      inset 0 0 118px 26px rgba(203, 170, 108, 0.2);
  }
  55% {
    box-shadow:
      inset 0 0 54px 11px rgba(120, 156, 142, 0.4),
      inset 0 0 118px 26px rgba(120, 156, 142, 0.18);
  }
  80% {
    box-shadow:
      inset 0 0 48px 9px rgba(178, 128, 104, 0.4),
      inset 0 0 110px 22px rgba(178, 128, 104, 0.17);
  }
}
@media (prefers-reduced-motion: reduce) {
  :is([data-qingagent-doc-panel][data-tool="agentBusy"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow,
  :is([data-qingagent-doc-panel][data-tool="imageProgress"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow,
  :is([data-qingagent-doc-panel][data-patch-revealing="1"], #qingagent-doc-panel-specificity) .ws-paper-surface > .ws-editor-glow {
    animation: none;
    box-shadow:
      inset 0 0 42px 6px rgba(181, 154, 99, 0.32),
      inset 0 0 100px 20px rgba(181, 154, 99, 0.16);
  }
}
`

export function ensureQingdocRuntimeCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(RUNTIME_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = RUNTIME_STYLE_ID
  style.textContent = RUNTIME_CSS
  document.head.appendChild(style)
}
