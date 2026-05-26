# KVM 虚拟化插件

KVM 插件是 ZStack 管理节点与 KVM 计算节点之间的桥梁，位于 `plugin/kvm/` 模块。管理节点通过 **HTTP 异步调用** 与计算节点上的 kvmagent 通信，kvmagent 也可通过 **同步 HTTP 回调** 向管理节点报告事件。

## 核心类关系

```
KVMHost (extends HostBase, 6982行)       — 单台 KVM 主机的完整生命周期管理
KVMHostFactory (1194行)                   — 工厂 + 回调注册中心
KVMAgentCommands (5150行)                 — 所有命令/响应 DTO
KVMExtensionEmitter (441行)               — 观察者模式扩展点发射器
KVMGlobalConfig (~45项)                   — 运行时可调全局配置
KVMConstant (231行)                       — REST 路径、状态映射、常量
KVMSystemTags (68行)                      — 模式化系统标签
```

> **注意**：`KVMHostBase` 类不存在，`KVMHost` 直接继承 `HostBase`。

## 异步 HTTP 通信封装

`KVMHost` 内部定义了 `Http<T>` 内部类，封装与 kvmagent 的所有通信：

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java
new Http<StartVmCmd>(StartVmCmd.class)
    .call(hostUuid, completion);  // 带主机 UUID（会注入 addons）
```

关键机制：
- 底层调用 `restf.asyncJsonPost()` + `JsonAsyncRESTCallback`
- **KVMBeforeAsyncJsonPostExtensionPoint**：在发送 HTTP 前注入 `kvmHostAddons`，允许其他插件修改命令
- **防删除检查**：HTTP 回调时先检查主机是否已被删除，避免操作已不存在的资源

## 操作串行化：inQueue()

所有对同一主机的操作通过 `inQueue()` 串行化执行：

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java
inQueue().name("start-vm")
    .asyncBackup(msg)
    .run(chain -> {
        // 执行 startVm 逻辑
    });
```

同步级别通过 `KVMGlobalConfig.HOST_SYNC_LEVEL` 控制，默认为 0（异步）。

## 消息分发

**handleApiMessage()**：分发 API 消息（AddKVMHost、UpdateKVMHost 等）

**handleLocalMessage()**：巨型 if-else 链，分发 **40+ 种** 本地消息到独立处理方法，涵盖 VM 生命周期、卷管理、网卡管理、快照、迁移等。

## startVm() — 最复杂的方法（~600 行）

构建 `StartVmCmd` 的过程极其详尽，涵盖：

| 配置项 | 说明 |
|--------|------|
| CPU topology | `setStartVmCpuTopology()` 设置 CPU 拓扑 |
| Boot mode | UEFI / Legacy 启动模式 |
| Secure boot | 安全启动支持 |
| Video/Sound | 显卡/声卡类型 |
| Clock / HyperV | 时钟配置、HyperV 仿真 |
| NUMA | NUMA 拓扑 |
| virtio-scsi | VirtIO SCSI 控制器 |
| WWN | 存储 WWN |
| Cache mode | 磁盘缓存模式 |
| Nested virt | 嵌套虚拟化 |
| Root/Data/Cache volumes | 根云盘/数据云盘/缓存云盘 |
| NICs | `completeNicInfo()` 构建完整网卡信息 |
| CDROMs / Boot order | 光驱与启动顺序 |
| Console password | 控制台密码 |
| Memory balloon | 内存气球 |
| Guest agent channel | 虚拟机代理通道 |

扩展点调用：

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java
extEmitter.beforeStartVmOnKvm();  // 发送 HTTP 前
extEmitter.addOn();               // 注入额外配置
```

成功后保存响应中的 NIC PCI 地址。并发控制使用嵌套队列，同步级别为 `VM_CREATE_CONCURRENCY`。

## migrateVm() — ShareFlowChain 四步流程

使用 `ShareFlowChain` 编排迁移的四个阶段：

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java
// Flow 1: 清理目标主机固件闪存
// Flow 2: 执行迁移（支持 auto-converge、xbzrle、存储迁移、磁盘迁移映射、vDPA、NUMA、带宽、downtime、reload）
// Flow 3: 在目标主机加固 VM 控制台
// Flow 4: 在源主机删除 VM 控制台防火墙规则
```

`MigrateStruct` 内部类持有所有迁移参数。`MigrateNetworkExtensionPoint` 获取迁移 IP 地址。

## connectHook() — 最复杂的连接流程

使用 `ShareFlowChain` 编排大量流程：

```
1. 检查主机接管标志
2. 检查 CPU 架构
3. 应用 ansible playbook（含多个检查器：MD5、DHCP、chrony、yum repo、回调网络、KVM 主机配置、TCP 连接）
4. 配置 iptables
5. Echo 测试（含 fake-dead 重启逻辑）
6. 更新 kvmagent 依赖
7. 收集主机事实（saveKvmHostRelatedFacts、saveGeneralHostHardwareFacts、checkVirtualizationEnabled）
8. 检查 qemu/libvirt 版本（仅新主机）
9. 准备主机环境
→ 完成后调用 continueConnect()
```

`continueConnect()`：同步 HTTP POST 到 kvmagent connect 路径 → 运行 `KVMHostConnectExtensionPoint` 流程 → 检查 `noStorageAccessible()` → 通过 SSH 写入接管标志。

`checkConnectConditions()` FlowChain 包含：
1. 测试 SSH 端口开放（周期性重试）
2. 检查主机密码是否修改（先试密码再试私钥）
3. Ping DNS 检查列表（仅新主机）
4. 检查主机能否访问管理节点

## pingHook() — 心跳检测

`ShareFlowChain` 三步流程：

```
Flow 1: Ping 主机（异步 HTTP POST，检查 hostUuid/版本变化，触发重连或配置更新）
Flow 2: 调用 KVMPingAgentNoFailureExtensionPoint（使用 AsyncLatch 并发）
Flow 3: 调用 KVMPingAgentExtensionPoint（顺序执行）
```

使用 `@AfterDone` 进行后置动作（重连/更新配置）。

## Self-Fencer 机制

kvmagent 主动报告：当 kvmagent 检测到主存储连接问题时，通过同步 HTTP 调用管理节点的 `KVM_RECONNECT_ME` 路径，管理节点发送 `ReconnectHostMsg` 触发重连。

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHostFactory.java
// 注册的同步 HTTP 回调处理器
KVM_RECONNECT_ME              // kvmagent 请求重连
KVM_TRANSMIT_VM_OPERATION_TO_MN  // 转发 VM 操作到管理节点
KVM_REPORT_VM_SHUTDOWN_EVENT  // 报告 VM 关机事件
KVM_REPORT_VM_REBOOT_EVENT    // 报告 VM 重启事件
KVM_REPORT_VM_CRASH_EVENT     // 报告 VM 崩溃事件
KVM_REPORT_HOST_STOP_EVENT    // 报告主机停止事件
ReportSelfFencerCmd           // Self-fencer 事件
```

## KVMHostFactory — 工厂与回调中心

实现接口：`HypervisorFactory`, `Component`, `ManagementNodeReadyExtensionPoint`, `MaxDataVolumeNumberExtensionPoint`, `GuestOsExtensionPoint`, `HypervisorMessageFactory`

关键功能：
- 注册所有 kvmagent → 管理节点的同步 HTTP 回调处理器
- 基于 NIO 的 TCP 服务器，用于检查主机网络连通性
- kvmagent 忙/闲状态管理：触发 `HOST_PING_SKIP` / `HOST_PING_CANCEL_SKIP` 事件

## KVMExtensionEmitter — 14 个扩展点

管理 14 个扩展点列表：

```
startVm, destroyVm, stopVm, rebootVm, addons,
attachVolume, detachVolume, takeSnapshot, checkSnapshot,
mergeSnapshot, checkVmState, syncVmDeviceInfo,
blockCommit, blockPull
```

每个扩展点提供 before/after/failed 三阶段回调，允许其他插件在 VM 操作的关键节点注入逻辑。

## KVMGlobalConfig — 运行时配置（~45 项）

| 类别 | 配置示例 |
|------|----------|
| 迁移 | auto-converge、xbzrle、带宽、downtime |
| 资源预留 | CPU/内存预留比例 |
| 卷限制 | 最大数据卷数量 |
| 同步级别 | HOST_SYNC_LEVEL |
| CPU 模式 | 默认 CPU 模式 |
| DNS 检查 | DNS 检查列表 |
| 快照 | 实时快照开关 |
| 缓存模式 | 磁盘缓存模式 |
| TCP 检查 | TCP 连接检查开关 |
| KSM | 内核同页合并 |
| 内存气球 | Memory balloon 开关 |
| kvmagent 监控 | 内存监控阈值 |

所有配置运行时可通过 API 修改，无需重启。

## 核心设计模式总结

| 模式 | 应用 |
|------|------|
| **异步 HTTP + 回调** | 管理节点 → kvmagent 所有操作 |
| **同步 HTTP 回调** | kvmagent → 管理节点事件报告 |
| **FlowChain / ShareFlowChain** | 所有多步骤操作（连接、迁移、快照等） |
| **观察者模式** | KVMExtensionEmitter 14 个扩展点 |
| **操作串行化** | inQueue() / RunInQueue |
| **去重** | SingleFlightTask |
| **自愈** | Self-fencer + 自动重连 |
| **灰度兼容** | @GrayVersion 注解 |
| **垃圾回收** | OPERATION_FAILURE_GC_ELIGIBLE 标记 |
| **模式化标签** | SystemTags 正则匹配 |
