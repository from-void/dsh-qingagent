import { aiIrToPm, qingmlParse, type PmDoc } from '@qingagent/pm-schema'

/**
 * QingML 的仓内唯一编译入口。客户端流式预览与工具侧字数验收共用，
 * 避免另造一套标签解析规则。
 */
export function compileQingmlDocument(qingml: string): PmDoc {
  const parsed = qingmlParse(qingml)
  return aiIrToPm({ blocks: parsed.blocks })
}
