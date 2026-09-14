const fs = require('fs');
const path = require('path');
const { loadConfig, getPrompt, getProjectRoot } = require('./config');
const { chat, unloadModel } = require('./ollama');
const { getAuditRecords } = require('./audit-store');
const { logInfo, logError } = require('./logger');
const { precheck, buildPrecheckHint } = require('./precheck');
const { moderateTextCloud } = require('./qwen_cloud');
const { moderateTextContentSafety } = require('./content_safety');

const config = loadConfig();
const COMPARISON_DIR = path.join(getProjectRoot(), 'data', 'comparisons');

if (!fs.existsSync(COMPARISON_DIR)) {
  fs.mkdirSync(COMPARISON_DIR, { recursive: true });
}

// 运行状态
let running = false;
let runProgress = null;

/**
 * 使用指定本地模型审核单条文本
 * @param {string} model - 模型名称
 * @param {string} text - 待审核文本
 * @param {string} keepAlive - keep_alive 策略
 * @returns {Promise<object>} 审核结果
 */
async function moderateWithModel(model, text, keepAlive) {
  const systemPrompt = getPrompt(config.moderation.textPromptFile);

  // 预检
  const precheckResult = precheck(text);
  const precheckHint = buildPrecheckHint(precheckResult);
  const userMessage = precheckHint
    ? `${precheckHint}\n请审核以下文本内容：\n${text}`
    : text;

  const host = config.ollama.host;
  const body = {
    model,
    stream: false,
    think: model.includes('safeguard'),
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    options: config.ollama.options,
    keep_alive: keepAlive,
  };

  const res = await fetch(`${host}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120000),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Ollama HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const content = data?.message?.content;
  if (!content) throw new Error('Ollama 返回了空内容');

  // 解析 JSON 结果
  const parsed = extractJSON(content);
  return parsed || { risk_level: 'low', categories: [], confidence: 0.3, reason: '解析失败' };
}

/**
 * 使用云端大模型审核单条文本
 * @param {string} text - 待审核文本
 * @returns {Promise<object>} 审核结果
 */
async function moderateWithCloud(text) {
  const systemPrompt = getPrompt(config.moderation.textPromptFile);

  // 预检
  const precheckResult = precheck(text);
  const precheckHint = buildPrecheckHint(precheckResult);
  const userMessage = precheckHint
    ? `${precheckHint}\n请审核以下文本内容：\n${text}`
    : text;

  const cloudResult = await moderateTextCloud(systemPrompt, userMessage);
  // 云端未配置：抛出明确原因，由调用方决定降级（而不是解析 null 报出误导性错误）
  if (cloudResult.skipped) {
    throw new Error(`云端审核通道未配置，已跳过 (${cloudResult.reason})`);
  }
  const parsed = extractJSON(cloudResult.content);

  if (!parsed) {
    throw new Error(`云端模型返回内容无法解析为JSON: ${cloudResult.content.substring(0, 100)}`);
  }

  return parsed;
}

/**
 * 使用阿里云内容安全审核单条文本
 * @param {string} text - 待审核文本
 * @returns {Promise<object>} 审核结果
 */
async function moderateWithContentSafety(text) {
  const csResult = await moderateTextContentSafety(text);
  
  if (!csResult.available) {
    throw new Error(`内容安全不可用: ${csResult.reason || csResult.error}`);
  }

  // 内容安全返回的结果格式与本地/云端不同，需要转换
  return {
    risk_level: csResult.risk_level || 'safe',
    categories: csResult.categories || [],
    confidence: csResult.confidence || 0.5,
    reason: csResult.suggestion || '内容安全审核结果',
    content_safety_raw: {
      suggestion: csResult.suggestion,
      matched_labels: csResult.matched_labels || [],
      services: csResult.services || [],
    },
  };
}

/**
 * 从模型回复中提取 JSON
 */
function extractJSON(text) {
  if (!text) return null;
  let cleaned = text.trim();
  try { return JSON.parse(cleaned); } catch { /* continue */ }
  const m = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (m) { try { return JSON.parse(m[1].trim()); } catch { /* continue */ } }
  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(cleaned.substring(first, last + 1)); } catch { /* continue */ }
  }
  return null;
}

/**
 * 检测存储的审核结果是否为异常结果
 * @param {object} result - 审核结果
 * @returns {boolean} 是否为异常结果
 */
function isErrorResult(result) {
  if (!result) return true;
  const conf = result.confidence;
  const reason = result.reason || '';
  if (conf === 0) return true;
  if (typeof reason === 'string' && (reason.includes('异常') || reason.toLowerCase().includes('failed') || reason.toLowerCase().includes('error'))) return true;
  return false;
}

/**
 * 对比两条审核结果
 * @param {object} resultA - 模型A的结果
 * @param {object} resultB - 模型B的结果
 * @param {string} labelA - 模型A的标签（如 '14b', '8b', 'safeguard'）
 * @param {string} labelB - 模型B的标签
 * @returns {object} 对比结果
 */
function compareResults(resultA, resultB, labelA, labelB) {
  const riskOrder = { safe: 0, low: 1, medium: 2, high: 3, critical: 4 };

  const riskChanged = resultA.risk_level !== resultB.risk_level;
  const catsA = new Set(resultA.categories || []);
  const catsB = new Set(resultB.categories || []);
  const catsAdded = [...catsB].filter((c) => !catsA.has(c));
  const catsRemoved = [...catsA].filter((c) => !catsB.has(c));
  const confDiff = (resultB.confidence || 0) - (resultA.confidence || 0);

  const blockLevels = new Set(['high', 'critical']);
  const aBlocked = blockLevels.has(resultA.risk_level);
  const bBlocked = blockLevels.has(resultB.risk_level);
  const actionAgreed = aBlocked === bBlocked;

  const agreed = !riskChanged && catsAdded.length === 0 && catsRemoved.length === 0 && actionAgreed;

  return {
    agreed,
    risk_level_changed: riskChanged,
    [`risk_${labelA}`]: resultA.risk_level,
    [`risk_${labelB}`]: resultB.risk_level,
    risk_diff: riskOrder[resultB.risk_level] - riskOrder[resultA.risk_level],
    categories_added: catsAdded,
    categories_removed: catsRemoved,
    confidence_diff: Math.round(confDiff * 100) / 100,
    [`confidence_${labelA}`]: resultA.confidence,
    [`confidence_${labelB}`]: resultB.confidence,
    action_agreed: actionAgreed,
    [`reason_${labelA}`]: resultA.reason,
    [`reason_${labelB}`]: resultB.reason,
  };
}

/**
 * 运行对比审核（三模型交叉对比+去重）
 * @param {string} dateStr - 要对比的日期 YYYY-MM-DD（默认昨天）
 * @returns {Promise<object>} 对比结果
 */
async function runComparison(dateStr) {
  if (running) {
    throw new Error('对比审核正在运行中，请等待完成');
  }

  const target = dateStr || getYesterdayDateStr();
  const records = getAuditRecords(target);

  if (records.length === 0) {
    logInfo('comparator', `日期 ${target} 无审核记录，跳过对比`);
    const emptyResult = {
      date: target,
      run_at: new Date().toISOString(),
      total_records: 0,
      message: '无审核记录',
      results: [],
      summary: {
        total: 0,
        valid: 0,
        deduplicated: 0,
        models: [],
        comparisons: {},
        skipped_errors: 0,
      },
    };
    const emptyPath = path.join(COMPARISON_DIR, `${target}.json`);
    fs.writeFileSync(emptyPath, JSON.stringify(emptyResult, null, 2), 'utf-8');
    return emptyResult;
  }

  running = true;
  try {
  // 获取所有参与对比的模型
  const mainModel = config.ollama.textModel; // 主模型（当前配置）
  const comparisonModels = config.ollama.comparisonModels || ['qwen3:14b', 'qwen3:8b'];
  const allModels = [mainModel, ...comparisonModels.filter(m => m !== mainModel)];
  
  // 检查云端和内容安全是否可用
  const cloudEnabled = config.qwenCloud?.enabled && config.qwenCloud?.apiKey;
  const contentSafetyEnabled = config.contentSafety?.enabled && config.contentSafety?.accessKeyId;
  
  const channels = ['local'];
  if (cloudEnabled) channels.push('cloud');
  if (contentSafetyEnabled) channels.push('content_safety');
  
  logInfo('comparator', `开始对比审核: ${target}, 共 ${records.length} 条记录`);
  logInfo('comparator', `本地模型: ${allModels.join(', ')}`);
  logInfo('comparator', `云端通道: ${cloudEnabled ? '已启用' : '未启用'}`);
  logInfo('comparator', `内容安全: ${contentSafetyEnabled ? '已启用' : '未启用'}`);

  // 先卸载所有本地模型释放显存
  for (const model of allModels) {
    try {
      await unloadModel(model);
    } catch (err) {
      // 忽略卸载失败
    }
  }

  // 步骤1: 去重 - 按文本内容去重，保留最新的记录
  const uniqueTexts = new Map();
  for (const record of records) {
    const text = record.text?.trim();
    if (!text) continue;
    // 跳过主模型结果异常的记录
    if (isErrorResult(record.result)) continue;
    // 保留最新的（后面的覆盖前面的）
    uniqueTexts.set(text, record);
  }

  const deduplicatedRecords = Array.from(uniqueTexts.values());
  const dedupCount = records.length - deduplicatedRecords.length;
  
  logInfo('comparator', `去重: ${records.length} → ${deduplicatedRecords.length} 条 (去除 ${dedupCount} 条重复)`);

  // 计算总任务数：本地模型 + 云端 + 内容安全
  const localModelCount = comparisonModels.filter(m => m !== mainModel).length;
  const totalTasks = deduplicatedRecords.length * (localModelCount + (cloudEnabled ? 1 : 0) + (contentSafetyEnabled ? 1 : 0));
  let currentTask = 0;
  
  runProgress = { total: totalTasks, done: 0, current: 0, phase: '审核中' };

  // 步骤2: 用所有通道审核去重后的文本
  const results = [];
  const modelResults = {}; // { model/channel: { text: result } }
  const skippedErrors = { local: 0, cloud: 0, content_safety: 0 };

  // 初始化结果容器
  for (const model of allModels) {
    modelResults[model] = {};
  }
  if (cloudEnabled) modelResults['cloud'] = {};
  if (contentSafetyEnabled) modelResults['content_safety'] = {};

  // 主模型的结果已经在审核记录中，直接使用
  for (const record of deduplicatedRecords) {
    modelResults[mainModel][record.text] = record.result;
  }

  // 用其他本地模型审核
  for (let mi = 0; mi < comparisonModels.length; mi++) {
    const model = comparisonModels[mi];
    if (model === mainModel) continue; // 跳过主模型（已有结果）

    runProgress.phase = `本地模型 ${mi + 1}/${localModelCount}: ${model}`;
    logInfo('comparator', `开始加载本地模型: ${model}`);

    for (let i = 0; i < deduplicatedRecords.length; i++) {
      const record = deduplicatedRecords[i];
      const text = record.text;

      currentTask++;
      runProgress = { 
        total: totalTasks, 
        done: currentTask, 
        current: i + 1,
        phase: `本地模型 ${mi + 1}/${localModelCount}: ${model}`
      };

      try {
        const result = await moderateWithModel(model, text, '5m');
        modelResults[model][text] = result;
        
        logInfo('comparator', `[${model}] ${i + 1}/${deduplicatedRecords.length} | ${result.risk_level} (${(result.confidence * 100).toFixed(0)}%)`);
      } catch (err) {
        logError('comparator', `[${model}] ${i + 1}/${deduplicatedRecords.length} 审核失败: ${err.message}`);
        modelResults[model][text] = null;
        skippedErrors.local++;
      }
    }

    // 卸载当前模型
    try {
      await unloadModel(model);
      logInfo('comparator', `已卸载 ${model} 释放显存`);
    } catch (err) {
      logError('comparator', `卸载 ${model} 失败: ${err.message}`);
    }
  }

  // 云端大模型审核
  if (cloudEnabled) {
    runProgress.phase = '云端大模型审核';
    logInfo('comparator', `开始云端大模型审核`);

    for (let i = 0; i < deduplicatedRecords.length; i++) {
      const record = deduplicatedRecords[i];
      const text = record.text;

      currentTask++;
      runProgress = { 
        total: totalTasks, 
        done: currentTask, 
        current: i + 1,
        phase: '云端大模型审核'
      };

      try {
        const result = await moderateWithCloud(text);
        modelResults['cloud'][text] = result;
        
        logInfo('comparator', `[cloud] ${i + 1}/${deduplicatedRecords.length} | ${result.risk_level} (${(result.confidence * 100).toFixed(0)}%)`);
      } catch (err) {
        logError('comparator', `[cloud] ${i + 1}/${deduplicatedRecords.length} 审核失败: ${err.message}`);
        modelResults['cloud'][text] = null;
        skippedErrors.cloud++;
      }
    }
  }

  // 内容安全审核
  if (contentSafetyEnabled) {
    runProgress.phase = '内容安全审核';
    logInfo('comparator', `开始内容安全审核`);

    for (let i = 0; i < deduplicatedRecords.length; i++) {
      const record = deduplicatedRecords[i];
      const text = record.text;

      currentTask++;
      runProgress = { 
        total: totalTasks, 
        done: currentTask, 
        current: i + 1,
        phase: '内容安全审核'
      };

      try {
        const result = await moderateWithContentSafety(text);
        modelResults['content_safety'][text] = result;
        
        logInfo('comparator', `[content_safety] ${i + 1}/${deduplicatedRecords.length} | ${result.risk_level}`);
      } catch (err) {
        logError('comparator', `[content_safety] ${i + 1}/${deduplicatedRecords.length} 审核失败: ${err.message}`);
        modelResults['content_safety'][text] = null;
        skippedErrors.content_safety++;
      }
    }
  }

  // 步骤3: 生成交叉对比结果
  runProgress.phase = '生成对比报告';
  
  for (const record of deduplicatedRecords) {
    const text = record.text;
    const textPreview = text.length > 200 ? text.substring(0, 200) + '...' : text;
    
    const resultEntry = {
      id: record.id,
      timestamp: record.timestamp,
      text: textPreview,
      text_full_length: text.length,
      models: {},
      comparisons: {},
    };

    // 收集各本地模型结果
    for (const model of allModels) {
      const result = modelResults[model]?.[text];
      if (result) {
        resultEntry.models[model] = {
          risk_level: result.risk_level,
          categories: result.categories || [],
          confidence: result.confidence,
          reason: result.reason || '',
        };
      } else {
        resultEntry.models[model] = null;
      }
    }

    // 收集云端结果
    if (cloudEnabled) {
      const result = modelResults['cloud']?.[text];
      if (result) {
        resultEntry.models['cloud'] = {
          risk_level: result.risk_level,
          categories: result.categories || [],
          confidence: result.confidence,
          reason: result.reason || '',
        };
      } else {
        resultEntry.models['cloud'] = null;
      }
    }

    // 收集内容安全结果
    if (contentSafetyEnabled) {
      const result = modelResults['content_safety']?.[text];
      if (result) {
        resultEntry.models['content_safety'] = {
          risk_level: result.risk_level,
          categories: result.categories || [],
          confidence: result.confidence,
          reason: result.reason || '',
          content_safety_raw: result.content_safety_raw || null,
        };
      } else {
        resultEntry.models['content_safety'] = null;
      }
    }

    // 构建所有通道列表用于两两对比
    const allChannels = [...allModels];
    if (cloudEnabled) allChannels.push('cloud');
    if (contentSafetyEnabled) allChannels.push('content_safety');

    // 两两交叉对比
    for (let i = 0; i < allChannels.length; i++) {
      for (let j = i + 1; j < allChannels.length; j++) {
        const channelA = allChannels[i];
        const channelB = allChannels[j];
        const resultA = modelResults[channelA]?.[text];
        const resultB = modelResults[channelB]?.[text];
        
        if (resultA && resultB) {
          const labelA = getModelLabel(channelA);
          const labelB = getModelLabel(channelB);
          const comparison = compareResults(resultA, resultB, labelA, labelB);
          const key = `${labelA}_vs_${labelB}`;
          resultEntry.comparisons[key] = comparison;
        }
      }
    }

    results.push(resultEntry);
  }

  // 步骤4: 统计汇总
  const allChannelsForStats = [...allModels];
  if (cloudEnabled) allChannelsForStats.push('cloud');
  if (contentSafetyEnabled) allChannelsForStats.push('content_safety');

  const summary = {
    total: records.length,
    valid: deduplicatedRecords.length,
    deduplicated: dedupCount,
    channels: allChannelsForStats,
    models: allModels,
    comparisons: {},
    skipped_errors: skippedErrors,
    channels_enabled: {
      cloud: cloudEnabled,
      content_safety: contentSafetyEnabled,
    },
  };

  // 计算每对通道的一致率
  for (let i = 0; i < allChannelsForStats.length; i++) {
    for (let j = i + 1; j < allChannelsForStats.length; j++) {
      const channelA = allChannelsForStats[i];
      const channelB = allChannelsForStats[j];
      const labelA = getModelLabel(channelA);
      const labelB = getModelLabel(channelB);
      const key = `${labelA}_vs_${labelB}`;
      
      let agreed = 0;
      let disagreed = 0;
      let confSumA = 0;
      let confSumB = 0;
      let validCount = 0;

      for (const r of results) {
        const comp = r.comparisons[key];
        if (comp) {
          if (comp.agreed) agreed++;
          else disagreed++;
          confSumA += r.models[channelA]?.confidence || 0;
          confSumB += r.models[channelB]?.confidence || 0;
          validCount++;
        }
      }

      summary.comparisons[key] = {
        agreed,
        disagreed,
        agreement_rate: validCount > 0 ? Math.round((agreed / validCount) * 1000) / 10 : 0,
        avg_confidence_a: validCount > 0 ? Math.round((confSumA / validCount) * 100) / 100 : 0,
        avg_confidence_b: validCount > 0 ? Math.round((confSumB / validCount) * 100) / 100 : 0,
        channel_a: channelA,
        channel_b: channelB,
      };
    }
  }

  const output = {
    date: target,
    run_at: new Date().toISOString(),
    total_records: records.length,
    results,
    summary,
  };

  // 保存对比结果
  const outputPath = path.join(COMPARISON_DIR, `${target}.json`);
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2), 'utf-8');
  logInfo('comparator', `对比审核完成: ${target}, 结果已保存到 ${outputPath}`);

  return output;
  } finally {
    running = false;
    runProgress = null;
  }
}

/**
 * 获取模型标签（用于字段命名）
 */
function getModelLabel(model) {
  if (model === 'cloud') return 'cloud';
  if (model === 'content_safety') return 'content_safety';
  if (model.includes('safeguard')) return 'safeguard';
  if (model.includes('14b')) return '14b';
  if (model.includes('8b')) return '8b';
  return model.replace(/[^a-zA-Z0-9]/g, '_');
}

/**
 * 获取昨天的日期字符串
 */
function getYesterdayDateStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * 读取指定日期的对比结果
 */
function getComparisonResult(dateStr) {
  const filePath = path.join(COMPARISON_DIR, `${dateStr}.json`);
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * 列出所有对比结果日期
 */
function listComparisons() {
  try {
    const files = fs.readdirSync(COMPARISON_DIR).filter((f) => f.endsWith('.json'));
    return files.map((f) => {
      const date = f.replace('.json', '');
      const filePath = path.join(COMPARISON_DIR, f);
      try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return {
          date,
          total_records: data.total_records,
          agreement_rate: data.summary?.comparisons ? 
            Object.values(data.summary.comparisons)[0]?.agreement_rate || 0 : 0,
          agreed: data.summary?.comparisons ?
            Object.values(data.summary.comparisons)[0]?.agreed || 0 : 0,
          disagreed: data.summary?.comparisons ?
            Object.values(data.summary.comparisons)[0]?.disagreed || 0 : 0,
          run_at: data.run_at,
        };
      } catch {
        return { date, total_records: 0, agreement_rate: 0 };
      }
    }).sort((a, b) => b.date.localeCompare(a.date));
  } catch {
    return [];
  }
}

/**
 * 获取对比运行状态
 */
function getStatus() {
  return {
    running,
    progress: runProgress,
    comparisonModels: config.ollama.comparisonModels || ['qwen3:14b', 'qwen3:8b'],
    mainModel: config.ollama.textModel,
    schedule: config.ollama.comparisonSchedule || '04:00',
    channels: {
      cloud: !!(config.qwenCloud?.enabled && config.qwenCloud?.apiKey),
      content_safety: !!(config.contentSafety?.enabled && config.contentSafety?.accessKeyId),
    },
  };
}

module.exports = {
  runComparison,
  getComparisonResult,
  listComparisons,
  getStatus,
};
