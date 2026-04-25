# Nichijou Loop · 家庭 AI 管家

本地部署的家庭 AI 管家系统。家庭成员通过微信与 AI 管家对话，AI 根据每个人的长期习惯，通过插件体系自动完成提醒、推荐等任务。闲置 iPad 作为家庭看板实时展示所有人的今日安排。

## 功能

- **家庭组管理** — 创建家庭，邀请成员，每人独立档案
- **AI 管家对话** — 多模型支持（OpenAI / Anthropic / DeepSeek / 本地 Ollama），人格可定制（SOUL.md）
- **习惯调度引擎** — 定义长期习惯并自动提醒
- **微信通道** — 通过 ClawBot (iLink) 与家庭成员微信互联
- **iPad 看板** — 全屏看板模式，展示家庭成员今日安排
- **插件体系** — 可扩展插件能力（默认提供天气能力）
- **OpenClaw Skill 兼容** — 可加载 SKILL.md 格式的技能
- **多媒体对话日志** — 管理后台可查看带图片/语音/文件/视频的会话记录与缩略图、下载与处理状态（说明见 [docs/features/multimedia-logs.md](docs/features/multimedia-logs.md)）

## 快速开始

### 源码运行

```bash
git clone https://github.com/maxuekai/nichijou-loop.git
cd nichijou-loop
pnpm install
pnpm build

# 启动服务器
pnpm nichijou start
# 打开 http://localhost:3000，首次访问自动进入设置引导
```

### Docker 部署

```bash
git clone https://github.com/maxuekai/nichijou-loop.git
cd nichijou-loop
cp .env.example .env  # 可选，也可在 Web 界面配置
docker compose up -d
# 打开 http://localhost:3000
```

### REPL 模式（调试用）

```bash
pnpm nichijou repl
```

## 本地模型支持

`@nichijou/ai` 兼容任何 OpenAI API 格式端点，天然支持本地模型：

| 方案 | baseUrl | 推荐模型 |
|------|---------|---------|
| DeepSeek | `https://api.deepseek.com/v1` | deepseek-chat |
| Ollama | `http://localhost:11434/v1` | qwen2.5, llama3 |
| LM Studio | `http://localhost:1234/v1` | - |
| vLLM | `http://localhost:8000/v1` | - |

本地模型 = 所有数据完全不出家门。

## 项目结构

```
nichijou-loop/
  packages/
    shared/          # 共享类型和工具函数
    ai/              # LLM 通信层（可独立复用）
    agent/           # Agent 运行时（可独立复用）
    core/            # 家庭管家核心 + HTTP 服务器 + CLI
    channel-wechat/  # 微信 iLink 通道
    plugin-sdk/      # 插件开发 SDK
    plugins/
      weather/       # 天气插件（示例）
    web/             # React Dashboard (Vite + TailwindCSS)
```

## 数据目录

运行时数据存储在 `~/.nichijou/`：

```
~/.nichijou/
  config.yaml          # 全局配置
  SOUL.md              # 管家人格
  family/
    family.yaml        # 家庭信息
    members/
      *.md             # 成员档案
      *.routines.yaml  # 长期习惯
  skills/              # OpenClaw Skill
  plugins/             # 插件数据
  wechat/accounts/     # 微信连接凭证
  db/nichijou.sqlite   # 对话历史 + 运行时数据
```

## 开发

```bash
pnpm install
pnpm build          # 构建所有包
pnpm dev            # 开发模式（watch）
```

## 技术栈

- **Runtime**: Node.js 22+ / TypeScript 5+
- **前端**: React 19 + Vite + TailwindCSS 4
- **数据库**: SQLite (better-sqlite3)
- **调度**: node-cron
- **微信**: wechat-ilink-client (iLink Bot API)

## License

MIT
