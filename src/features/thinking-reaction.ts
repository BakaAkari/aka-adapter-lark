/**
 * 思考期 reaction（A 能力）核心工具。
 *
 * 用户发消息触达机器人后，立即在用户原消息上添加一个飞书表情
 * （默认 🤔 THINKING），作为"机器人正在思考"的可见反馈。
 * 机器人首次向该会话发消息后延迟一段时间撤销 reaction。
 *
 * 关键：
 * - reaction.create 是网络调用（100~300ms），入站钩子必须 fire-and-forget
 * - 每条用户消息只加一次 reaction
 * - 撤销钩子按 channelId 聚合，批量撤销该会话下所有 pending reaction
 * - TTL 兜底避免机器人不响应时表情永久残留
 */

/** 单条 reaction 的追踪状态。 */
interface ReactionEntry {
  /** 被加 reaction 的用户消息 ID */
  messageId: string
  /** 加 reaction 时得到的 reaction_id，用于后续 delete */
  reactionId: string
  /** 用户消息所在 channelId */
  channelId: string
  /** 创建时的时间戳（毫秒） */
  createdAt: number
  /** TTL 兜底 timer */
  ttlTimer: NodeJS.Timeout
  /** outbound 后延迟撤销的 timer（可能为空，表示还没触发过 retire） */
  retireTimer?: NodeJS.Timeout
}

/**
 * 思考期 reaction 状态。挂在 LarkBot 上。
 *
 * 用法：
 * 1. 入站消息到达 → `register(messageId, channelId, reactionId, deleter)`
 * 2. 机器人在该 channel outbound → `scheduleRetireForChannel(channelId, delayMs)`
 * 3. TTL 到期或 dispose → 自动清理
 */
export class ThinkingReactionState {
  private readonly entries = new Map<string, ReactionEntry>()

  /**
   * 判断某条用户消息是否已经加过 reaction。
   * 避免重复加。
   */
  has(messageId: string): boolean {
    return this.entries.has(messageId)
  }

  /**
   * 登记一条已加成功的 reaction。
   * @param ttlMs TTL 存活时长；到期后调用 deleter 强制撤销
   * @param deleter 撤销函数，通常是 (messageId, reactionId) => bot.internal.im.message.reaction.delete(...)
   */
  register(
    messageId: string,
    channelId: string,
    reactionId: string,
    ttlMs: number,
    deleter: (messageId: string, reactionId: string) => Promise<void>,
  ): void {
    // 兜底：如果同一 messageId 已存在，先清理旧的
    this.discard(messageId)

    const ttlTimer = setTimeout(() => {
      const entry = this.entries.get(messageId)
      if (!entry) return
      this.entries.delete(messageId)
      if (entry.retireTimer) clearTimeout(entry.retireTimer)
      deleter(messageId, reactionId).catch(() => {
        // deleter 自己 log，这里不再抛
      })
    }, ttlMs)

    this.entries.set(messageId, {
      messageId,
      channelId,
      reactionId,
      createdAt: Date.now(),
      ttlTimer,
    })
  }

  /**
   * 对某个 channel 下所有 pending reaction 安排延迟撤销。
   * 已经在等 retire 的会重排（保留最近一次 outbound 的 retire 时间点）。
   */
  scheduleRetireForChannel(
    channelId: string,
    delayMs: number,
    deleter: (messageId: string, reactionId: string) => Promise<void>,
  ): void {
    for (const entry of this.entries.values()) {
      if (entry.channelId !== channelId) continue
      if (entry.retireTimer) clearTimeout(entry.retireTimer)
      entry.retireTimer = setTimeout(() => {
        this.entries.delete(entry.messageId)
        clearTimeout(entry.ttlTimer)
        deleter(entry.messageId, entry.reactionId).catch(() => {
          // deleter 自己 log
        })
      }, delayMs)
    }
  }

  /** 主动丢弃某条 reaction 的追踪（不调用 deleter，只清理本地状态）。 */
  discard(messageId: string): void {
    const entry = this.entries.get(messageId)
    if (!entry) return
    clearTimeout(entry.ttlTimer)
    if (entry.retireTimer) clearTimeout(entry.retireTimer)
    this.entries.delete(messageId)
  }

  /** 清空所有 reaction 追踪。bot dispose 时用。 */
  clear(): void {
    for (const entry of this.entries.values()) {
      clearTimeout(entry.ttlTimer)
      if (entry.retireTimer) clearTimeout(entry.retireTimer)
    }
    this.entries.clear()
  }
}
