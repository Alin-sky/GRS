# Qwen3-14B 模型下载指南

## 下载链接（选一个用浏览器下载）

### 方案1：HuggingFace（官方源，需要梯子）
- 链接：https://huggingface.co/Qwen/Qwen3-14B-GGUF/resolve/main/Qwen3-14B-Q4_K_M.gguf
- 大小：约 9.0 GB
- 文件名：`Qwen3-14B-Q4_K_M.gguf`
- 需要开 Clash 代理

### 方案2：ModelScope（国内源，不需要梯子）
- 页面：https://www.modelscope.cn/models/Qwen/Qwen3-14B-GGUF/files
- 找到 `Qwen3-14B-Q4_K_M.gguf` 点击下载
- 如果官方源没有，试试：https://www.modelscope.cn/models/bartowski/Qwen_Qwen3-14B-GGUF/files

### 方案3：Ollama 直链（可能也慢）
- 链接：https://ollama.com/v2/library/qwen3/blobs/sha256:a8cc1361f3145dc01f6d77c6c82c9116b9ffe3c97b34716fe20418455876c40e
- 下载后改名为 `Qwen3-14B-Q4_K_M.gguf`

---

## 下载完成后

把文件放到这个路径：
```
models\Qwen3-14B-Q4_K_M.gguf
```

然后告诉我，我帮你执行导入命令创建审核模型。

---

## 导入命令（我帮你执行，你不用手动操作）

```
cd <项目目录>
ollama create moderator-qwen3 -f prompts/Modelfile.qwen3-local
```

这个 Modelfile 已经配好了：
- FROM 指向本地 GGUF 文件
- 审核专用 System Prompt（7大违规类别 + few-shot示例）
- 关闭思考模式（直接输出JSON，不输出思考过程）
- temperature 0.1（审核需要确定性输出）
- 正确的 Qwen3 对话模板和停止符
