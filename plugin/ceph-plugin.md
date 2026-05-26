# Ceph 存储插件

Ceph 插件位于 `plugin/ceph/` 模块，同时实现主存储（PrimaryStorage）和备份存储（BackupStorage）两种角色，是 ZStack 中最复杂的存储插件。

## 核心类关系

```
CephPrimaryStorageBase (6197行)          — 主存储核心实现
CephPrimaryStorageFactory (1418行)       — 主存储工厂 + 脑裂防护
CephBackupStorageBase (2056行)           — 备份存储实现
CephBackupStorageFactory (162行)         — 备份存储工厂
CephKvmExtension (238行)                 — KVM 集成（secret + RBD 挂载）
CephPrimaryStorageMonBase (547行)        — Monitor 节点管理
CephGlobalConfig (55行)                  — 全局配置
CephSystemTags (52行)                    — 系统标签
CephConstants (36行)                     — 常量
```

包结构：`org.zstack.storage.ceph.primary`、`org.zstack.storage.ceph.backup` 和 `org.zstack.storage.ceph`（CephGlobalConfig、CephSystemTags、CephConstants 位于此父包）

## CephPrimaryStorageBase — 主存储核心

### 实现的扩展点

```
PrimaryStorageBase, KVMHostConnectExtensionPoint,
HostReconnectExtensionPoint, HostDeleteExtensionPoint,
KvmSetupSelfFencerExtensionPoint, ...
```

### connect() — 连接流程

FlowChain 发送 `InitCmd`，包含 3 个池（ImageCache/Root/Data）+ nocephx 标志：

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/CephPrimaryStorageBase.java
// connect() 流程：
// 1. 发送 InitCmd 到 ceph agent（包含 poolNames、monUrls、userKey）
// 2. 保存 fsid/userKey
// 3. 更新容量
// 4. 创建 manufacturer 系统标签
```

### pingHook() — 心跳检测

Ping 所有 mon 节点（并行），策略：
- 一个 mon 成功 = 主存储 Up
- 一个 mon 报告 `UnableToCreateFile` = 主存储 Down
- 断连的 mon 自动重连（带延迟）

### attachHook() — 挂载到 KVM 集群

对 KVM 集群中的所有主机：
1. 创建 Ceph secret（存储 ceph userKey 到 libvirt secret XML）
2. 创建 PrimaryStorageHostRef 记录

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/CephKvmExtension.java
// CephKvmExtension 在主机连接时：
// 1. 调用 ceph agent 的 CreateSecretCmd 创建 libvirt secret
// 2. 将 ceph userKey 注入 secret，使 VM 可通过 RBD 访问 Ceph
```

### 卷操作

**createVolume**：发送 `CreateVolumeCmd`，指定 poolName 和 size。

**deleteVolume**：发送 `DeleteVolumeCmd`。失败时标记 `OPERATION_FAILURE_GC_ELIGIBLE`，由 GC 后续清理。

**attachVolume / detachVolume**：构建 RBD 路径（`rbd:{poolName}/{volumePath}`），通过 KVMHost 挂载/卸载。

### 快照操作

**takeSnapshot**：发送 `CreateSnapshotCmd`，路径格式 `{volumePath}@{snapshotUuid}`，返回 Ceph 内部快照。

**mergeSnapshot**：返回空 reply——Ceph 使用内部快照，无需合并。

**revertVolume**：两种模式：
- 普通：`RollbackSnapshotCmd`
- 快速回滚：`cloneAndProtectSnaphost` + 新 volume path

**createVolumeFromSnapshot**：
- 快速模式：`cloneAndProtectSnaphost`
- 普通模式：`CpCmd`（深拷贝）

### Self-Fencer 机制

Ceph 的 Self-Fencer 是关键的高可用机制：

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/CephPrimaryStorageBase.java
// 发送 KvmSetupSelfFencerCmd 到 KVM 主机
// 参数：poolNames（仅 Root 类型）、monUrls、userKey、manufacturer
// kvmagent 监控 Ceph 连接，断连时触发 fencer 回调
```

当 kvmagent 检测到 Ceph 主存储不可达时，通过 Self-Fencer 机制通知管理节点，管理节点可触发 VM 迁移或主机重连。

### 容量管理

Ceph 容量通过 `CephPrimaryCapacityUpdater` 计算，支持多种厂商的容量更新策略：

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/capacity/
OpenSourceCephPrimaryCapacityUpdater    // 开源 Ceph
EnterpriseCephPrimaryCapacityBaseUpdater // 企业版
SandStoneCephPrimaryCapacityBaseUpdater  // SandStone
XSKYCephPrimaryCapacityBaseUpdater       // XSKY
ZStoneCephPrimaryCapacityBaseUpdater     // ZStone
```

容量数据存储在 `CephCapacityVO` 中，按 fsid 跟踪。

### Pool 管理

Ceph 支持多 Pool，通过 `CephPrimaryStoragePoolVO` 管理：

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/CephPrimaryStoragePoolVO.java
// Pool 类型：ImageCache、Root、Data
// 每个 Pool 有独立的容量和 OSD 组
```

Pool 分配策略：`getPoolName()` 先尝试默认 Pool，容量不足时回退到同类型的其他 Pool。

### Ceph-to-Ceph 迁移

`MonMigrateIpInfo` 解析迁移网络 CIDR，选择最优数据传输路径。

## CephPrimaryStorageFactory — 脑裂防护

### preInstantiateVmResource — 脑裂防护

这是 Ceph 插件最关键的安全机制之一：

```java
// plugin/ceph/src/main/java/org/zstack/storage/ceph/primary/CephPrimaryStorageFactory.java
// 在 VM 启动前检查 rbd image 的 watchers
// 如果有其他主机持有 watcher，说明可能存在脑裂
// 阻止 VM 启动，防止数据损坏
```

### OSD 组容量预留

```java
// CephOsdGroupCapacityHelper.reserveAvailableCapacity()
// CephOsdGroupCapacityHelper.releaseAvailableCapacity()
// 支持按 OSD 组进行容量预留和释放
```

## CephBackupStorageBase — 备份存储

### connect() 流程

```
1. 检查 fsid
2. 检查/创建 pool
3. 初始化 agent
4. dump metadata（用于重连场景）
```

### exportImage — 镜像导出

创建 export token on mon → 构建 HTTP URL with token 供外部下载。

### deleteHook — 删除清理

清理 `CephCapacityVO`，但仅在该 fsid 没有主存储共享时才删除。

## CephGlobalConfig — 关键配置

| 配置 | 说明 |
|------|------|
| PRIMARY_STORAGE_DELETE_POOL | 删除主存储时是否删除 Ceph pool |
| nocephx | 是否禁用 Ceph 认证 |
| 容量同步间隔 | 容量更新周期 |

## CephSystemTags — 系统标签

| 标签 | 用途 |
|------|------|
| manufacturer | Ceph 厂商标识 |
| fsid | Ceph Cluster FSID |
| pool type | Pool 类型标记 |

## 核心设计模式

| 模式 | 应用 |
|------|------|
| **RBD 原生快照** | Ceph 快照无需合并，直接使用内部快照 |
| **Self-Fencer** | kvmagent 监控 Ceph 连接，断连触发自愈 |
| **脑裂防护** | preInstantiateVmResource 检查 rbd watchers |
| **多 Pool 分配** | 默认 Pool + 回退策略 |
| **GC 清理** | 删除失败标记 GC_ELIGIBLE |
| **厂商扩展** | CapacityUpdater 按厂商分发 |
| **Ceph-to-Ceph 迁移** | 优化迁移网络路径 |
