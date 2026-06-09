# nodeseek-sou

作者：[@mskatoni](https://github.com/mskatoni)

`nodeseek-sou` 是一个面向 NodeSeek 列表页的 Tampermonkey / Violentmonkey 用户脚本。它可以一次拉取当前页后续多页帖子，在本地完成排序、过滤和批量处理，适合用来快速浏览热门主题、筛掉不想看的内容，或整理需要屏蔽的账号。

许可证：AGPL-3.0-only

## 安装

- GreasyFork 安装页：[nodeseek-sou](https://greasyfork.org/en/scripts/581904-nodeseek-sou)
- GitHub Raw 地址：

```text
https://raw.githubusercontent.com/mskatoni/nodeseek-sou/main/nodeseek-sou.user.js
```

## 主要功能

- 多页拉取：在当前 NodeSeek 列表页基础上，继续读取后续 `X` 页帖子。
- 浏览量排序：把当前页和后续页收集到的帖子按浏览量从高到低排列。
- 评论数排序：把帖子按评论数从高到低排列。
- 时间过滤：只显示最近 `X` 天内发布的帖子。
- 用户名过滤：只显示指定用户发布的帖子，支持多个用户名，用空格、英文逗号或中文逗号分隔。
- 作者等级过滤：可隐藏等级 `<= X` 或 `>= X` 的作者帖子；识别不到等级的帖子默认保留，避免误删。
- 保留原站样式：筛选和排序后尽量保留 NodeSeek 原有帖子卡片、头像、徽章和排版。
- 一键恢复：可恢复当前页原始帖子列表。

## 批量屏蔽

脚本面板下方有一个可折叠的“批量屏蔽”区域，适合处理标题高度重复、批量发帖的账号。

- 先运行上方筛选/排序，再使用批量屏蔽；它只处理当前已经筛选出来的结果。
- 标题关键词支持英文逗号、中文逗号、分号、竖线或换行分隔，例如：

```text
中转站,注册送,企业级,team,plus,公益
```

- “命中帖数>”使用严格大于逻辑：填写 `2` 时，只会候选命中标题帖子数为 `3` 或更多的作者。
- “预览账号”只做本地统计，不会请求屏蔽接口。
- “执行屏蔽”会先弹窗确认，再按设置的间隔逐个屏蔽。
- 屏蔽请求默认串行执行，间隔 2 秒；遇到 `401/403/429/503` 会停止本轮，避免继续请求。

## 性能和缓存

- 每页请求前默认等待 5 秒，降低触发访问限制的概率。
- 后续页结果会写入 IndexedDB 缓存，短时间内重复查询可减少等待和网络请求。
- 过滤和排序优先交给 Web Worker 处理，页面不支持 Worker 时自动回退主线程。
- Worker 只处理排序和过滤所需的紧凑字段，不传原帖 HTML，减少跨线程复制。
- 移动端建议从 5-10 页开始试，确认浏览器不卡顿后再增加页数。

## 使用建议

1. 在 NodeSeek 首页、分类页、搜索页或分页列表打开脚本面板。
2. 填写“后续页数”，按需要设置天数、用户名或作者等级过滤。
3. 点击“浏览量排序”或“评论数排序”。
4. 如需批量屏蔽，展开下方“批量屏蔽”，输入标题关键词和命中帖数阈值。
5. 先点“预览账号”，确认候选账号无误后再执行屏蔽。

## 注意事项

- 脚本只在浏览器本地处理列表数据，不会把结果发送到第三方服务。
- 屏蔽账号会调用 NodeSeek 站内接口，请谨慎预览后再执行。
- 如果页面提示失败、出现 `429` 或 `503`，建议降低页数、延长间隔，稍后再试。
- 作者等级来自页面 DOM 或 NodeSeek 账户信息接口，站点结构变化时可能需要更新识别规则。

## 致谢

感谢 NodeSeek 社区提供讨论和使用场景：

- [NodeSeek](https://www.nodeseek.com/)

也感谢这些公开脚本提供的思路和参考：

- [NodeSeek X](https://greasyfork.org/en/scripts/479426-nodeseek-x/code)
- [NodeSeek Enhance](https://greasyfork.org/en/scripts/555408-nodeseek-enhance/code)
- [NodeSeek <-> DeepFlood 联合访问](https://greasyfork.org/en/scripts/550955-nodeseek-deepflood-%E8%81%94%E5%90%88%E8%AE%BF%E9%97%AE/code)

## 许可

[AGPL-3.0-only](./LICENSE)
