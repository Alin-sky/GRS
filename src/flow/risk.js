/**
 * 风险序（R0 前置项）—— 全项目**唯一**风险等级序位定义源。
 *
 * 背景：v2.1.0 里存在三份互不一致的 RISK_ORDER 拷贝
 *   - `src/moderator.js`           ：review = 2.5
 *   - `src/security/injection-audit.js`：review = 2.5
 *   - `src/security/fail-closed.js`    ：review = 2.5（内联）
 *   - `src/config-defaults.js`     ：review = 3（DEFAULT_RISK_LEVELS.score）
 * 并行合并策略依赖「序位比较」，多份定义会让「取最严重」在不同代码路径下结果漂移。
 * 本模块把所有序位收敛为一份，其余模块一律引用，禁止再自行定义。
 *
 * 阶梯（严格递增，review 是保留位）：
 *   safe(0) < low(1) < medium(2) < review(3) < high(4) < critical(5)
 *
 * 说明：把旧的 `review:2.5 / high:3 / critical:4` 归一为 `review:3 / high:4 / critical:5`
 * 后，**所有相对次序保持不变**，因此既有判定行为逐字段不变（仅绝对数值变化，绝对数值不外泄）。
 *
 * 本模块零依赖，可被核心、插件契约层、测试独立引用。
 */

'use strict';

/** 含 review 的完整风险序（内部比较专用）。 */
const RISK_ORDER = Object.freeze({
  safe: 0,
  low: 1,
  medium: 2,
  review: 3,
  high: 4,
  critical: 5,
});

/** 完整风险等级列表（含 review）。 */
const RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'review', 'high', 'critical']);

/** 内容风险等级（模型/插件可输出，不含 review —— review 表示「链路失效」）。 */
const CONTENT_RISK_LEVELS = Object.freeze(['safe', 'low', 'medium', 'high', 'critical']);

/**
 * 取风险等级序位，未知等级按 0（safe）处理。
 * @param {string} level 风险等级
 * @returns {number} 序位
 */
function riskOrder(level) {
  return RISK_ORDER[level] ?? 0;
}

/**
 * 比较两个风险等级序位。
 * @param {string} a 等级 A
 * @param {string} b 等级 B
 * @returns {number} a-b（>0 表示 a 更严重）
 */
function compareRisk(a, b) {
  return riskOrder(a) - riskOrder(b);
}

/**
 * 取两者中更严重者。
 * @param {string} a 等级 A
 * @param {string} b 等级 B
 * @returns {string} 更严重者
 */
function maxRisk(a, b) {
  return compareRisk(a, b) >= 0 ? a : b;
}

/**
 * 取两者中更轻者。
 * @param {string} a 等级 A
 * @param {string} b 等级 B
 * @returns {string} 更轻者
 */
function minRisk(a, b) {
  return compareRisk(a, b) <= 0 ? a : b;
}

module.exports = {
  RISK_ORDER,
  RISK_LEVELS,
  CONTENT_RISK_LEVELS,
  riskOrder,
  compareRisk,
  maxRisk,
  minRisk,
};
