/**
 * 插件 UI Schema 定义与校验（src/plugin-ui-schema.js）
 *
 * 纯 Schema 驱动 UI：插件**只返回 JSON**，不产出任何 JS/CSS。
 * 本模块负责：
 * 1. 33 个内置控件类型枚举（服务端与前端渲染器共用同一份清单）
 * 2. 服务端 Schema 校验：防插件下发非法 schema（R-A18 的服务端一侧）
 * 3. 视图注册表：增删改查 + 按 category / order 排序（R-A17）
 */

/** ★ 33 个内置控件类型（与 public/index.html 的 Schema Renderer 严格一一对应） */
const WIDGET_TYPES = [
  'text',                    // 单行文本
  'textarea',                // 多行文本
  'number',                  // 数字
  'slider',                  // 滑块
  'switch',                  // 布尔开关
  'select',                  // 单选下拉
  'radio-group',             // 单选卡片组
  'checkbox-group',          // 多选
  'tags-input',              // 自由标签输入
  'folder-picker',           // 服务端目录选择
  'path-template',           // 路径/命名模板
  'prompt-editor',           // Prompt JSON 编辑器
  'code-view',               // 只读代码块
  'markdown',                // 静态说明
  'alert',                   // 提示条
  'badge',                   // 状态徽章
  'progress',                // 任务进度
  'stat-cards',              // 统计卡片组
  'gallery',                 // 结果画廊
  'datatable',               // 表格
  'search-bar',              // 关键词检索
  'pending-review-browser',  // 待筛浏览 + 批量恢复
  'export-config',           // 导出配置（ExportProfile）
  'button',                  // 按钮
  'button-group',            // 按钮组
  'file-download',           // 下载产物
  'keyvalue-list',           // 键值列表
  'steps',                   // 步骤条
  'log-console',             // 滚动日志
  'section',                 // 分组容器
  'field-grid',              // 栅格布局
  'tabs',                    // 视图内子 Tab
  'divider',                 // 分隔线
];

const WIDGET_TYPE_SET = new Set(WIDGET_TYPES);

/** 旧插件配置字段类型的兼容别名（映射到新控件） */
const LEGACY_TYPE_ALIAS = {
  string: 'text',
  boolean: 'switch',
};

/** 布局类控件（不绑定数据） */
const LAYOUT_TYPES = new Set(['section', 'field-grid', 'tabs', 'divider']);

/** 表达式占位符正则：$config.x / $state.x / $result.x */
const BIND_RE = /^(config|state)\.[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;
const REF_RE = /^\$(config|state|result)(\.[A-Za-z0-9_]+)*$/;

/**
 * 归一化控件类型（兼容旧别名）。
 * @param {string} type 控件类型
 * @returns {string} 归一化后的类型
 */
function normalizeType(type) {
  const t = String(type || '').trim();
  return LEGACY_TYPE_ALIAS[t] || t;
}

/**
 * 校验单个字段定义。
 * @param {object} field 字段定义
 * @param {string} path 路径前缀（用于报错定位）
 * @returns {Array<{path: string, message: string}>} 问题列表
 */
function validateField(field, path) {
  const errors = [];
  if (!field || typeof field !== 'object') {
    errors.push({ path, message: '字段必须是对象' });
    return errors;
  }
  const type = normalizeType(field.type);
  if (!type) {
    errors.push({ path, message: '字段缺少 type' });
    return errors;
  }
  if (!WIDGET_TYPE_SET.has(type)) {
    errors.push({ path, message: `未知控件类型: ${field.type}` });
    return errors;
  }
  // 布局控件不需要 bind
  if (!LAYOUT_TYPES.has(type) && field.bind && !BIND_RE.test(field.bind)) {
    errors.push({ path, message: `bind 路径非法: ${field.bind}（应为 config.x 或 state.x）` });
  }
  if (field.visibleWhen && typeof field.visibleWhen !== 'object') {
    errors.push({ path, message: 'visibleWhen 必须是对象' });
  }
  if (field.disabledWhen && typeof field.disabledWhen !== 'object') {
    errors.push({ path, message: 'disabledWhen 必须是对象' });
  }
  if (type === 'select' || type === 'radio-group' || type === 'checkbox-group') {
    const hasStatic = Array.isArray(field.options) && field.options.length > 0;
    const hasDynamic = field.source && typeof field.source === 'object' && field.source.rpc;
    if (!hasStatic && !hasDynamic) {
      errors.push({ path, message: `${type} 必须提供非空 options 或 source.rpc 动态数据源` });
    }
  }
  // 只有布局容器（section/field-grid/tabs）才有嵌套 fields
  if (LAYOUT_TYPES.has(type) && Array.isArray(field.fields)) {
    for (let i = 0; i < field.fields.length; i++) {
      errors.push(...validateField(field.fields[i], `${path}.fields[${i}]`));
    }
  }
  return errors;
}

/**
 * 校验动作定义（含 Binding 原语）。
 * @param {object} action 动作定义
 * @param {string} path 路径前缀
 * @returns {Array<{path: string, message: string}>} 问题列表
 */
function validateAction(action, path) {
  const errors = [];
  if (!action || typeof action !== 'object') {
    errors.push({ path, message: '动作必须是对象' });
    return errors;
  }
  if (!action.id) errors.push({ path, message: '动作缺少 id' });
  if (action.rpc && typeof action.rpc !== 'string') {
    errors.push({ path, message: '动作的 rpc 必须是字符串' });
  }
  if (Array.isArray(action.onSuccess)) {
    action.onSuccess.forEach((b, i) => {
      const p = `${path}.onSuccess[${i}]`;
      if (!b || typeof b !== 'object') { errors.push({ path: p, message: '绑定必须是对象' }); return; }
      if (b.set && typeof b.set !== 'object') errors.push({ path: p, message: 'set 必须是对象' });
      if (b.set) {
        for (const [k, v] of Object.entries(b.set)) {
          if (!BIND_RE.test(k)) errors.push({ path: p, message: `set 的目标路径非法: ${k}` });
          if (typeof v === 'string' && v.startsWith('$') && !REF_RE.test(v)) {
            errors.push({ path: p, message: `set 的取值引用非法: ${v}` });
          }
        }
      }
    });
  }
  return errors;
}

/**
 * 校验一个视图 Schema（服务端防线：非法 schema 拒绝下发）。
 * @param {object} schema 视图 Schema
 * @returns {{ok: boolean, errors: Array<{path: string, message: string}>}}
 */
function validateSchema(schema) {
  const errors = [];
  if (!schema || typeof schema !== 'object') {
    return { ok: false, errors: [{ path: '$', message: 'schema 必须是对象' }] };
  }
  if (schema.version !== undefined && Number(schema.version) !== 1) {
    errors.push({ path: '$.version', message: '仅支持 version = 1' });
  }
  if (schema.state !== undefined && (typeof schema.state !== 'object' || Array.isArray(schema.state))) {
    errors.push({ path: '$.state', message: 'state 必须是对象' });
  }
  if (!Array.isArray(schema.sections)) {
    errors.push({ path: '$.sections', message: 'sections 必须是数组' });
  } else {
    schema.sections.forEach((sec, i) => {
      const p = `$.sections[${i}]`;
      if (!sec || typeof sec !== 'object') { errors.push({ path: p, message: '区块必须是对象' }); return; }
      if (!Array.isArray(sec.fields)) {
        errors.push({ path: `${p}.fields`, message: 'fields 必须是数组' });
        return;
      }
      sec.fields.forEach((f, j) => errors.push(...validateField(f, `${p}.fields[${j}]`)));
    });
  }
  if (schema.actions !== undefined) {
    if (!Array.isArray(schema.actions)) {
      errors.push({ path: '$.actions', message: 'actions 必须是数组' });
    } else {
      schema.actions.forEach((a, i) => errors.push(...validateAction(a, `$.actions[${i}]`)));
    }
  }
  if (schema.poll !== undefined) {
    if (!Array.isArray(schema.poll)) {
      errors.push({ path: '$.poll', message: 'poll 必须是数组' });
    } else {
      schema.poll.forEach((p, i) => {
        if (!p || typeof p !== 'object') { errors.push({ path: `$.poll[${i}]`, message: '轮询项必须是对象' }); return; }
        if (!p.rpc) errors.push({ path: `$.poll[${i}].rpc`, message: '轮询项缺少 rpc' });
        if (p.into && !BIND_RE.test(p.into)) {
          errors.push({ path: `$.poll[${i}].into`, message: `into 路径非法: ${p.into}` });
        }
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

// ─── 视图注册表 ───

/** pid → Array<view> */
const _views = new Map();

/**
 * 注册（或覆盖）某插件的视图列表。
 * @param {string} pid 插件 id
 * @param {Array<object>|object} views 视图定义
 * @returns {number} 注册后的视图数量
 */
function registerViews(pid, views) {
  const list = Array.isArray(views) ? views : (views ? [views] : []);
  const normalized = [];
  for (const v of list) {
    if (!v || !v.id) continue;
    const view = {
      pluginId: pid,
      viewId: String(v.id),
      category: v.category || 'plugins',
      title: v.title || v.id,
      icon: v.icon || '',
      order: typeof v.order === 'number' ? v.order : 100,
      schema: v.schema || null,
      schemaFile: v.schemaFile || null,
      schemaResolver: v.schemaResolver || null,
      refreshOn: Array.isArray(v.refreshOn) ? v.refreshOn : [],
    };
    if (view.schema) {
      const check = validateSchema(view.schema);
      if (!check.ok) {
        const { logError } = require('./logger');
        logError('plugin-ui-schema', `插件 ${pid} 视图 ${view.viewId} 的 schema 非法: ${check.errors.map((e) => e.message).join('；')}`);
        view.schema = null;
      }
    }
    normalized.push(view);
  }
  _views.set(pid, normalized);
  return normalized.length;
}

/** 移除某插件的全部视图 */
function removePluginViews(pid) {
  _views.delete(pid);
}

/**
 * 列出全部视图（按 category 分组、order 升序）。
 * @returns {Array<object>} 视图列表
 */
function getViews() {
  const all = [];
  for (const list of _views.values()) all.push(...list);
  all.sort((a, b) => a.order - b.order || String(a.pluginId).localeCompare(String(b.pluginId)));
  return all;
}

/**
 * 按插件取视图列表。
 * @param {string} pid 插件 id
 * @returns {Array<object>}
 */
function getPluginViews(pid) {
  return [...(_views.get(pid) || [])];
}

/**
 * 取单个视图。
 * @param {string} pid 插件 id
 * @param {string} vid 视图 id
 * @returns {object|null}
 */
function getView(pid, vid) {
  return (_views.get(pid) || []).find((v) => v.viewId === vid) || null;
}

module.exports = {
  WIDGET_TYPES,
  WIDGET_TYPE_SET,
  LEGACY_TYPE_ALIAS,
  LAYOUT_TYPES,
  normalizeType,
  validateSchema,
  validateField,
  validateAction,
  registerViews,
  removePluginViews,
  getViews,
  getPluginViews,
  getView,
};
