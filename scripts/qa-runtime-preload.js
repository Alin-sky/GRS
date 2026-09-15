/**
 * QA 运行时守卫（scripts/qa-runtime-preload.js）—— 仅测试用，随子进程 --require 加载
 *
 * 通过环境变量启用（全部为模拟/保护用途，不改变产品代码）：
 *   QA_BLOCK_OPTIONAL=@alicloud/green20220302   → 让节点/核心 require.resolve 该包失败（模拟未装可选依赖）
 *   QA_ONLY_PLUGIN=wd14-tagger                  → 让 scanner 读 plugins/ 时只看到 1 个插件目录
 *   QA_GUARD_CONFIG_WRITE=1                     → 拦截对 config/default.json 的写入（保护真实配置）
 *
 * ★ 绝不写盘、绝不修改 config/default.json。
 */

'use strict';

const Module = require('module');
const fs = require('fs');
const path = require('path');

// ① 屏蔽指定可选依赖（模拟「别人电脑没装」）
const blocked = String(process.env.QA_BLOCK_OPTIONAL || '').split(',').map((s) => s.trim()).filter(Boolean);
if (blocked.length > 0) {
  const orig = Module._resolveFilename;
  Module._resolveFilename = function patched(request, ...rest) {
    if (blocked.includes(request)) {
      const err = new Error(`Cannot find module '${request}' (QA simulated missing)`);
      err.code = 'MODULE_NOT_FOUND';
      throw err;
    }
    return orig.call(this, request, ...rest);
  };
}

// ② plugins/ 目录只暴露 1 个插件
const only = process.env.QA_ONLY_PLUGIN;
if (only) {
  const realReaddir = fs.readdirSync;
  fs.readdirSync = function patched(dir, ...rest) {
    const out = realReaddir.call(this, dir, ...rest);
    if (String(dir).replace(/\\/g, '/').endsWith('/plugins') && Array.isArray(out)) {
      return out.filter((n) => (typeof n === 'string' ? n : n.name) === only);
    }
    return out;
  };
}

// ③ 保护真实配置：拦截 config/default.json 写入
if (process.env.QA_GUARD_CONFIG_WRITE === '1') {
  const realWrite = fs.writeFileSync;
  const isCfg = (p) => String(p).replace(/\\/g, '/').endsWith('/config/default.json');
  fs.writeFileSync = function patched(file, ...rest) {
    if (isCfg(file)) return undefined; // 静默吞掉（内存配置已更新，GET 仍能读回）
    return realWrite.call(this, file, ...rest);
  };
  const realRename = fs.renameSync;
  fs.renameSync = function patched(a, b) {
    if (isCfg(b)) return undefined;
    return realRename.call(this, a, b);
  };
  void path;
}
