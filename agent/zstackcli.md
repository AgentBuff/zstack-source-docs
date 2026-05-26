# CLI 工具

zstackcli 是 ZStack 的命令行管理工具，通过 HTTP 调用管理节点 API，提供交互式和脚本式两种使用模式。

## 入口与架构

```python
# zstack-utility/zstackcli/zstackcli/cli.py
class Cli(object):
    """交互式命令行工具"""
    # 通过 HTTP 调用管理节点 API（非直接连 Agent）
    # 支持 Tab 自动补全、命令历史、结果缓存
```

## 通信模型

```
zstackcli
    │
    │  HTTP POST (JSON)
    ▼
Management Node API Server
    │
    │  CloudBus
    ▼
各服务组件
```

- zstackcli **不直接连接 Agent**，而是通过管理节点的 REST API 间接操作
- 所有 API 调用通过 HTTP POST 发送，body 为 JSON 格式

## 登录方式

| 方式 | 说明 |
|------|------|
| Account | ZStack 本地账号登录 |
| LDAP | 对接 LDAP/AD 服务器 |
| IAM2 | 企业版 IAM2 身份管理 |
| CAS | CAS 单点登录 |

Session 管理存储在 `~/.zstack/cli/session`。

## 核心功能

### 交互式模式

```bash
$ zstackcli
zstack> LogInByAccount accountName=admin password=password
zstack> CreateVmInstance name=myvm instanceOfferingUuid=... imageUuid=... l3NetworkUuids=...
zstack> QueryVmInstance
zstack> LogOut
```

- 支持 Tab 自动补全（API 名称、参数名、资源 UUID）
- 命令历史（上下箭头）
- 结果缓存（避免重复查询）

### 脚本式模式

```bash
zstackcli LogInByAccount accountName=admin password=password
zstackcli CreateVmInstance name=myvm instanceOfferingUuid=... imageUuid=... l3NetworkUuids=...
```

### API 参数自动发现

```python
# zstackcli 使用 apibinding.inventory 自动发现 API 参数
# 管理节点启动时注册所有 API 定义
# CLI 连接后自动下载 API schema，用于参数校验和补全
```

## 命令格式

```
zstackcli <APIName> <param1>=<value1> <param2>=<value2> ...
```

所有 API 名称与 ZStack Java 代码中的 `@RestRequest` 注解定义的 API 一一对应。

## 输出格式

默认输出 JSON 格式，支持以下选项：
- `--fmt=table` — 表格格式
- `--fmt=xml` — XML 格式
- `--fields=field1,field2` — 选择输出字段
- `--filter=field=value` — 过滤结果

## 与管理节点的关系

zstackcli 是管理节点 API 的薄客户端：
1. 登录获取 SessionToken
2. 所有后续 API 调用携带 SessionToken
3. 管理节点验证 SessionToken 后执行操作
4. 返回结果由 CLI 格式化展示

zstackcli 不包含任何业务逻辑，所有逻辑在管理节点执行。
