/**
 * 执行上下文与工作上下文（src/flow/context.js）
 *
 * - FlowContext：一次执行的全部状态（payload / meta / work / traces / requestId）。
 * - WorkContext：节点间传递的轻量工作上下文（标签 / 标注 / 证据），供 contribute 写入、
 *   下游节点读取（PRD §4.3「上游标签」）。
 *
 * ★ 每次请求新建，绝不共享；节点不得写全局变量（架构 §6.2 幂等/无共享约定）。
 */

'use strict';

/**
 * 新建工作上下文。
 * @returns {{tags: string[], labels: string[], evidence: Array<object>}} 工作上下文
 */
function createWorkContext() {
  return { tags: [], labels: [], evidence: [] };
}

/**
 * 新建执行上下文。
 * @param {object} options 选项
 * @param {'text'|'image'} options.modality 模态
 * @param {object} [options.payload] 输入载荷（{text} 或 {imageBase64, caption}）
 * @param {object} [options.meta] 元数据
 * @param {string} [options.requestId] 请求 id
 * @param {string} [options.strictness] 严格程度
 * @returns {object} 执行上下文
 */
function createContext(options = {}) {
  return {
    modality: options.modality || 'text',
    payload: options.payload || {},
    meta: options.meta || {},
    work: createWorkContext(),
    traces: [],
    requestId: options.requestId || '',
    strictness: options.strictness || 'standard',
    startedAt: Date.now(),
    /**
     * 追加一条节点轨迹。
     * @param {object} trace 轨迹
     * @returns {object} 轨迹
     */
    addTrace(trace) {
      this.traces.push(trace);
      return trace;
    },
    /**
     * 把贡献写入工作上下文（去重）。
     * @param {{tags?: string[], labels?: string[], evidence?: Array<object>}} contribution 贡献
     * @returns {number} 新增标签数
     */
    mergeWork(contribution) {
      if (!contribution || typeof contribution !== 'object') return 0;
      let added = 0;
      for (const tag of contribution.tags || []) {
        if (typeof tag === 'string' && tag && !this.work.tags.includes(tag)) {
          this.work.tags.push(tag);
          added += 1;
        }
      }
      for (const label of contribution.labels || []) {
        if (typeof label === 'string' && label && !this.work.labels.includes(label)) {
          this.work.labels.push(label);
        }
      }
      for (const item of contribution.evidence || []) {
        if (item && typeof item === 'object') this.work.evidence.push(item);
      }
      return added;
    },
  };
}

/**
 * 构造一条标准化节点轨迹（不含任何待审核内容）。
 * @param {object} result NodeResult
 * @returns {object} 轨迹对象
 */
function toTrace(result) {
  if (!result || typeof result !== 'object') return null;
  return {
    node_id: result.nodeId,
    ref: result.ref,
    title: result.title || result.ref,
    status: result.status,
    elapsed_ms: Number.isFinite(result.elapsedMs) ? Math.round(result.elapsedMs) : 0,
    failure_type: result.failureType || null,
    skip_reason: result.skipReason || null,
    risk_level: result.verdict ? result.verdict.risk_level : null,
    action: result.verdict ? result.verdict.action || null : null,
    confidence: result.verdict && Number.isFinite(result.verdict.confidence) ? result.verdict.confidence : null,
    cost_hint: result.costHint || null,
    message: result.message || '',
  };
}

module.exports = { createContext, createWorkContext, toTrace };
