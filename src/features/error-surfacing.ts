/**
 * 失败可见化（C 能力）核心工具。
 *
 * 当 `editMessage` / `sendMessage` 抛出「消息级」错误（如 messageId 不存在、
 * 权限被撤销等）时，向用户发送一条可读的失败提示。
 *
 * 关键：短延迟抑制。ChatLuna 内部会自动重试；如果延迟窗口内有新的成功
 * outbound，则抑制这次错误提示，避免"用户看到失败 → 又看到正常回复"的错位。
 */

/**
 * 判定错误是否属于「消息级」错误，值得展示给用户。
 *
 * 常见飞书消息级错误码：
 * - 230001 消息不存在
 * - 230003 消息已被撤回或删除
 * - 230004 未加入群
 * - 230005 无权发送
 * - 230006 消息内容非法
 * - 230007 消息过大
 * - 230008 触发限流
 * - 230010 图片/文件资源已过期
 * - 230011 群已解散
 * - 230018 消息类型不支持
 * - 230072 已由 B 能力处理（不到这里）
 *
 * 传输级错误（网络、5xx、超时）返回 false，交给 ChatLuna 自己重试。
 */
export function isSurfaceableError(error: unknown): boolean {
  const anyError = error as any
  const code = anyError?.response?.data?.code
  if (typeof code !== 'number') return false
  // 230072 由续接处理，不走 C
  if (code === 230072) return false
  // 4xx 里可暴露的消息级错误：飞书的 2300xx 段基本都是"消息级"
  if (code >= 230000 && code < 240000) return true
  return false
}

/**
 * 从飞书 HTTP 错误中提取 code / msg。
 */
export function extractLarkErrorInfo(error: unknown): { code: number | string; msg: string } {
  const anyError = error as any
  const code = anyError?.response?.data?.code ?? 'unknown'
  const msg = anyError?.response?.data?.msg ?? (anyError?.message ?? 'unknown error')
  return { code, msg }
}

/**
 * 用模板生成错误提示文本。模板支持 `{code}` 和 `{msg}` 两个占位符。
 */
export function formatErrorMessage(
  template: string,
  info: { code: number | string; msg: string },
): string {
  return template
    .replace(/\{code\}/g, String(info.code))
    .replace(/\{msg\}/g, info.msg)
}

/** 排队中的错误提示条目。 */
interface PendingErrorEntry {
  channelId: string
  content: string
  timer: NodeJS.Timeout
  createdAt: number
}

/**
 * 错误提示排队 + 抑制状态。挂在 LarkBot 上。
 *
 * 生命周期：
 * 1. 错误发生 -> `enqueue(channelId, content, delayMs, deliver)`
 *    - 延迟 delayMs 后调用 deliver 发送提示
 * 2. 同会话有成功 outbound -> `consume(channelId)`
 *    - 撤销排队的提示，deliver 不会被调用
 * 3. bot dispose -> `clear()`
 *    - 清理所有 timer
 */
export class ErrorSurfacingState {
  private readonly pending = new Map<string, PendingErrorEntry>()

  /**
   * 排队错误提示。如果同 channel 已有排队条目，替换（保留最新一次错误）。
   */
  enqueue(
    channelId: string,
    content: string,
    delayMs: number,
    deliver: (channelId: string, content: string) => Promise<void>,
  ): void {
    // 先清掉已有的
    this.consume(channelId)
    const timer = setTimeout(() => {
      this.pending.delete(channelId)
      deliver(channelId, content).catch(() => {
        // deliver 失败已经在调用侧 log 了，这里不再抛
      })
    }, delayMs)
    this.pending.set(channelId, {
      channelId,
      content,
      timer,
      createdAt: Date.now(),
    })
  }

  /**
   * 消费/撤销该 channel 上排队中的错误提示。
   * 返回 true 表示确实抑制了一条提示。
   */
  consume(channelId: string): boolean {
    const entry = this.pending.get(channelId)
    if (!entry) return false
    clearTimeout(entry.timer)
    this.pending.delete(channelId)
    return true
  }

  /** 清空所有排队 + timer。bot dispose 用。 */
  clear(): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer)
    }
    this.pending.clear()
  }
}
