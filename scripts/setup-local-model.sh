#!/usr/bin/env bash
# 装本地小模型：Ollama（开机自启）+ 千问 3.5 4B（约 3.4GB，能看图）
# 用法：bash scripts/setup-local-model.sh
# 装好后在 Glint 设置 → 模型分配 里选「本地千问 · Ollama · qwen3.5:4b」
set -euo pipefail

MODEL=qwen3.5:4b
API=http://127.0.0.1:11434

command -v ollama >/dev/null || HOMEBREW_NO_AUTO_UPDATE=1 brew install ollama
brew services start ollama
for _ in $(seq 1 30); do curl -s --noproxy '*' "$API/api/version" >/dev/null && break; sleep 1; done

ollama pull "$MODEL"

# Ollama 按显存给默认上下文，16GB 的 Mac 只有 4096：论文段落 + 对话历史一长就把系统提示词挤掉，放到 16384
MF=$(mktemp)
printf 'FROM %s\nPARAMETER num_ctx 16384\n' "$MODEL" > "$MF"
ollama create "$MODEL" -f "$MF"
rm -f "$MF"

# 第一次用 Metal 要编译着色器（约 30 秒），而 Ollama 探测 GPU 只等 30 秒，超时就退回 CPU（慢好几倍）；
# 先单独预热一次，再重启服务让它重新探测
"$(brew --prefix ollama)/libexec/lib/ollama/llama-server" --list-devices >/dev/null 2>&1 || true
brew services restart ollama
for _ in $(seq 1 60); do curl -s --noproxy '*' "$API/api/version" >/dev/null && break; sleep 1; done

# 试答一句（reasoning_effort=none 关掉思考，和 Glint 里的设置一致）
curl -s --noproxy '*' "$API/v1/chat/completions" -H 'content-type: application/json' \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"只回复两个字：你好\"}],\"reasoning_effort\":\"none\"}" |
  python3 -c "import sys,json; print('试答：', json.load(sys.stdin)['choices'][0]['message']['content'])"
ollama ps
echo "PROCESSOR 一栏应该是 100% GPU；要是 CPU，执行一次 brew services restart ollama"
