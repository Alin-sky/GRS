# 给另一台电脑（3060 Ti 8GB）的 WorkBuddy 指令

## 直接复制以下全部内容发给那台电脑的 WorkBuddy

---

帮我搭建一个 Ollama 图片审核服务，用于 QQ 机器人内容审核。这台机器的显卡是 RTX 3060 Ti 8GB，需要跑 qwen2.5vl:7b 视觉模型，并通过网络提供给另一台电脑调用。

请按以下步骤执行：

### 第1步：检查环境

1. 检查 Ollama 是否已安装（运行 `ollama --version`），如果没有安装，帮我下载安装 Ollama（从 <https://ollama.com/download/OllamaSetup.exe> 下载，静默安装）
2. 检查 nvidia-smi 确认 GPU 可用（RTX 3060 Ti, 8GB）
3. 如果有代理（Clash/v2ray 等），记录代理地址用于加速下载

### 第2步：拉取视觉模型

```bash
ollama pull qwen2.5vl:7b
```

这个模型约 6GB，8GB 显存足够运行（Q4 量化约占 5-6GB 显存）。

### 第3步：创建审核模型

在项目目录下创建文件 `Modelfile.vision`，内容如下：

```
FROM qwen2.5vl:7b

PARAMETER temperature 0.1
PARAMETER num_ctx 4096
PARAMETER repeat_penalty 1.1
PARAMETER top_p 0.8

SYSTEM """你是一个专业的QQ机器人内容安全审核系统。你的任务是审核用户发送的图片，判断其是否违反QQ机器人平台运营规范及相关法律法规。

## 审核范围

### 1. 涉政内容（political）— 严重违规
- 含有政治敏感人物、政治事件的图片
- 反政府、反社会的宣传图片
- 煽动民族仇恨、民族歧视的图片
- 涉及国家旗帜、国徽的不当使用

### 2. 色情低俗（pornographic）— 高风险违规
- 淫秽色情图片、暴露照片
- 挑逗性、性暗示图片
- 低俗、不雅的图片内容
- 不当暴露的身体图片

### 3. 营销广告（marketing）— 中高风险违规
- 营销广告图片、推广海报
- 含有二维码、微信号的引流图片
- 代购、推销、门店宣传图片
- 虚假夸大推广图片

### 4. 暴力恐怖（violence）— 严重违规
- 暴力、血腥、杀戮图片
- 恐怖主义、极端主义宣传图片
- 展示伤害行为的图片

### 5. 赌博诈骗（gambling）— 高风险违规
- 赌博、博彩网站推广图片
- 虚假红包、虚假活动截图
- 诈骗信息图片

### 6. 隐私侵权（privacy）— 中风险违规
- 未经授权展示他人隐私信息的图片
- 包含他人个人信息的截图

### 7. 其他违法（illegal）— 高风险违规
- 外挂、破解工具售卖图片
- 侵权盗版内容图片

## 输出格式

你必须严格按照以下JSON格式输出，不要输出任何其他内容：

{"risk_level": "safe或low或medium或high或critical", "categories": ["违规类别ID列表"], "confidence": 0.0到1.0, "reason": "判定理由50字以内", "suggestion": "处理建议", "image_description": "图片内容简要描述30字以内"}

## 判定原则

1. 正常图片保护：正常的生活照、风景照、表情包、游戏截图、学习资料等不应被误判
2. 图文结合：同时考虑图片的视觉内容和图片中的文字内容
3. 二维码警惕：图片中的二维码通常意味着引流营销，需提高警惕
4. 禁止联想：只根据图片实际内容判断，不要过度解读

## 示例

输入: 一张风景照片
输出: {"risk_level":"safe","categories":[],"confidence":0.95,"reason":"正常风景照片","suggestion":"内容安全，可放行","image_description":"自然风景照"}

输入: 一张含有二维码和"加微信免费领红包"文字的图片
输出: {"risk_level":"high","categories":["marketing","gambling"],"confidence":0.9,"reason":"二维码引流+红包诱导","suggestion":"检测到营销引流，建议拦截","image_description":"含二维码的营销图片"}

注意：只输出JSON。如果图片无法识别，输出：{"risk_level":"low","categories":[],"confidence":0.3,"reason":"图片无法识别","suggestion":"建议人工审核","image_description":"无法识别"}"""
```

然后运行：

```bash
ollama create moderator-vision -f Modelfile.vision
```

### 第4步：配置 Ollama 允许网络访问

默认 Ollama 只监听 127.0.0.1，需要改成监听所有网卡，让另一台电脑能访问。

**Windows 方法**：

1. 打开系统环境变量设置（设置 → 系统 → 关于 → 高级系统设置 → 环境变量）
2. 新建系统环境变量：
   - 变量名：`OLLAMA_HOST`
   - 变量值：`0.0.0.0:11434`
3. 重启 Ollama 服务（右下角托盘图标右键 → Quit，然后重新打开 Ollama）

或者用命令行（管理员权限的 PowerShell）：

```powershell
# 设置环境变量
[System.Environment]::SetEnvironmentVariable("OLLAMA_HOST", "0.0.0.0:11434", "Machine")
# 重启 Ollama
Stop-Process -Name "ollama*" -Force
Start-Sleep 2
Start-Process "C:\Users\$env:USERNAME\AppData\Local\Programs\Ollama\ollama app.exe"
```

### 第5步：开放防火墙端口

用管理员权限的 PowerShell 运行：

```powershell
New-NetFirewallRule -DisplayName "Ollama Vision API" -Direction Inbound -Port 11434 -Protocol TCP -Action Allow
```

### 第6步：获取本机 IP 并验证

```bash
# 查看本机局域网 IP（找到 192.168.x.x 或 10.x.x.x 的地址）
ipconfig
```

验证另一台电脑能访问：

```bash
# 在另一台电脑上运行（替换 IP 为本机实际 IP）
curl http://<本机IP>:11434/api/version
```

如果返回 `{"version":"0.x.x"}` 就说明网络通了。

### 第7步：告诉我结果

完成后请告诉我：

1. Ollama 是否安装成功
2. qwen2.5vl:7b 是否拉取完成
3. moderator-vision 模型是否创建成功
4. 本机的局域网 IP 地址是什么（另一台电脑需要这个地址来调用）
5. 从另一台电脑能否访问 http://<本机IP>:11434/api/version

---

## 测试图片审核效果

创建好模型后，可以这样测试：

```bash
# 用命令行测试（需要一张测试图片）
ollama run moderator-vision "请审核这张图片" -f ./test_image.jpg

# 或者通过 API 测试
curl http://localhost:11434/api/chat -d '{
  "model": "moderator-vision",
  "messages": [{"role": "user", "content": "请审核这张图片", "images": ["<base64编码的图片>"]}],
  "stream": false
}'
```

模型应该返回类似这样的 JSON：

```json
{"risk_level":"safe","categories":[],"confidence":0.95,"reason":"正常风景照片","suggestion":"内容安全，可放行","image_description":"自然风景照"}
```

