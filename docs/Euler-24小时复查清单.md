# Euler 24小时复查清单

## 目的

本清单用于在本次“手工等级模式”改造上线后，运行 24 小时再做一次复查，确认：

- Community 默认主链路是否稳定
- Euler Key 是否不再被错误打到 `/webcast/room_id`
- 只有手工设为 Premium 的 Key 才会启用高级兜底
- 后台面板展示是否与真实运行状态一致

## 24小时后先看什么

优先按下面顺序检查：

1. 后台 `最近连接路径`
2. 后台 `房间查询请求 / 直播探活请求`
3. 后台每把 Key 的 `最后错误`
4. 是否仍出现大面积 `Euler room lookup rate limited (429)`
5. 是否有基础 / Community Key 被错误标成 Premium 使用

## 正常现象

如果系统运行正常，通常会看到：

- `最近连接路径` 主要是 `TikTok HTML 解析` 或 `TikTok API 解析`
- `Fallback 建连` 有少量增长，但不是异常飙升
- 基础 / Community Key 下不再持续出现 `Euler room lookup rate limited (429)`
- 未手工设为 Premium 的 Key，不应频繁增加 `房间查询请求`
- 活跃房间较多时，`直播探活请求` 增长也应比过去更平缓

## 异常信号

如果出现下面情况，需要重点复核：

- 所有 Key 仍持续出现 `Euler room lookup rate limited (429)`
- `房间查询请求` 在 Community 场景下增长很快
- `最近连接路径` 长时间大量落在 `Euler 兜底解析`
- 基础 / Community Key 的 `最后错误` 仍反复出现 room lookup 权限/限流类报错
- `全 Key 冷却` 计数持续上涨，且 `Fallback 建连` 明显增多

## 建议阈值

这是运维判断时的经验阈值，不是硬性报警线：

- `最近连接路径`：24 小时内应以 `TikTok HTML / API` 为主
- `Fallback 建连`：如果相对 `成功建连` 占比持续偏高，需要排查 HTML / API 是否受限
- `房间查询请求`：如果在纯 Community 配置下仍明显偏高，说明可能仍有错误的 Premium 调用路径
- `限流次数`：若连续增长且没有回落，优先排查并发、房间规模、代理与上游限制

## 到时让我检查时，你可以直接说

你 24 小时后可以直接发一句：

`按 docs/Euler-24小时复查清单.md 帮我做 Euler 复查。`

如果你愿意，也可以同时附上这几项截图或数字：

- Euler 运行态总览截图
- 3~5 把 Key 卡片截图
- 最近连接路径
- 成功建连 / Fallback 建连 / 限流次数
- 是否有任何 Key 仍显示 room lookup 429

## 本轮改造后的判定标准

本轮改造达标，应满足：

- 系统不再自动探测 Premium 能力
- Key 等级由后台手工设置
- Community 默认主链路继续稳定工作
- 只有手工设为 Premium 的 Key 才允许使用 Euler `/webcast/room_id`
- 后台面板不再被历史探针状态误导
