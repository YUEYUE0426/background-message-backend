# Background Message Backend

用于移动应用后台消息、主动消息和 Web Push 通知的 Cloudflare Worker 后台服务。

## 功能

- 后台 AI 消息
- 主动消息定时任务
- Web Push 系统通知
- Durable Object 数据存储
- 每个用户使用自己的 Cloudflare Worker
- AI API 设置由前端应用管理，并同步到用户自己的 Worker

## 部署

此项目可以通过 Cloudflare Deploy to Workers 部署。

部署完成后，需要在 Cloudflare Worker 的 Settings → Variables and Secrets 中设置：

- `VAPID_PUBLIC_KEY`
- `VAPID_PRIVATE_KEY`
- `VAPID_SUBJECT`

如果需要额外保护后台 API，也可以设置：

- `BACKEND_TOKEN`

请不要把这些敏感信息提交到公开 GitHub 仓库。

## AI API

AI API 地址、API Key 和模型由前端应用管理。

启用后台服务后，当前 AI 配置会同步到用户自己的 Worker，用于网页关闭或应用进入后台后的定时 AI 任务。

AI Key 只应存储在自己控制的 Cloudflare Worker 中。

## 使用

部署完成后会获得一个 Worker URL，例如：

`https://background-message-backend.example.workers.dev`

将该 URL 填入应用的后台消息服务设置。

## 安全

请只将本项目部署到自己控制的 Cloudflare 帐号。

不要在 GitHub 中提交：

- AI API Key
- VAPID 私钥
- Cloudflare API Token
- 其他密码或访问令牌

Deployment update
