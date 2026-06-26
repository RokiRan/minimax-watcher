# minimax-watcher

持续观察 MiniMax（CN 区域）token plan 的剩余量与重置时间，并在使用率达到阈值时通过 NewAPI 自动停用 / 启用对应渠道。

## 行为

| 触发条件 | 动作 |
|---|---|
| 用量 ≥ 阈值（默认 98%，即剩余 < 2%） | `PUT /api/channel/` 把 `status` 置为禁用值 |
| 重置时间已到（可配置提前量） | `PUT /api/channel/` 把 `status` 置为启用值 |
| 其他 | 跳过 |

脚本是**幂等**的：可以重复执行，不会重复触发；重启后能从 `state.json` 恢复上次状态。

## 文件结构

```
.
├── watch.mjs         # 主脚本（零依赖，Node ≥ 18）
├── package.json
├── .env.example      # 环境变量示例（复制为 .env 再改）
├── .gitignore
├── state.json        # 运行期生成：缓存渠道状态 / 上次 reset 时间
└── README.md
```

## 快速开始

```bash
# 1) 安装 Node.js 18+
node --version   # 应打印 v18.x 或更高

# 2) 复制并编辑配置
cp .env.example .env
$EDITOR .env

# 3) 干跑一次（只跑一轮，便于检查字段映射）
node watch.mjs --once

# 4) 持续运行
node watch.mjs
```

## 配置项

`.env` 中所有项都可以走环境变量。详见 [.env.example](./.env.example)。

### 必填

| 变量 | 含义 |
|---|---|
| `NEWAPI_BASE_URL` | NewAPI 服务地址，例如 `https://newapi.example.com` |
| `NEWAPI_ADMIN_TOKEN` | NewAPI 管理员 token（在系统设置里生成） |
| `NEWAPI_CHANNEL_ID` | 要监控的渠道 ID（数字） |
| `MINIMAX_QUERY_URL` | MiniMax 查询 token plan 的完整 URL |

### MiniMax 字段映射

不同 MiniMax 接口返回字段不同，用下面这套 dot-path 把响应映射成 `(used, total, resetAt)`：

| 变量 | 说明 |
|---|---|
| `MINIMAX_HTTP_METHOD` | `GET` 或 `POST`，默认 `GET` |
| `MINIMAX_AUTH_HEADER` | 认证 header 名字，默认 `Bearer` |
| `MINIMAX_API_KEY` | API key，会被拼接成 `Authorization: Bearer <key>` |
| `MINIMAX_EXTRA_HEADERS` | JSON 字符串，追加到请求头 |
| `MINIMAX_REQUEST_BODY` | POST body 的 JSON 字符串 |
| `MINIMAX_USED_FIELD` | 已使用量字段路径，例如 `data.used` |
| `MINIMAX_TOTAL_FIELD` | 总量字段路径，例如 `data.total` |
| `MINIMAX_REMAIN_FIELD` | 剩余量字段路径，可与上面任一组合 |
| `MINIMAX_RESET_FIELD` | 重置时间字段路径（ISO8601 或 Unix 秒/毫秒） |
| `MINIMAX_USED` / `_TOTAL` / `_REMAIN` | 显式覆盖，置后字段路径失效 |

如果响应像 `{ "base_resp": { "status_code": 0, "status_msg": "success" }, "data": { "total_grant": 1000000, "used": 12345, "remain": 987655, "reset_at": "2026-07-01T00:00:00+08:00" } }`，那么：

```bash
MINIMAX_USED_FIELD=data.used
MINIMAX_TOTAL_FIELD=data.total_grant
MINIMAX_RESET_FIELD=data.reset_at
```

如果响应是数组（每个元素一个模型），用 `MINIMAX_MODE=max_usage` 找最满的那个。MiniMax / minimax 的 `coding_plan/remains` 接口就是这种结构：

```bash
MINIMAX_MODE=max_usage
MINIMAX_ARRAY_PATH=model_remains
MINIMAX_USED_FIELD=current_interval_usage_count
MINIMAX_TOTAL_FIELD=current_interval_total_count
MINIMAX_RESET_FIELD=end_time
# MINIMAX_MODEL_FILTER=video   # 可选：只统计指定模型
```

该模式下：

- 跳过 `total=0` 的元素（避免 0/0 干扰）
- `used/total` 比值最大的元素 → 触发停用决策
- **重置时间绑定到该元素**（不是 min of all）：瓶颈模型不重置就继续停用

### NewAPI 状态值

one-api 的 `Channel.Status` 默认 `1=启用 / 0=禁用`。有些 fork（如 new-api）使用 `1=启用 / 2=禁用`，可通过下面两项覆盖：

```bash
NEWAPI_CHANNEL_STATUS_ENABLED=1
NEWAPI_CHANNEL_STATUS_DISABLED=2
```

### 调度与阈值

| 变量 | 默认 | 含义 |
|---|---|---|
| `USAGE_THRESHOLD` | `98` | 触发停用的使用率百分比 |
| `POLL_INTERVAL_MS` | `30000` | 轮询间隔（30 秒） |
| `ABORT_DISABLE_AFTER_MS` | `0` | 停用决策最长等待；0 表示永不放弃 |
| `ENABLE_LEAD_MS` | `0` | 启用提前量，避免重置瞬间的尖刺 |
| `STATE_FILE` | `./state.json` | 状态持久化路径（Bark 通知去重专用） |
| `LOG_LEVEL` | `info` | `debug`/`info`/`warn`/`error` |
| `RUN_ONCE` | `false` | 只跑一轮就退出（调试 / cron 用） |

### Bark 通知（可选）

在 `.env` 中填 `BARK_DEVICE_KEY` 即可启用 [Bark](https://bark.day.app/) iOS 推送。脚本会在两个时间点推送：

| 触发点 | 标题示例 | 推送条件 |
|---|---|---|
| 用量 ≥ `USAGE_THRESHOLD` | `⚠️ MiniMax 用量已达 99.32%` | 在同一 `(threshold, cycleId)` 组合下仅推一次；调低阈值或进入新周期视为新事件 |
| 用量从 ≥ 阈值 降到 < 阈值 | `✅ MiniMax 渠道已恢复` | 边沿触发，同一次下降只推一次 |

**去重保证**：

- 阈值通知用 `(lastNotifiedThreshold, lastNotifiedThresholdCycleId)` 元组判重：同一组合内不重复，threshold 变化或 cycleId 变化时允许再推。
- 重置通知用边沿检测（`prevPct >= threshold && currPct < threshold`）：每次真正"过线后回来"才推一次，天然不会重复。
- 状态持久化到 `STATE_FILE`（默认 `./state.json`，已加入 `.gitignore`），重启后不会重报上一次的旧事件。
- 关闭 Bark 或删除 `state.json` 都会让脚本"重新通知"——属于预期行为，便于排错。

Bark 相关变量：

| 变量 | 默认 | 含义 |
|---|---|---|
| `BARK_DEVICE_KEY` | _(空)_ | 留空即关闭 Bark；填了才会启用推送 |
| `BARK_URL` | `https://api.day.app` | 自建 Bark 服务时改这里 |
| `BARK_GROUP` | `minimax-watcher` | Bark 分组名（同组通知会自动合并） |
| `BARK_ICON` | _(空)_ | 通知图标的 URL（可选） |
| `BARK_TIMEOUT_MS` | `5000` | Bark 请求超时 |
| `BARK_THRESHOLD_LEVEL` | `timeSensitive` | 阈值通知级别 `active` / `timeSensitive` / `passive` |
| `BARK_RESET_LEVEL` | `timeSensitive` | 重置通知级别 |

## 部署

### 方式 A：systemd（推荐）

```ini
# /etc/systemd/system/minimax-watcher.service
[Unit]
Description=minimax-watcher
After=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/minimax-watcher
ExecStart=/usr/bin/node watch.mjs
Restart=on-failure
RestartSec=10
EnvironmentFile=/opt/minimax-watcher/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now minimax-watcher
journalctl -u minimax-watcher -f
```

### 方式 B：cron + 单轮模式

每 5 分钟跑一次：

```cron
*/5 * * * * cd /opt/minimax-watcher && /usr/bin/node watch.mjs --once >> watcher.log 2>&1
```

注意：cron 模式下 `state.json` 必须保留在磁盘上，否则每次都会重新读 NewAPI。

### 方式 C：直接前台 / tmux / screen

```bash
node watch.mjs
```

## 故障排查

| 现象 | 原因 / 处理 |
|---|---|
| `MiniMax API HTTP 401` | API key 错或 header 名不对。改 `MINIMAX_AUTH_HEADER` / `MINIMAX_API_KEY` |
| `无法计算使用率（缺少 used / total）` | 字段映射不对。开 `LOG_LEVEL=debug` 查 raw JSON，或贴一下响应到 README |
| `NewAPI 返回 success=false` | token 没管理员权限，或 `channel_id` 不存在 |
| 重启后立刻又停用一次 | `state.json` 被删了，或 `NEWAPI_CHANNEL_ID` 改了 |
| 一直不启用 | `MINIMAX_RESET_FIELD` 没配 / 时区不对。开 debug 看 resetAtMs |

## 安全注意

- `.env` 含敏感 token，**不要**提交到 git（已加进 `.gitignore`）。
- 建议用最小权限的 NewAPI token（只勾渠道管理）。
- `state.json` 也建议保密（虽然只含状态，没有 token）。

## License

MIT