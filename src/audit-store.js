const fs = require('fs');
const path = require('path');
const { getProjectRoot } = require('./config');
const { logInfo, logError } = require('./logger');

const STORE_DIR = path.join(getProjectRoot(), 'data', 'audit_records');

// 确保存储目录存在
if (!fs.existsSync(STORE_DIR)) {
  fs.mkdirSync(STORE_DIR, { recursive: true });
}

/**
 * 获取日期字符串 (YYYY-MM-DD)，基于本地时区
 */
function getDateStr(date) {
  const d = date ? new Date(date) : new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 获取指定日期的审核记录文件路径
 */
function getFilePath(dateStr) {
  return path.join(STORE_DIR, `${dateStr}.jsonl`);
}

/**
 * 保存一条审核记录（含原始文本）
 * @param {string} text - 原始审核文本
 * @param {object} result - 审核结果
 * @param {object} meta - 元数据 (userId, groupId, messageId)
 */
function saveAuditRecord(text, result, meta = {}) {
  try {
    const dateStr = getDateStr();
    const filePath = getFilePath(dateStr);

    const record = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      timestamp: new Date().toISOString(),
      date: dateStr,
      text,
      model: result.model || 'qwen3-14b',
      result: { ...result },
      meta,
    };

    fs.appendFileSync(filePath, JSON.stringify(record) + '\n', 'utf-8');
    return record;
  } catch (err) {
    logError('audit-store', `保存审核记录失败: ${err.message}`);
    return null;
  }
}

/**
 * 读取指定日期的所有审核记录
 * @param {string} dateStr - 日期字符串 YYYY-MM-DD（默认今天）
 * @returns {Array} 审核记录数组
 */
function getAuditRecords(dateStr) {
  const target = dateStr || getDateStr();
  const filePath = getFilePath(target);

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content.trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * 列出所有有审核记录的日期
 * @returns {Array<{date: string, count: number}>}
 */
function listAuditDates() {
  try {
    const files = fs.readdirSync(STORE_DIR).filter((f) => f.endsWith('.jsonl'));
    return files.map((f) => {
      const date = f.replace('.jsonl', '');
      const filePath = path.join(STORE_DIR, f);
      let count = 0;
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        count = content.trim().split('\n').filter(Boolean).length;
      } catch { /* ignore */ }
      return { date, count };
    }).sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

/**
 * 获取指定日期审核记录的统计信息
 */
function getAuditStats(dateStr) {
  const records = getAuditRecords(dateStr);
  if (records.length === 0) return { total: 0 };

  const stats = {
    total: records.length,
    by_risk: {},
    by_category: {},
    blocked: 0,
    passed: 0,
  };

  for (const r of records) {
    const level = r.result?.risk_level || 'safe';
    stats.by_risk[level] = (stats.by_risk[level] || 0) + 1;

    if (r.result?.passed) {
      stats.passed++;
    } else {
      stats.blocked++;
    }

    for (const cat of (r.result?.categories || [])) {
      stats.by_category[cat] = (stats.by_category[cat] || 0) + 1;
    }
  }

  return stats;
}

/**
 * 获取最近 N 天的详细统计数据（含 token 消耗、耗时）
 * @param {number} days - 最近几天（默认7）
 * @returns {object} 含 daily、7day 汇总
 */
function getDetailedStats(days = 7) {
  const today = getDateStr();
  const dates = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(getDateStr(d));
  }
  // dates[0] = today, dates[1] = yesterday, ...

  const dailyStats = [];
  let totalTokens = 0, totalTokensIn = 0, totalTokensOut = 0, totalLatency = 0, latencyCount = 0;
  let totalAudits = 0, totalPassed = 0, totalBlocked = 0;

  for (const dateStr of dates) {
    const records = getAuditRecords(dateStr);
    const day = {
      date: dateStr,
      total: records.length,
      passed: 0,
      blocked: 0,
      tokens_in: 0,
      tokens_out: 0,
      tokens_total: 0,
      avg_latency_ms: 0,
      by_category: {},
      by_hour: {},
    };

    let dayLatency = 0, dayLatCount = 0;

    for (const r of records) {
      const result = r.result || {};
      day.total = records.length;

      if (result.passed) day.passed++;
      else day.blocked++;

      // Token 估算
      const tin = result.tokens_in || Math.round((r.text || '').length * 1.8);
      const tout = result.tokens_out || Math.round((result.reason || '').length * 1.5);
      day.tokens_in += tin;
      day.tokens_out += tout;

      // 耗时
      if (result.latency_ms && result.latency_ms > 0) {
        dayLatency += result.latency_ms;
        dayLatCount++;
      }

      // 按分类
      for (const cat of (result.categories || [])) {
        day.by_category[cat] = (day.by_category[cat] || 0) + 1;
      }

      // 按小时
      try {
        const h = r.timestamp ? new Date(r.timestamp).getHours() : 0;
        day.by_hour[h] = (day.by_hour[h] || 0) + 1;
      } catch { /* skip */ }
    }

    day.tokens_total = day.tokens_in + day.tokens_out;
    day.avg_latency_ms = dayLatCount > 0 ? Math.round(dayLatency / dayLatCount) : 0;

    dailyStats.push(day);

    totalAudits += day.total;
    totalPassed += day.passed;
    totalBlocked += day.blocked;
    totalTokens += day.tokens_total;
    totalTokensIn += day.tokens_in;
    totalTokensOut += day.tokens_out;
    totalLatency += dayLatency;
    latencyCount += dayLatCount;
  }

  return {
    today: dailyStats[0] || null,
    daily: dailyStats.reverse(), // 从旧到新
    summary: {
      days,
      total_audits: totalAudits,
      total_passed: totalPassed,
      total_blocked: totalBlocked,
      pass_rate: totalAudits > 0 ? Math.round((totalPassed / totalAudits) * 100) : 0,
      total_tokens: totalTokens,
      total_tokens_in: totalTokensIn,
      total_tokens_out: totalTokensOut,
      avg_latency_ms: latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0,
    },
  };
}

/**
 * 清除审核记录
 * @param {string} dateStr - 日期字符串 (YYYY-MM-DD)，为空则清除全部
 * @returns {object} 清除结果 { success: true, deleted: number }
 */
function clearAuditRecords(dateStr = null) {
  try {
    if (!fs.existsSync(STORE_DIR)) {
      return { success: true, deleted: 0 };
    }

    if (dateStr) {
      // 清除指定日期
      const filePath = getFilePath(dateStr);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logInfo('audit-store', `已清除审核记录: ${dateStr}`);
        return { success: true, deleted: 1 };
      }
      return { success: true, deleted: 0 };
    } else {
      // 清除全部
      const files = fs.readdirSync(STORE_DIR).filter(f => f.endsWith('.jsonl'));
      for (const file of files) {
        fs.unlinkSync(path.join(STORE_DIR, file));
      }
      logInfo('audit-store', `已清除全部审核记录: ${files.length} 个文件`);
      return { success: true, deleted: files.length };
    }
  } catch (err) {
    logError('audit-store', `清除审核记录失败: ${err.message}`);
    return { success: false, error: err.message };
  }
}

module.exports = {
  saveAuditRecord,
  getAuditRecords,
  listAuditDates,
  getAuditStats,
  getDetailedStats,
  getDateStr,
  clearAuditRecords,
};
