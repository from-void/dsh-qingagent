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
`

export function ensureQingdocRuntimeCss(): void {
  if (typeof document === 'undefined') return
  if (document.getElementById(RUNTIME_STYLE_ID)) return
  const style = document.createElement('style')
  style.id = RUNTIME_STYLE_ID
  style.textContent = RUNTIME_CSS
  document.head.appendChild(style)
}
