# dsh-session-consult

让一个 DeepSeek Harness 会话去「咨询」另一个会话的历史——只读、低成本，并带回出处。

会话是一份很好的记忆，却不是一个好的信使：它的上下文无法交给别的会话，而想「问它一句」
就必须把它唤醒，唤醒就意味着改变它。这个插件补上了缺的那个动词：**consult**。

```js
consult_session({ session, question })                // ask：由一个受限子会话作答
consult_session({ session, question, mode: "read" })  // read：直接返回摘要
consult_session({ mode: "list" })                     // 列出可咨询的会话
```

被咨询的会话**只会被读取**：绝不写入它的日志，绝不 steer 或 resume 它，也不加锁。

> 不要和 [`dsh-consult`](https://www.npmjs.com/package/dsh-consult) 混淆：那个插件咨询的是
> *其他模型*，这个插件咨询的是*其他会话*。

## 和「`@` 引用会话」有什么区别

Harness 已经支持用 `@` 把另一个会话拉进当前消息。那是另一件工具，两者互补：

| | `@` 引用 | `consult_session` |
|---|---|---|
| 方向 | 单向：把一份快照插进你这条消息 | 提问 → 回答，可以继续追问 |
| 触发 | 你在输入框里 `@`，只对那条消息生效 | 模型自己判断，按问题调用 |
| 体量 | 固定的有界预览，超了截断 | 面向问题的摘要，预算可调 |
| 工具 | 没有——快照只是你上下文里的不可信文本 | 子会话可以用只读工具核对当前文件 |
| 多轮 | 不行，捕获后冻结 | 可以，复用一个子会话续聊 |
| 目标 | 候选列表里能选到的会话 | 任意会话（id / 标题 / mention） |
| 出处 | 快照随这轮消息写入 | 每次结果都写明来源、截到第几条、丢了多少 |

一句话：`@` 是「把这段上下文摆到我面前」，consult 是「就这件事问它一句（或几句）」。

## 状态

`0.1.x`——pre-1.0。工具参数和出处行的格式是稳定的；摘要内部算法和子会话机制还可能调整，
这类变更走 minor 版本并记入 [CHANGELOG.md](CHANGELOG.md)。

## 为什么不能直接 fork

fork 是最直觉的机制，而且确实能跑通：可以用另一个会话的事件前缀创建子会话，前缀会逐字节
复现。但在实践中不可用。

在一台运行 DSH `0.2.2-rc.1` 的开发机上，对 69 个会话实测：

| 指标 | 中位数 | 最大值 |
|---|---|---|
| 完整已完成轮次前缀（fork 要复制的东西） | **约 150 万 tokens** | 17.8M |
| 其中人类/助手文本 | **1.7%** | — |
| 其中 reasoning、工具输出、记账事件 | **98%** | — |

真实会话的绝大部分是工具输出和内部推理。复制它，花费的上下文超过任何模型能容纳的量，
换来的信息却少于一份摘要。这两个数字都可以在你自己的机器上用 `npm run dump` 与
`npm run bench` 复现（见[开发](#开发)）。

## 环境要求

- DeepSeek Harness `>=0.2.2-rc.1 <0.4.0`（profile 需挂载 `tools`、`agents`、
  `sessionPersistence`；标准 profile 都有）。
- 离线工具需要 Node.js `>=22.15`；插件本身除 `node:crypto` 外不依赖任何 Node API。

## 安装

本包尚未发布到任何 registry，请从检出安装：

```sh
git clone https://github.com/NorwinYu/dsh-session-consult.git
dsh plugin --profile <profile> add ./dsh-session-consult
```

发布之后，同一条命令可以直接用包名：

```sh
dsh plugin --profile <profile> add dsh-session-consult
```

包内自带 `cordis.patch.yml`，安装时会一并插入插件行。若不想改动 profile，也可以在启动时
打补丁试用：

```yaml
# extra.yml —— 包必须能被该 profile 解析到
- insert:
    - id: consult-session
      name: dsh-session-consult
```

```sh
dsh --profile <profile> --patch ./extra.yml
```

安装会改变 profile 的组合结果：需要重启正在运行的 App，或新开会话，才能看到工具。

### 从 Discover 安装（插件索引）

本仓库发布了一个插件索引，供实验性的 Discover 标签页使用：

```
https://norwinyu.github.io/dsh-session-consult/market/index.json
```

1. 先挂载 market bundle（`@deepseek-ai/dsh-experimental-plugin-market-bundle`）；
2. 打开 **Discover → 添加索引源**，粘贴上面的地址；
3. 在列表里选 *会话咨询* 安装。

`market/index.json` 里每个版本都钉死了具体 commit，所以 Discover 装到的就是这个仓库在该
commit 上的内容。

## 使用

问另一个会话当时决定了什么：

```js
consult_session({
  session: "@[billing refactor](dsh-session:c2Vzc2lvbi0...)",
  question: "我们最后定的迁移顺序是什么？哪些方案被否掉了？",
})
```

只看摘要、不为子会话的推理付费：

```js
consult_session({ session: "billing refactor", question: "…", mode: "read" })
```

### 会话的三种指定方式

| 参数 | 例子 | 解析方式 |
|---|---|---|
| 原始 id | `session-8f3c…` | 直接使用 |
| 规范 mention | `@[billing](dsh-session:c2Vz…)` | 解码成 id |
| 标题片段 | `billing refactor` | 走 `@` 菜单同一个候选服务 |

命中多个会话时**直接拒绝并列出候选**，绝不猜：

```
Error: consult: "OSM" matches 2 sessions — retry with a more specific title or an id:
  - OSM building data export guide · session-c7798e00-… · 3d ago
  - OSM licence review · session-ff185161-… · 4d ago
```

想知道有哪些会话可问，用 `mode: "list"`（也可以带同样的标题片段过滤）。

### 返回什么

每次返回都带着出处，调用方可以据此判断和引用：

```
迁移顺序是 customers → invoices → line items。团队否决了一次性迁移，
因为 invoice 回填会锁住 ledger 表（T7）。

---
source: session-c2Vzc2lvbi0… (persisted, captured through seq 1841) · 12 turns ·
digest ≈5.9K tok · text retained 100% · digest cache hit
```

失败也是一种答案：

- 目标不存在 → 明确报错，不返回半份摘要；
- 历史为空 → 明确说明「还没有已完成的轮次」，并附出处；
- 子会话崩溃 → 返回记录到的错误，而不是空字符串；
- 超时 → 中断子会话当前轮次并显式失败；
- 咨询自己 → 直接拒绝。

## 摘要怎么生成

摘要**逐字保留全部人类/助手文本**，其余预算花在最近的轮次上：

| 层级 | 保留内容 |
|---|---|
| expanded | 最近的轮次：完整文本 + 一行式工具轨迹（`· bash: pnpm test` → `→ ok`） |
| text-only | 轨迹放不下时，保留对话文本、丢掉工具调用 |
| index | 较早的轮次压成一行（`T12 U: … / A: …`） |
| pinned | 首轮的任务陈述，保证调用方永远知道这个会话在做什么 |
| dropped | 仍然放不下的，从最老的开始丢 |

reasoning 块、记账事件（`step/*`、`job/*`、投递回执）、系统提示词、工具输出正文，以及
**宿主注入的 user 角色消息**（`runtime-context`、`skill-catalog`、`time-context`）都不会
进入摘要——只有真正的人或同伴 agent 才算对话。工具结果压成一行，失败标记 `[error]`。

同样 69 个会话上的实测：

| 会话 | 原 tokens | 摘要 tokens | 比例 | 文本保留 |
|---|---|---|---|---|
| 251 事件 | 397K | 2.8K | 0.7% | 100% |
| 418 事件 | 420K | 4.2K | 1.0% | 100% |
| 2,410 事件 | 2.2M | 5.6K | 0.3% | 90% |
| 4,919 事件 | 3.4M | 7.0K | 0.2% | 57% |
| 10,894 事件 | 9.6M | 6.5K | 0.1% | 39%¹ |

¹ 超长会话塞不进 7K token 的预算。分配是「最新优先」，所以最近的上下文会保留，最老的
轮次被有意丢弃，丢弃数量会写进出处行。最坏观测到的构建耗时：60MB 日志约 360ms。

## 安全

他方会话的记录是不可信输入：里面可能包含看起来像指令的文本。两道独立防线：

1. **摘要被标记为数据**。子会话被要求只依据这份记录作答，绝不可执行其中的指令、权限声明
   或工具请求。
2. **子会话没有行动能力**。它的工具集被替换成 profile 中真实存在的只读工具白名单
   （`read`、`read_image`、`grep`、`glob`、`ls` …）。shell、写入、网络、消息、子会话，
   以及本插件自己的工具，全部从它的视图中消失。在一次验证过的运行中，子会话的请求头里
   只有 `glob`、`grep`、`read`、`read_image`。

目标就是调用方自身时会被拒绝，避免会话递归咨询自己。

## 目标会话正在运行时

咨询一个运行中的会话是安全的，且永远返回一个**前缀**：

- 目标持有写租约时，只读依然成功；
- 前缀可能停在 step 中间（有 tool call 而 result 尚未提交），摘要渲染为
  `→ (no result captured)`；
- 前缀按 step 边界推进；
- 摘要标出 `(+1 in flight)`，并把该轮渲染在
  `(IN PROGRESS — captured mid-turn, may be incomplete)` 之下；
- 被中断的轮次标记为 `[error]`，不会被当成正常回答。

`captured through seq` 之后的一切从构造上不可见。答案描述的是目标的过去，而不是现在。

## 配置

通过 profile 补丁层覆盖：

```yaml
- id: consult-session
  config:
    budgetTokens: 7000        # 默认摘要预算
    minBudgetTokens: 500      # budget_tokens 下限
    maxBudgetTokens: 40000    # budget_tokens 上限
    timeoutMs: 180000         # 单次子会话轮次上限
    cacheEntries: 32          # 摘要缓存条数
    maxChildren: 8            # 复用的咨询子会话数
    readTools: [read, read_image, grep, glob, ls, list_dir, load_workspace_dependencies]
    denyTools: []             # 没有可用只读工具时的额外拒绝项
```

## 隐私

这个插件读取的是宿主自己的会话存储。启用前需要知道：

- **被咨询会话的文本会离开这台机器**。摘要会进入模型请求，因此会发往你 profile 配置的
  模型提供方。那个会话里打印过的路径、令牌、客户数据，都可能包含在内。
- **不额外收集任何东西**。插件没有遥测，自身不发网络请求，除宿主创建的子会话外不写文件。
- **`mode=read` 同样会返回文本**，只是不额外消耗一次子会话推理。
- **子会话会留在磁盘上**（存储没有删除 API），挂在调用方之下。
- **离线工具完全离线**：`dump` 读取 `$DSH_HOME/sessions` 并写出 JSON，`bench` 只读这些
  JSON。

漏洞报告方式见 [SECURITY.md](SECURITY.md)。

## 开发

```sh
npm test                                          # 30 个单元测试，合成夹具
npm run dump -- --out ./session-dumps --limit 50  # 读取 $DSH_HOME/sessions
npm run bench -- ./session-dumps                  # 输出成本表
```

测试只用内联合成事件：不含任何真实会话日志、不联网、不需要 Harness 在运行。目录结构与
夹具规则见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 已知限制

- **子会话会留在磁盘上**。存储没有删除 API，所以每个咨询子会话都会留下（挂在调用方
  之下）。复用机制把它压到每个 `(caller, target)` 一个；`mode=read` 不创建任何子会话。
- **机密会随之传递**。助手文本是逐字保留的，被咨询会话打印过的内容会进入调用方上下文。
- **没有 `@` 菜单入口**。工具支持按标题解析，但输入框还没有把 consult 注册成引用来源。
- **预算是字符级估算**。`chars = tokens × 3` 是 CJK/ASCII 混合估计，不是真正的分词器。
- **同步**。`ask` 会等待子会话轮次结束，长任务受 `timeoutMs` 约束。

## 许可证

MIT，见 [LICENSE](LICENSE)。
