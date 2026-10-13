# Linux.do / Discourse 阅读相关接口实验记录

> 2026-10-13，社区用户在**本人已登录浏览器**中进行的有限实验。非官方 API 文档；接口、字段和站点规则可能变动。本文只记录已实际使用的接口与可复现实验，不提供批量刷阅读量或规避风控的实现。

## 1. 已观察到的接口

| 方法 | 路径 | 用途 | 已观察结果 |
| --- | --- | --- | --- |
| GET | `/session/current.json` | 获取当前登录用户 | `current_user.username` |
| GET | `/latest.json?no_definitions=true&page=0` | 最新主题列表 | `topic_list.topics[]`，包含主题 ID 等；列表不保证提供个人最后已读楼层 |
| GET | `/t/{topic_id}.json` | 主题详情与个人阅读进度 | `last_read_post_number`、`last_read_post_id`、`highest_post_number`、`posts_count` 等 |
| GET | `/u/{username}.json` | 用户资料 | `user.time_read`、`user.recent_time_read` 等 |
| GET | `/u/{username}/summary.json` | 用户累计阅读统计 | `user_summary.posts_read_count`、`topics_entered`、`days_visited`、`time_read`、`recent_time_read` |
| POST | `/topics/timings` | 上报主题帖子阅读时间；本次实验可推进最后已读楼层 | 表单字段 `topic_id`、`timings[楼层号]`；在两个主题上返回 HTTP 200，随后读取进度成功 |

上述 URL 均为相对路径，须在 Linux.do 同源已登录会话中使用。GET 可带 `cache: 'no-store'` 以避免浏览器缓存。POST 会更改真实阅读状态，请勿把它当作无副作用的查询。

## 2. 可复用的只读控制台代码

```js
(async () => {
  const session = await fetch('/session/current.json', {
    credentials: 'same-origin'
  }).then(r => r.json());
  const username = session.current_user?.username;
  if (!username) throw new Error('未登录');
  const topicId = 847468; // 自行替换
  const [topicResponse, summaryResponse] = await Promise.all([
    fetch(`/t/${topicId}.json`, {credentials:'same-origin',cache:'no-store'}),
    fetch(`/u/${encodeURIComponent(username)}/summary.json`, {credentials:'same-origin',cache:'no-store'})
  ]);
  if (!topicResponse.ok || !summaryResponse.ok) {
    throw new Error(`HTTP ${topicResponse.status} / ${summaryResponse.status}`);
  }
  const t = await topicResponse.json();
  const s = (await summaryResponse.json()).user_summary;
  console.table({
    topic_id:t.id,
    last_read_post_number:t.last_read_post_number,
    highest_post_number:t.highest_post_number,
    posts_count:t.posts_count,
    posts_read_count:s.posts_read_count,
    topics_entered:s.topics_entered,
    time_read:s.time_read,
    recent_time_read:s.recent_time_read
  });
})();
```

## 3. POST 阅读位置实验（记录，不建议批量调用）

已使用的表单形状：

```text
POST /topics/timings
Content-Type: application/x-www-form-urlencoded; charset=UTF-8
X-CSRF-Token: <页面 meta[name="csrf-token"] 的值>

topic_id=847468&timings%5B6523%5D=1000
```

- 主题 `482293`：`last_read_post_number` 从 721 变为 9235，HTTP 200。
- 主题 `847468`：`last_read_post_number` 从 2665 变为 6523，HTTP 200；在本次前后对照中 `posts_read_count` 仍为 35377，`time_read` 仍为 381259，`topics_entered` 仍为 2680。
- 第二次 POST 后紧接着的一次 `GET /t/847468.json` 返回 HTTP 500；稍后重新请求恢复 HTTP 200，并确认楼层更新成功。**没有足够证据认定是风控**。
- `highest_post_number` 是最高楼层编号，不等于 `posts_count`：主题 847468 当时分别为 6523 与 5276（可能存在楼层编号间隙）。
- 观察仅说明阅读位置推进**未立即**带来累计阅读帖子数增长；不能证明后续异步任务不会更新，也不能证明 30 天阅读任务的统计口径。

## 4. 待核实：蓝点、停留时间与阅读统计

用户观察：帖子右上角蓝色未读点在一定停留时间后消失；连续快速浏览约 20 分钟后，蓝点可能暂时不再消失，数小时后恢复。**这是待验证的行为描述，不是已确认的服务端限额、冷却时间或反作弊规则。**

建议调查：
1. 蓝点 DOM 类名与对应前端状态字段；区分 UI 渲染、浏览器本地状态与服务端已读状态。
2. Network 中正常阅读时的请求名称、请求体、响应码和时间间隔；关注 `/topics/timings` 及其他真实出现的请求，避免凭空推测接口。
3. Discourse 开源代码里 `posts_read_count` 的更新路径、帖子阅读记录和时间统计。
4. 通过只读快照记录 `posts_read_count`、`time_read`、`last_read_post_number` 的变化，避免并发浏览造成混淆。
5. 若遇到 429/403/500 或阅读点不再更新，停止主动测试，保留响应证据，不尝试规避限制。

## 5. 注意事项

- `Promise {<pending>}` 是控制台异步函数执行中的正常显示，不是请求失败。
- HTTP 200 仅表示请求已被接受；具体效果要重新 GET 验证。
- 不公开 CSRF Token、Cookie、会话标识或完整个人资料。
- 30 天任务可能与累计 `posts_read_count` 采用不同窗口/口径，尚未证实。
