# Bot 通用审核系统（GRS）

面向 QQ / Koishi 机器人的**多通道 AI 内容审核系统**，覆盖文本与图片。

设计原则：**所有 AI 通道都是可选的**。你可以只配一个、配两个，或者一个都不配——系统不会因此崩溃或刷屏报错，而是自动跳过未配置的通道，并在结果里明确告诉你哪些通道被跳过。

- 管理后台：<http://localhost:11451>
- 审核接口：`POST /api/moderate/text`、`POST /api/moderate/image`、`POST /api/moderate`
- 健康检查：`GET /health`（返回各通道可用状态）

---

## 目录

- [核心特性](#核心特性)
- [快速开始](#快速开始)
- [可选能力矩阵](#可选能力矩阵)
- [配置说明](#配置说明)
- [环境变量](#环境变量)
- [安全设计](#安全设计)
- [插件系统](#插件系统)
- [Docker 部署](#docker-部署)
- [目录结构](#目录结构)
- [常见问题](#常见问题)
- [排障](#排障)
- [License](#license)

---

## 核心特性

- **多通道路由**：本地 Ollama / 云端大模型（阿里云百炼 Qwen）/ 阿里云内容安全（绿网），可任意组合
- **敏感词预检兜底**：关键级别词条命中即拦截，不依赖任何 AI 通道，是"零配置也能用"的底线能力
- **提示词注入防御**：待审核内容与系统指令强隔离（随机定界 + 逃逸中和）、模型输出强校验（白名单/枚举/取值域/长度）、全部失败路径 fail-closed
- **优雅降级**：未配置的通道静默跳过，`/health` 与审核结果都会标注 `skipped_channels` 与 `degraded`
- **双审与交叉校验**：可开启双通道二次确认，通道结论冲突时按可配置策略裁定
- **图片审核**：云端视觉模型 / 本地视觉模型 / WD1.4 标签器，按配置启用
- **审核记录与统计**：日审核量、Token 消耗、耗时统计，支持记录查询与模型对比
- **插件系统**：基于 cordis 的可插拔扩展，插件与核心通过契约解耦，禁用插件不影响核心运行

---

## 快速开始

### 1. 获取代码

```bash
git clone https://github.com/Alin-sky/GRS.git
cd GRS
```

或从仓库页面 **Code → Download ZIP**。

### 2. 安装依赖

```bash
npm install
# 国内加速：npm install --registry=https://registry.npmmirror.com
```

> 需要 **Node.js ≥ 20.9.0**（依赖 `sharp` 的要求）。
> Windows 下双击 `start.bat` 会**自动检测并准备 Node**：本地已有可用版本则直接使用，否则自动下载便携版到 `runtime/node/`（该目录已在 `.gitignore` 中）。无需手动安装。

### 3. 直接启动（零配置也能跑）

```bash
# Windows
start.bat

# 任意平台
npm start
```

**不配置任何 API Key 也能启动。** 此时系统进入 `degraded` 状态，仅执行敏感词预检，`/health` 会如实报告各通道未配置。

打开 <http://localhost:11451> 即是管理后台。

### 4. 按需配置通道

想启用某个通道时，复制配置模板再填写：

```bash
# Windows
copy config\default.example.json config\default.json

# Linux / macOS
cp config/default.example.json config/default.json
```

> `config/default.json` 含密钥，已被 `.gitignore` 排除，**不会**被提交。

---

## 可选能力矩阵

**这是本项目最重要的设计约定**：下表所有能力均为可选，未配置时的行为是"静默跳过 + 单一提示"，不会报错、不会重试风暴、不会刷屏。

| 能力 | 必需? | 未配置时的行为 | 相关配置 |
|---|---|---|---|
| 敏感词预检 | 可选（强烈推荐） | 预检跳过，其余通道不受影响 | `data/sensitive_words.json` |
| 内置涉政规则库 | 可选 | 跳过内置规则，仅用你自己的词库 | `data/builtin-patterns.json` |
| 本地 Ollama（文本） | 可选 | 该通道标记 `skipped`，不影响其它通道 | `ollama.host` / `ollama.textModel` |
| 本地 Ollama（视觉） | 可选 | 图片走其它可用通道 | `ollama.visionModel` |
| 云端大模型（文本） | 可选 | 该通道标记 `skipped` | `qwenCloud.apiKey` |
| 云端大模型（视觉） | 可选 | 同上 | `qwenCloud.visionEnabled` |
| 阿里云内容安全（绿网） | 可选 | 该通道标记 `skipped` | `contentSafety.accessKeyId/Secret` |
| 图片审核 | 可选 | 图片接口返回"无可用图片通道"，**不报错** | `moderation.reviewChannels` |
| WD1.4 标签器 | 可选 | 跳过标签器，走本地/云端视觉模型 | `plugins/wd14-tagger` |
| 插件系统 | 可选 | 禁用后核心正常启动、审核接口可用 | `plugins/` |
| 模型对比 / 定时任务 | 可选 | 无可用通道时自动停用并说明原因 | `ollama.comparisonEnabled` |

> **占位符会被识别为"未配置"**：模板里的 `YOUR_DASHSCOPE_API_KEY`、`CHANGE_ME` 等不会被误当成有效凭据，因此**填了模板但没改密钥，也不会产生无效请求**。

---

## 配置说明

主配置文件：`config/default.json`（由 `config/default.example.json` 复制而来）。

### 服务

| 字段 | 说明 | 默认 |
|---|---|---|
| `server.port` | 监听端口 | `11451` |
| `server.host` | 监听地址 | `0.0.0.0` |

### 通道开关

```jsonc
"moderation": {
  "reviewChannels": {
    "local": false,          // 本地 Ollama
    "cloud": true,           // 云端大模型
    "contentSafety": true,   // 阿里云内容安全
    "disputeStrategy": "contentSafety"  // 通道冲突时的裁定依据
  }
}
```

把某个通道设为 `true` 之前，请先确认它已正确配置，否则该通道会被判定为未配置并跳过。

### 关键字段

| 字段 | 说明 |
|---|---|
| `qwenCloud.apiKey` | 阿里云百炼 DashScope API Key |
| `qwenCloud.billingSource` | 额度来源：`dashscope`（按量）或 `token-plan`（订阅额度） |
| `contentSafety.accessKeyId` / `accessKeySecret` | 阿里云 RAM AccessKey（内容安全用） |
| `adminPassword` | 管理后台密码，公网部署**必须**修改 |
| `moderation.strictness` | 严格程度，影响判定阈值 |
| `moderation.onAiFailure` | AI 判定失败时的策略，见[安全设计](#安全设计) |

---

## 环境变量

所有敏感配置均可用环境变量覆盖（优先级高于配置文件），推荐用于容器化部署：

| 变量名 | 说明 | 默认 |
|---|---|---|
| `DASHSCOPE_API_KEY` | 百炼 DashScope API Key | 无 |
| `ALIBABA_CLOUD_ACCESS_KEY_ID` | 内容安全 AccessKey ID | 无 |
| `ALIBABA_CLOUD_ACCESS_KEY_SECRET` | 内容安全 AccessKey Secret | 无 |
| `ADMIN_PASSWORD` | 管理后台密码 | 无 |
| `OLLAMA_HOST` | Ollama 地址 | `http://127.0.0.1:11434` |
| `OLLAMA_TEXT_MODEL` | 本地文本审核模型 | `gpt-oss-safeguard:20b` |
| `MODERATION_MODE` | 设为 `cloud-only` 强制仅用云端 | 配置值 |
| `MOD_PORT` / `MOD_HOST` | 服务端口 / 监听地址 | `11451` / `0.0.0.0` |

---

## 安全设计

### 提示词注入防御

审核系统本身是一个高价值攻击目标：待审核内容若能被模型当成指令，攻击者就能让审核"失灵"。本项目对此做了三层防护：

1. **输入隔离**：待审核文本以随机定界符（每请求不同）包裹后传入，只作为"被审查对象"；文本内试图伪造定界符的内容会被中和。
2. **不可协商规则**：核心安全约束写在代码常量中，`prompts/*.md` 只能补充、**不能覆盖或取消**，避免通过污染提示词文件绕过防线。
3. **输出强校验**：模型返回必须通过字段白名单、枚举、取值域、长度上限校验；任何不合规输出都被归类为 `empty` / `parse` / `schema` / `unsafe` 等失败码。

### fail-closed（失败即拦截）

`moderation.onAiFailure` 控制 AI 判定失败时的行为：

| 取值 | 行为 | 适用场景 |
|---|---|---|
| `block`（**默认**） | 不放行，判定为拦截并告警 | 安全优先，注入攻击无法靠畸形输出绕过 |
| `review` | 不拦截也不放行，标记"待人工复核" | 误杀敏感、有兜底人工审核流程 |

注意区分两种情况：

- **未配置任何 AI 通道** → 合法的降级，结论交由敏感词预检，不算失败；
- **已配置但调用失败/输出畸形** → 按 `onAiFailure` 处理，`passed` 恒为 `false`。

### 部署建议

- 公网暴露时**必须**修改 `adminPassword`，并建议置于反向代理与 HTTPS 之后
- 密钥优先用环境变量注入，避免落盘
- 定期检查 `logs/` 下的告警日志，关注 `fail_closed` 与注入信号计数

---

## 插件系统

插件位于 `plugins/`，与核心通过**契约**交互，不直接依赖核心内部模块。

| 插件 | 作用 | 依赖 |
|---|---|---|
| `batch-image-suite` | 批量图片整理与 NSFW 审核 | 无（需图片通道） |
| `wd14-tagger` | WD1.4 图像标签器，用于头像/图片打标 | 需自备 Python 环境（实验性） |

- 插件可独立启停，**禁用插件后核心功能不受影响**
- 插件返回值会经过与模型输出相同的校验，插件无法伪造风险等级
- 插件能力需在 manifest 中声明，未声明的能力无法调用

---

## Docker 部署

```bash
docker build -f Dockerfile.cloud -t grs .
docker run -d -p 11451:11451 \
  -e DASHSCOPE_API_KEY=你的key \
  -e ADMIN_PASSWORD=你的密码 \
  grs
```

或使用 `docker-compose.cloud.yml`。

---

## 目录结构

```
├── config/          配置模板（default.example.json）
├── data/            敏感词库与运行时数据（记录、对比结果）
├── docs/            设计文档
├── examples/        调用示例（bot_client.js）
├── plugins/         插件
├── prompts/         审核提示词（system prompt）
├── public/          管理后台前端
├── scripts/         安装、自检、测试脚本
├── src/             服务端源码
│   ├── security/    注入防御（定界、输出校验、fail-closed）
│   └── ...
├── Dockerfile.cloud
└── start.bat / start.sh
```

---

## 常见问题

**Q：没装 Ollama，启动会报错吗？**
不会。本地通道是可选能力，未配置时自动跳过，其余通道正常工作。`/health` 会显示该通道为 `skipped`。

**Q：一个 API Key 都没有，能用吗？**
能。系统仍可启动，并执行敏感词预检。此时 `/health` 返回 `degraded: true`，审核结果里会说明"未配置可用的 AI 通道，结论仅基于敏感词预检"。

**Q：为什么日志提示"AI 审核通道异常"？**
说明某个**已配置**的通道调用失败或返回无法解析。按默认 `onAiFailure: block`，该次审核判定为拦截。可检查密钥、额度、网络，或将其改为 `review`。

**Q：端口 11451 被占用怎么办？**
改 `server.port`，或设置环境变量 `MOD_PORT`。Windows 启动脚本会自动检测并结束占用该端口的旧进程。

**Q：填了模板但我没改占位符密钥，会怎样？**
占位符（`YOUR_xxx`、`CHANGE_ME`）会被识别为"未配置"，该通道直接跳过，**不会**发起无效请求。

**Q：怎么只用云端、完全不用本地模型？**
保持 `reviewChannels.local: false` 即可——这是默认配置。

**Q：敏感词库为空会怎样？**
预检层跳过，其余通道照常。建议至少维护一份基础词库。

---

## 排障

- **日志位置**：`logs/moderation.log`（审核流水）、`logs/error.log`（错误）、`logs/restart.log`
- **健康检查**：`curl http://localhost:11451/health` —— 查看各通道可用性与 `degraded` 状态
- **配置自检**：启动时会打印能力摘要与配置冲突告警；`npm run setup` 可跑安装向导
- **注入回归**：`node scripts/test-injection.js` —— 验证注入防御未被破坏
- **发布前自检**：`node scripts/pre-publish-check.js` —— 扫描密钥、绝对路径、敏感残留

---

## License

MIT
