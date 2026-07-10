/**
 * 编辑上限自动续接（B 能力）核心工具。
 *
 * ChatLuna 等上游插件会对同一条飞书消息高频调用 `bot.editMessage`。
 * 飞书对单条消息编辑次数有上限（返回 230072）。达到上限后，我们把后续
 * 编辑内容作为新消息发出，并维护 old → new 的重定向表，让上游后续的
 * `editMessage(oldId, ...)` 透明地作用到新消息上。
 */

/**
 * 判定异常是否为飞书 230072（单条消息编辑次数超限）。
 */
export function isEditExhausted(error: unknown): boolean {
  const anyError = error as any
  return anyError?.response?.data?.code === 230072
}

/**
 * 编辑计数与重定向表。每个 LarkBot 实例挂一份。
 */
export class EditRelayState {
  /** message_id -> 已执行的编辑次数 */
  private readonly editCounters = new Map<string, number>()

  /**
   * old message_id -> new message_id。
   * 沿链解析，可支持多次续接：A -> B -> C。
   */
  private readonly redirects = new Map<string, string>()

  /** 每个条目的最后使用时间戳（毫秒）。用于 TTL 清理。 */
  private readonly touchedAt = new Map<string, number>()

  /**
   * old message_id -> 正在进行的续接 Promise。
   * 用于串行化并发的续接请求，避免同一个消息被并发续接出多条新消息。
   */
  private readonly inflightRelays = new Map<string, Promise<string>>()

  /** 硬上限：redirect 表最大条目数。达到后 LRU 淘汰。 */
  private readonly maxRedirects: number

  constructor(maxRedirects = 1024) {
    this.maxRedirects = maxRedirects
  }

  /** 返回当前编辑计数（未编辑过为 0）。 */
  getEditCount(messageId: string): number {
    return this.editCounters.get(messageId) ?? 0
  }

  /** 记录一次成功的编辑。 */
  incrementEdit(messageId: string): number {
    const next = this.getEditCount(messageId) + 1
    this.editCounters.set(messageId, next)
    return next
  }

  /**
   * 判断本地编辑计数是否已达阈值。
   * threshold <= 0 表示禁用本地熔断。
   */
  isLocalExhausted(messageId: string, threshold: number): boolean {
    if (threshold <= 0) return false
    return this.getEditCount(messageId) >= threshold
  }

  /**
   * 记录一次续接：old → new。
   * 同时把 new 加入 touched，作为清理的锚点。
   */
  recordRedirect(oldMessageId: string, newMessageId: string): void {
    if (this.redirects.size >= this.maxRedirects) {
      // LRU 淘汰：删除 touchedAt 里最老的
      let oldestKey: string | undefined
      let oldestTs = Number.POSITIVE_INFINITY
      for (const [key, ts] of this.touchedAt) {
        if (ts < oldestTs) {
          oldestTs = ts
          oldestKey = key
        }
      }
      if (oldestKey) this.discardKey(oldestKey)
    }
    this.redirects.set(oldMessageId, newMessageId)
    this.touchedAt.set(oldMessageId, Date.now())
    this.touchedAt.set(newMessageId, Date.now())
  }

  /**
   * 沿链解析 messageId 到最新的目标。
   * 如果没有重定向记录，返回原 id。
   */
  resolve(messageId: string): string {
    const visited = new Set<string>()
    let current = messageId
    while (this.redirects.has(current)) {
      if (visited.has(current)) break // 防止循环
      visited.add(current)
      current = this.redirects.get(current)!
    }
    // touch 一下，避免刚用过的条目被 LRU 淘汰
    if (this.touchedAt.has(current)) {
      this.touchedAt.set(current, Date.now())
    }
    return current
  }

  /**
   * 尝试进入串行化续接。
   * 如果同一个 oldMessageId 已在续接中，返回该 Promise（复用结果）。
   * 否则调用 factory 生成新的续接 Promise 并登记。
   */
  async serializeRelay(
    oldMessageId: string,
    factory: () => Promise<string>,
  ): Promise<string> {
    const existing = this.inflightRelays.get(oldMessageId)
    if (existing) return existing
    const promise = factory().finally(() => {
      this.inflightRelays.delete(oldMessageId)
    })
    this.inflightRelays.set(oldMessageId, promise)
    return promise
  }

  /**
   * TTL 清理：删除超过 ttlMs 未访问的条目。
   */
  cleanupExpired(ttlMs: number): void {
    if (ttlMs <= 0) return
    const now = Date.now()
    for (const [key, ts] of this.touchedAt) {
      if (now - ts > ttlMs) {
        this.discardKey(key)
      }
    }
  }

  /** 内部：清理某个 key 的所有关联状态。 */
  private discardKey(key: string): void {
    this.redirects.delete(key)
    this.editCounters.delete(key)
    this.touchedAt.delete(key)
  }

  /** 清空所有状态（bot dispose 时用）。 */
  clear(): void {
    this.editCounters.clear()
    this.redirects.clear()
    this.touchedAt.clear()
    this.inflightRelays.clear()
  }
}
