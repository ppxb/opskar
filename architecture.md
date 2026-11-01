# Ops Bot 架构设计

> 状态：草案 v0.2 · 2026-11-01
> 范围：约 100 台异构服务器（无 K8s），逐步收敛到 Docker 部署
> 定位：自研骨架 + 取材 rakazo / DS-Bot 的成熟实现，做自己的运维 Bot（非 fork，非黑盒集成）

---

## 1. 目标与非目标

### 1.1 目标

1. 通过 Web 或 Webhook 触发一个常驻 Bot，对服务器集群执行巡检。
2. 巡检覆盖：主机状态、Web 应用、数据库、中间件。
3. Bot 能操作浏览器对 Web 应用做复现、验证，并据此修改代码。
4. 代码托管在自建 Gitea；Bot 能提交、开 PR、自审、合并。
5. 变更经 CI 验证后集中部署，失败可自动回滚。

### 1.2 非目标（本期明确不做）

- 不上 Kubernetes。
- 不自研 CMDB 界面（YAML + Git 即 CMDB）。
- 不自研告警平台（用 Prometheus + Alertmanager）。
- 不自研采集探针（用官方 exporter + textfile collector）。
- 不自研 Agent 内核、调度器、审批流（取材 rakazo 的实现，见第 2 节）。
- 不做多租户、不做计费、不做对外 SaaS。
- 不让 LLM 直接执行变更命令（只允许调用受控的 playbook 与 API）。

---

## 2. 取材来源与边界

### 2.1 关系定位

本项目**不是 fork，也不是黑盒集成**，而是"自研骨架 + 取材实现"：

- 自建仓库、自建 CI、自己维护主干，代码归我们所有。
- 从 rakazo / DS-Bot 源码中**抄取边界清晰的实现**（会话循环、上下文压缩、沙箱适配、routine 调度、审批状态机）。
- 上游后续更新只作**参考**：定期读 CHANGELOG、对限定路径跑 `git log`，人工评估是否搬运。

好处：拿到经过多次迭代的成熟实现，又不受上游架构与发布节奏约束。
代价：抄来的代码没有测试覆盖，必须自己补；上游的修复不会自动到手。

### 2.2 能力归属

| 能力 | rakazo | DS-Bot | 本项目 |
|---|---|---|---|
| Bot 会话 / 记忆 / 多轮上下文 | ✅ 主取材源 | ✅ | 抄 A 类 + 自研存储 |
| 定时 / 间隔 / 变更监测触发 | ✅ Routine | ✅ 定时任务 | 抄调度，自研检查集 |
| 外部 Webhook 触发 | ✅ URL + key | ❌ 无 | 抄验签，自研路由 |
| 审批（高危操作人工确认） | ✅ Approvals | ✅ 权限 | 抄状态机 |
| 审计日志 | ✅ 可外发 | ✅ | 自研（对接现有日志） |
| 沙箱计算机（跑源码、开浏览器） | ✅ Computer | ✅ 容器即沙箱 | 抄 docker 适配层 |
| 多 Bot 分工协作（群聊 / @ 接力） | 部分 | ✅ 强项 | Stage 4 参考 DS-Bot 思路 |
| 资产清单 / 巡检规则 / 报告 | ❌ | ❌ | 全自研 |
| 指标采集与查询 | ❌ | ❌ | 全自研（配置为主） |
| Gitea 变更通道 | ❌ | ❌ | 全自研 |
| CI 门禁 / 灰度 / 回滚 | ❌ | ❌ | 全自研 |

### 2.3 取材分级（抄什么、怎么抄）

| 级别 | 判断标准 | 做法 | 典型对象 |
|---|---|---|---|
| **A 整块抄** | 单文件或单目录，内部依赖 ≤ 3 个模块 | 复制 → 改包名 → 补测试 → 文件头写 provenance | 上下文压缩策略、工具循环错误恢复、docker 沙箱适配、cron 解析、webhook 验签、审批状态机 |
| **B 抄思路重写** | 与 Prisma schema / oRPC 契约 / auth 深度耦合 | 只读设计，自己实现接口 | 会话与记忆存储、权限模型、API 契约层 |
| **C 不抄** | 与本项目无关 | 直接跳过 | Stripe 计费、Expo 移动端、Electron 桌面、官网、i18n |

**判断口诀**：打开那个文件，数它的 `import`。超过 5 个内部模块 → 归 B 类，别抄，抄了就是拖家带口。

> 现实提醒：**agent 主循环在 rakazo 里与会话存储、oRPC 契约深度耦合，实际多半归 B 类**。A 类能整块拿走的是它内部的子策略——上下文压缩、工具调用重试、错误分类、docker 沙箱适配、cron 解析、webhook 验签。主循环建议按 B 类自己写（约 300–500 行），反而比拆解别人的更快。

### 2.4 取材纪律（不遵守三个月后必然失控）

1. **provenance**：每块抄来的代码，文件头写 `// source: rakazo@<commit-sha> path/to/file`，并登记到 `docs/provenance.md`。
2. **补测试**：抄一块补一个最小测试，否则你无法证明抄对了，也没法在上游修复时判断是否已受影响。
3. **去耦合**：改包名、改路径、删掉用不到的分支，不留原样。留原样 = 永远分不清哪块是自己的。
4. **许可证**：rakazo 与 DS-Bot 均为 Apache 2.0，保留 LICENSE 与 NOTICE，并声明修改。
5. **单一事实源**：`docs/provenance.md` 是唯一清单，"抄了但没登记"的代码一律视为技术债。

> 注：rakazo README 中的"计算机集群管理"指的是它自己创建的 Bot/Computer fleet，与生产服务器集群无关，不要混用。

---

## 3. 总体架构

```
[你] 浏览器 / 手机 / 群消息 / Gitea 事件 / 告警回调
   │
   ▼
┌──────────────────────────────────────────────────────────┐
│ ops-bot（mgmt-01，agent 取材自 rakazo）                    │
│  · Bot 会话：决策、解读、写报告（唯一使用 LLM 的层）        │
│  · Routine：cron │ webhook(URL+key) │ 变更监测             │
│  · Approvals：高危操作人工确认                              │
│  · Audit log：全量留痕                                     │
└──────┬───────────────┬───────────────┬───────────────────┘
       │               │               │
       ▼               ▼               ▼
┌────────────┐  ┌────────────┐  ┌────────────────┐
│ 沙箱计算机  │  │ Ansible    │  │ Prometheus API │
│ (Docker    │  │ 只读采集    │  │ PromQL 即时查询 │
│  容器)     │  │ 并发 ≤ 20  │  │ 15s 采样        │
│ clone→跑测 │  └─────┬──────┘  └───────┬────────┘
└─────┬──────┘        │                 │
      │               └────────┬────────┘
      │                        ▼
      │             ┌────────────────────────┐
      │             │ 巡检库 Postgres         │
      │             │ 证据 MinIO(S3)          │
      │             └───────────┬────────────┘
      ▼                         ▼
┌────────────┐         ┌──────────────────┐
│ Gitea + CI │◀──PR────│ 报告页 / 告警通知  │
│ act_runner │         └──────────────────┘
└─────┬──────┘
      ▼
  Harbor/Registry → 灰度 1 台 → 健康检查 → 全量
```

### 3.1 分层职责

| 层 | 组件 | 职责 | 是否允许 LLM 决策 |
|---|---|---|---|
| 触发层 | ops-bot Routine / Gitea webhook / Alertmanager | 决定"什么时候跑" | 否 |
| 决策层 | ops-bot agent（A 类取材） | 选检查集、解读结果、决定是否开 PR、写报告 | 是 |
| 执行层 | Ansible / runner / Playwright / CI | 确定性执行 | 否 |
| 数据层 | Postgres / MinIO / Prometheus | 存储与查询 | 否 |
| 通道层 | Gitea / 通知 / 审批 | 变更与告知 | 否 |

**铁律：LLM 不直接执行 shell 与文件变更，只做判断并调用受控接口。** 巡检与部署一律由 Ansible / runner / CI 执行；Gitea 写操作（建分支、提交、开 PR、合并）只经受控 API 客户端完成，并受第 10 节门禁矩阵约束。参数由 Bot 填，动作由代码做。

---

## 4. 三条数据流

### 4.1 巡检流

```
08:00 ops-bot Routine 定时触发
  → Bot 读 inventory，按 role 分批
  → ① PromQL 批量查询（1 次 HTTP，覆盖全部指标类检查）
  → ② 仅异常机器进入 SSH 取证队列
  → runner 归一化 → 写 Postgres + 证据入 MinIO
  → Bot 解读：硬阈值 / 同 role 偏离 / 7 日趋势
  → 输出：群摘要 + 报告页 + 异常项自动开 Gitea Issue
```

### 4.2 变更流

```
Gitea push / PR webhook
  → ops-bot Routine(webhook) 启动
  → Bot 在沙箱：clone → 装依赖 → 起服务 → Playwright 冒烟
  → 通过则推 PR；CI 跑单测 + 镜像级验证
  → 门禁矩阵校验 diff 边界
  → Bot 自审 + 合并（仅限允许范围）
  → CI 构建 → 灰度 1 台 → 健康检查 5 分钟 → 全量
  → 失败：自动 git revert + 回滚部署 + 群内说明
```

### 4.3 测试流（"源码在 Docker 里跑通再集中部署"）

```
内环（沙箱，秒级反馈）：进程方式跑源码 + Playwright，失败存 trace
外环（CI，镜像级）：build 镜像 → compose 起全栈 → 同一套 Playwright
两环用同一份用例，保证结论一致
```

> 技术约束（**待实测假设**）：沙箱本身是容器，预期无法运行 Docker（DinD 需特权，不采用）。因此"镜像级验证"放在 act_runner（有 Docker 权限）里完成，沙箱只做进程级快速验证。Stage 2 首日实测确认；若沙箱支持 rootless buildah，则内环可升级为镜像级验证。

---

## 5. 技术栈约定

| 领域 | 选型 | 版本基线 | 理由 |
|---|---|---|---|
| Bot 平台 | 自研 `ops-bot`（骨架自建，内核 A 类取材 rakazo） | Node 22 / pnpm 9 | 与取材代码同栈，胶水成本最低 |
| 多 Bot 协作 | 参考 DS-Bot 的群聊/接力设计（不部署） | — | Stage 4 自研 |
| 配置管理 | Ansible | 2.17+ | 无 agent、SSH 直连、幂等 |
| 指标 | Prometheus + 官方 exporters | 2.5x | 单实例足够 100 台 |
| 可视化 | Grafana | 11.x | 现成看板 |
| 日志 | Loki + Promtail（可选） | 3.x | 取证辅助，Stage 4 引入 |
| 巡检库 | PostgreSQL | 16 | 结构化查询 + 趋势 |
| 证据存储 | MinIO（S3 兼容） | 最新稳定 | trace/截图/日志包 |
| 代码托管 | Gitea | 1.22+ | 自建 |
| CI | Gitea Actions + act_runner | 最新稳定 | 与 Gitea 同源，无需额外系统 |
| 制品 | Gitea Packages（MVP）→ Harbor（规模化） | — | 先少一个组件 |
| 浏览器自动化 | Playwright（Node）+ Chromium | 1.4x | 与前端栈一致 |
| 报告渲染 | TS 模板（eta / 模板字符串） | — | 与主栈一致，不引入第二语言 |
| 反向代理 | Caddy | 2.x | 自动 TLS |
| 密钥 | Infisical | — | 不落盘、不进记忆；集成方式参考 rakazo |
| 通知 | 飞书 / 钉钉 Webhook | — | 自研适配，参考 rakazo 渠道实现 |

**语言边界：全栈 TypeScript。** Ansible 只作为外部命令调用（`child_process` 跑 `ansible-playbook`），不写 Python 胶水；CI 与 Playwright 同栈。理由：取材代码是 TS，混语言会让"抄过来就能跑"变成"抄过来还要移植"。

---

## 6. 目录结构

### 6.1 代码仓库 `ops-bot`（自研主干）

```
ops-bot/
├── README.md
├── architecture.md              # 本文档
├── package.json                 # pnpm workspace
├── apps/
│   ├── api/                     # Hono + oRPC：会话、routine、审批、webhook 入口
│   ├── web/                     # 前端：会话、报告页、审批卡片
│   ├── worker/                  # 队列与定时
│   └── cli/                     # ★ 独立 CLI：不起 api/web 也能跑巡检
├── packages/
│   ├── agent/                   # A 类取材：会话循环、上下文压缩、工具调度
│   ├── sandbox/                 # A 类取材：docker 沙箱适配（只留 docker）
│   ├── routine/                 # A 类取材：cron 解析、触发器、webhook 验签
│   ├── approvals/               # A 类取材：审批状态机
│   ├── ops-checks/              # 自研：检查项 DSL + 执行器
│   ├── ops-report/              # 自研：报告渲染
│   └── ops-git/                 # 自研：Gitea API 封装
├── inventory/
│   ├── hosts.yaml               # 主机清单（唯一事实源）
│   └── groups.yaml              # role 分组、批次
├── checks/                      # os/ web/ db/ mw/ 四类检查项
├── playbooks/                   # inspect.yml / collect-evidence.yml / deploy.yml
├── probes/
│   ├── prometheus/              # 抓取配置（file_sd 生成）+ rules/
│   ├── blackbox/blackbox.yml    # HTTP/TCP/TLS 探针
│   └── textfile/check-extra.sh  # 证书/备份/配置漂移
├── .gitea/workflows/            # ci.yml / deploy.yml / guard.yml
├── ci/templates/                # 各服务复用的 workflow 模板
├── docs/
│   ├── provenance.md            # ★ 取材清单：来源、commit、许可证、修改说明
│   ├── runbook.md               # 故障处置手册
│   ├── permissions.md           # 账号与权限矩阵
│   └── adr/                     # 架构决策记录
└── scripts/
    ├── bootstrap-gitea.sh
    ├── install-probe.sh
    └── gen-file-sd.ts           # inventory → Prometheus file_sd targets
```

**`apps/cli` 是硬要求**：巡检能力必须能脱离 api/web 独立执行（`pnpm ops inspect --host web-01`）。这样取材来的那半边出问题时，业务还能跑。

### 6.2 部署目录 `mgmt-01`

```
/srv/ops/
├── ops-bot/         # 自研服务：api + web + worker + Postgres
├── gitea/
├── prometheus/
├── grafana/
├── minio/
└── runner/          # ops-bot 的只读检出，用于 cron 巡检
```

---

## 7. 接口与数据契约

### 7.1 主机清单 `inventory/hosts.yaml`

```yaml
web-01:
  ip: 10.0.1.11
  role: web
  stack: nginx+php-fpm        # Docker 化后改为 image:tag
  repo: gitea.local/team/shop-web
  health: http://10.0.1.11/healthz
  checks: [os, disk, cert, nginx, php]
  wave: 1                      # 迁移批次
  owner: team-shop

db-01:
  ip: 10.0.2.11
  role: mysql
  stack: mysql-8.0
  checks: [os, disk, mysql.repl, mysql.slowlog, mysql.conn]
  wave: 2
  owner: team-data
```

### 7.2 检查项 DSL `checks/_schema.yaml`

```yaml
id: disk.root
title: 根分区使用率
applies_to: [os]
source: promql | ssh | textfile
run: |                       # source=ssh 时必填
  df -P / | awk 'NR==2{print $5}' | tr -d '%'
query: |                     # source=promql 时必填
  100 - node_filesystem_avail_bytes{mountpoint="/"}
      / node_filesystem_size_bytes{mountpoint="/"} * 100
assert: {lt: 85}
severity: {warn: 80, crit: 90}
unit: percent
cooldown: 30m                # 同类告警抑制窗口
```

**阈值分层**（避免在样本不足时引入高误报规则）：

| 层 | 引入阶段 | 说明 |
|---|---|---|
| 硬阈值 | MVP | 磁盘 90%、证书 7 天、端口不通 |
| 纵向趋势 | MVP | 自身 7 日斜率（如磁盘每天涨 2% 即告警） |
| 横向偏离 | Stage 4 | 同 role 中位数 3σ；50 台样本下误报率过高，提前引入会淹没真告警 |

### 7.3 巡检结果 `report.json`

```json
{
  "run_id": "2026-11-01T08:00:00Z-7f3a",
  "trigger": "schedule",
  "started_at": "2026-11-01T08:00:00Z",
  "finished_at": "2026-11-01T08:03:41Z",
  "hosts_total": 100,
  "hosts_ok": 94,
  "findings": [
    {
      "host": "web-03",
      "check_id": "disk.root",
      "severity": "warn",
      "value": 84.2,
      "threshold": 80,
      "evidence": "s3://ops-evidence/2026-11-01/web-03/disk.txt",
      "trend_7d": "+1.8%/day"
    }
  ]
}
```

### 7.4 Webhook 契约（Gitea → ops-bot Routine）

```
POST https://ops.example.com/hooks/gitea?key=<routine-key>
Content-Type: application/json

{"event":"push","repo":"team/shop-web","ref":"refs/heads/main",
 "sha":"a1b2c3d","actor":"dev01","compare":"https://gitea.local/.../compare"}
```

约定：
- 一个事件类型一个 routine、一个 URL（沿用"一 routine 一 URL"的粒度）。
- 路由分流在 Gitea 侧配置（按 repo / 分支 / 事件类型挂不同 webhook）。
- 幂等键 = `repo + sha + event`，重复投递直接丢弃。

### 7.5 巡检库表（4 张）

```sql
hosts    (id, ip, role, stack, repo, health_url, wave, owner, updated_at)
runs     (id, trigger, started_at, finished_at, hosts_total, hosts_ok, status)
findings (id, run_id, host_id, check_id, severity, value, threshold, evidence_uri, created_at)
checks   (id, title, source, applies_to, assert_json, severity_json, version)
```

---

## 8. 实时性策略

"实时"拆成四件事，分别设计，全部无需自研探针。

| 场景 | 延迟目标 | 实现 | 关键参数 |
|---|---|---|---|
| 看板 | 15–60s | Prometheus pull | `scrape_interval: 15s` |
| 告警 | 15–60s | Alertmanager | `evaluation_interval: 15s` |
| 对话式查询 | 1–3s | PromQL instant query | 滞后 ≤ 15s |
| 故障通知 | 5–15s | Alertmanager → webhook → Routine | 事件驱动 |
| 现场取证 | 触发后 5s | Bot → SSH / Loki | 按需 |

**容量估算**：100 台 × 约 1200 series ≈ 12 万 series；15s 采样约 1–2 GB/天；单实例 Prometheus + 30 天保留足够。cadvisor 必须做 label 收敛（砍掉镜像全名、容器 ID 等高基数字段）。

**分工铁律**：指标类走 Prometheus，证据类走 SSH。此分工可省掉约 70% 的 SSH 调用。

**自监控（MVP 必做）**：exporter 挂掉时巡检会静默变成"全绿"，这是最危险的失败模式。必须补一组最小规则，放在 `probes/prometheus/rules/self.yml`：

- `up == 0` 持续 2 分钟 → 该 target 直接计入 findings，severity=crit
- 抓取超时（`scrape_duration_seconds > 5`）
- Prometheus 自身容量：`prometheus_tsdb_storage_blocks_bytes` 超阈值
- Alertmanager watchdog：`vector(1)` 心跳缺失，说明告警链路已断

---

## 9. 权限与安全模型

### 9.1 双身份

| 身份 | 持有者 | 权限 | 用途 |
|---|---|---|---|
| `opsbot-ro` | Bot（LLM 可调） | 只读命令白名单 | 巡检、取证 |
| `opsbot-deploy` | 仅 CI | 部署脚本、服务重启 | 发布、回滚 |

Bot 永远不持有 `opsbot-deploy` 的私钥。

### 9.2 SSH 收紧

```
# authorized_keys：强制命令 + 限制
restrict,command="/usr/local/bin/ops-guard" ssh-ed25519 AAAA... opsbot-ro

# sudoers：逐条枚举子命令，禁止通配符
opsbot-ro ALL=(root) NOPASSWD: /usr/bin/systemctl status nginx, \
                              /usr/bin/systemctl status mysqld, \
                              /usr/bin/journalctl -u nginx -n 200, \
                              /usr/bin/ss -s, /usr/bin/ss -tlnp, \
                              /bin/df -P, /usr/bin/docker ps
```

**通配符即漏洞**：`ss -K` 会强制断开连接、`journalctl --vacuum-*` 会删日志、`systemctl *` 可起停任意服务——这些在 sudo 下全部生效。`-*` 必须逐条枚举，宁可多写十行。

进阶方案（推荐）：SSH CA 短期证书（step-ca / Teleport），证书 15 分钟过期，Bot 拿不到长期私钥。

### 9.3 Docker 权限陷阱

加入 `docker` 组等价于 root（可 `docker run -v /:/host`）。**`opsbot-ro` 禁止加入 docker 组**。读容器状态用只读 socket 代理：

```
CONTAINERS=1 IMAGES=1 INFO=1 VERSION=1 POST=0 EXEC=0 ALLOW_START=0 ALLOW_STOP=0
```

### 9.4 网络

- 管理网（mgmt-01/02/03）与生产网段隔离，仅允许出站到被管机的 22 / 9100 / 只读 proxy 端口。
- 沙箱容器允许访问内网测试依赖，**禁止访问生产网段**。
- 密钥只引用环境变量名（`GITEA_TOKEN`、`SSH_CA_KEY`、`MINIO_ACCESS_KEY`），不写入仓库、不写入 Bot 记忆。

---

## 10. CI/CD 与门禁

### 10.1 自动合并门禁矩阵

| 变更类型 | 自动合并 | 附加条件 |
|---|---|---|
| 配置值调整（非密钥） | ✅ | CI 全绿 + 部署后健康检查通过 |
| 业务 bugfix | ✅ | 单测 + Playwright 回归全过 |
| 依赖 patch 升级 | ✅ | 锁文件 diff < 200 行 |
| 依赖 major / 新增依赖 | ❌ | 人审 |
| CI 配置、部署脚本、密钥、DB 迁移 | ❌ | 人审 + 双人 |
| 改动 > 500 行 或 跨 > 3 个服务 | ❌ | 人审 |

### 10.2 三道保险

1. **合并前**：`guard.yml` 校验 diff 边界，越界直接拒绝。
2. **合并后**：灰度 1 台 → 健康检查 → 全量 → 观察。判定口径必须量化，否则"自动判成败"无从谈起：

   | 指标 | 通过线 | 对比基准 |
   |---|---|---|
   | HTTP 5xx 率 | < 0.5% | 灰度前 30 分钟同机基线 |
   | P95 延迟 | < 基线 × 1.5 | 同上 |
   | 健康检查 | 连续 10 次返回 200 | — |
   | 容器重启数 | 0 | — |

   灰度观察 5 分钟全过 → 全量；全量后观察 30 分钟。任一指标越线即触发 `git revert` + 回滚部署 + 群内说明。
3. **每周演练**：奇数周演练 revert，偶数周演练"从备份恢复"（见第 12 节）。

> 第 3 条不做，前两条只是纸面承诺。

### 10.3 提交规范

- 机器人提交一律英文 conventional commits：`fix(shop-web): guard against null cart id`。
- 提交者固定为 `opsbot <opsbot@gitea.local>`，便于审计与批量回滚。

---

## 11. MVP 与实现路线

**MVP 定义 = Stage 0 + 1 + 2（约 5 周）**：能巡检、能复现、能出报告。自动修复（Stage 3）不在 MVP 内。

| Stage | 周期 | 交付物 | 验收标准 |
|---|---|---|---|
| **0 竖切片** | 第 1 周 | 自研骨架（pnpm + Hono + Postgres）、A 类取材 3 块（cron 解析、webhook 验签、上下文压缩）、自写 agent 主循环、1 台样板机 + 3 个检查项 + 1 个 routine | 对 Bot 说"巡检 web-01"能跑完给结果；`pnpm ops inspect` 也能单独跑 |
| **1 规模与探针** | 第 2–3 周 | Gitea + act_runner、Prometheus + Grafana + 20→50 台探针、Ansible 批量、10 个检查项、报告页、每天 8:00 + 告警 + 自监控规则 | 50 台全量巡检 ≤ 5 分钟；报告可点进单机；**杀掉一个 exporter 能触发告警** |
| **2 沙箱闭环** | 第 4–5 周 | Playwright 10 条关键路径、沙箱内 clone→起服务→测试→trace 归档 | Bot 能对一个真实 bug 复现并给出证据 |
| **3 变更闭环** | 第 6–8 周 | Gitea API 封装、PR 模板、guard 门禁、自动合并、灰度部署、自动 revert + 演练 | 一个真实 bugfix 端到端自动完成 |
| **4 规模化** | 第 9 周起 | 100 台全覆盖、中间件检查包补齐、DS-Bot 值班团队、周报 | 误报率 < 5%；周报自动产出 |

### Stage 0 的五天（竖切片，每天可验收）

| 天 | 做什么 | 当天验收 |
|---|---|---|
| D1 | 骨架：pnpm workspace + Hono + Postgres + Prisma，`pnpm dev` 起得来 | 打开 Web 能看到空白会话页 |
| D2 | 自写 agent 主循环（约 300–500 行）：消息 → 工具调用 → 结果回填 | 能对话，能调用一个假工具 |
| D3 | A 类取材 3 块：cron 解析、webhook 验签、上下文压缩；登记 `docs/provenance.md` | routine 按 cron 触发；webhook 能用错误 key 被拒 |
| D4 | 1 台样板机：`opsbot-ro` + sudoers 逐条白名单 + 只读 docker proxy + 3 个检查项 | `pnpm ops inspect --host web-01` 出 Markdown |
| D5 | 串起来：routine → ops-checks → 结果回会话 → 发通知 | 对 Bot 说"巡检 web-01"，它跑完给结果 |

**止损点**：D2 结束如果 agent 主循环还跑不通，说明自研成本被低估——立刻退回"部署 rakazo 当黑盒"方案，业务层照旧走 CLI，不阻塞后续工作。

Ansible、Prometheus、Gitea 都不在 Stage 0 里：它们对"验证这条链路能不能用"零贡献，全部放到 Stage 1 横向铺开。

---

## 12. 备份与保留

自动合并的前提是"随时能回到昨天"，所以备份属于 P0，不是 P4。

| 对象 | 频率 | 方式 | 保留 | 恢复演练 |
|---|---|---|---|---|
| Gitea（仓库 + 库） | 每日 | `gitea dump` → 异地对象存储 | 30 天 | 每月 |
| 巡检库 Postgres | 每日 | `pg_dump -Fc` → 异地 | 30 天 | 每月 |
| MinIO 证据 | 实时 | 桶版本化 + 异地复制 | 30 天 | 不演练 |
| Prometheus TSDB | 每周 | 快照（非关键） | 2 份 | 不演练 |
| ops-bot 数据卷 | 每日 | 卷快照 | 14 天 | 每月 |

**保留规则**：`findings` 保留 180 天（趋势分析需要），证据文件 30 天（超期由 runner 定时清理，不手工删）。

**恢复演练**并入 10.2 的每周演练。只备份不演练，等于没有备份——这条和 revert 演练是同一个道理。

---

## 13. 风险与不做什么

| 风险 | 影响 | 缓解 |
|---|---|---|
| 取材代码无测试覆盖 | 抄来的实现带隐性 bug | 每块抄完补最小测试；provenance 记 commit，便于比对上游修复 |
| 上游修复不再自动到手 | 安全漏洞需自己跟进 | 季度读 CHANGELOG + 对 `docs/provenance.md` 中的路径跑 `git log <sha>..HEAD` |
| 自动合并误伤生产 | 线上故障 | 门禁矩阵 + 灰度 + 自动 revert + 每周演练 |
| 100 台异构导致检查项爆炸 | 维护成本失控 | Docker 化收敛；未容器化机器只跑 `os` 基础包 |
| 沙箱可能无法跑 Docker（待实测） | 镜像级验证缺口 | 内环进程级 + 外环 CI 镜像级，双环同用例 |
| LLM 被日志/网页内容注入 | 执行越权命令 | 执行层确定性化；LLM 无写权限；Approvals 兜底 |
| 凭据泄露 | 横向渗透 | 双身份 + 短期证书 + Infisical + 网络隔离 |

**不做什么**：不建 K8s、不自研 CMDB UI、不自研告警平台、不自研 DSL 编译器、不做多租户、不让 LLM 直接执行变更。

---

## 14. 附录

### 14.1 安装命令（需人工确认后执行）

```bash
# Gitea + runner
docker run -d --name gitea -p 3000:3000 -p 222:22 \
  -v /srv/ops/gitea:/data --restart always gitea/gitea:1.22
docker run -d --name act_runner --restart always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/ops/act_runner:/data gitea/act_runner:latest

# 只读 docker proxy（被管机）
docker run -d --name docker-proxy -p 127.0.0.1:2375:2375 \
  -e CONTAINERS=1 -e IMAGES=1 -e INFO=1 -e VERSION=1 \
  -e POST=0 -e EXEC=0 -e ALLOW_START=0 -e ALLOW_STOP=0 \
  -v /var/run/docker.sock:/var/run/docker.sock:ro \
  tecnativa/docker-socket-proxy

# 浏览器自动化
npm i -D @playwright/test && npx playwright install chromium
```

### 14.2 取材参考文档

- rakazo Routine / 触发器：`rakazo/docs/routines.md`
- rakazo 审批：`rakazo/docs/approvals.md`
- rakazo 审计日志：`rakazo/docs/self-host-audit-log.md`
- rakazo 密钥管理：`rakazo/docs/infisical-secrets.md`
- DS-Bot 安全模型：`DS-Bot/SECURITY_MODEL.md`
- DS-Bot 能力与权限：`DS-Bot/ds-bot/README.md`

### 14.3 待决事项

1. 管理节点：MVP 单机合体（16C/32G/1T），Stage 3 再拆三台。
2. 探针节奏：20 台试点 → 50 台 → 100 台，避免 label 命名返工。
3. 中间件清单：待补，补齐后按 `checks/mw/` 逐类增加检查包。
4. 是否引入 SSH CA（step-ca/Teleport）：建议 Stage 3 引入。
5. 沙箱能否跑 rootless buildah：Stage 2 首日实测，据此决定内环是进程级还是镜像级。
