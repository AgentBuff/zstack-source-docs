# 其他插件概览

ZStack 的插件体系涵盖存储、网络、安全、运维等多个领域。本文综述除 KVM 和 Ceph 外的 20 个插件/模块。

> **注意**：sharedBlock、imageStore、ipsec、gpu、alert 五个插件在开源代码库中无实现类，也无 header 定义——它们仅以 SDK 客户端桩代码和测试 Schema 的形式存在。CloudInit 完全不存在（详见[Cloud-Init 插件](./cloudinit.md)）。

## 主存储插件

### NFS 主存储 (nfsPrimaryStorage)

将 NFS 远端目录挂载为计算节点的主存储，提供虚拟机磁盘文件的存放与分发。

```java
// plugin/nfsPrimaryStorage/src/main/java/org/zstack/storage/primary/nfs/
NfsPrimaryStorage (1971行)       — 核心实现
NfsPrimaryStorageFactory (803行) — 工厂
```

- 主要扩展点：`PrimaryStorageFactory`、`CreateTemplateFromVolumeSnapshotExtensionPoint`
- 显著模式：按 Hypervisor 类型分发 Backend（KvmBackend 等）；Mediator 模式协调备份存储同步；Ansible 部署 agent

### 本地存储 (localstorage)

利用计算节点本地磁盘作为主存储，支持 VM 在同存储主机间迁移。

```java
// plugin/localstorage/src/main/java/org/zstack/storage/primary/local/
LocalStorageBase (3340行)       — 核心实现
LocalStorageFactory (1437行)    — 工厂
```

- 主要扩展点：`PrimaryStorageFactory`、`HostReconnectExtensionPoint`、`HostDeleteExtensionPoint`
- 显著模式：按主机跟踪容量（`LocalStorageHostRefVO`）；Allocator 策略选择有足够空间的主机；迁移流程支持本地存储 VM 的跨主机搬迁

### SharedBlock（无实现）

共享块存储主存储（如 SAN LUN），开源代码库中无实现类，也无 header 定义，仅存在 SDK 客户端桩代码和测试 Schema。

## 备份存储插件

### SFTP 备份存储 (sftpBackupStorage)

通过 SFTP 协议管理镜像备份存储，支持镜像上传/下载与备份同步。

```java
// plugin/sftpBackupStorage/src/main/java/org/zstack/storage/backup/sftp/
SftpBackupStorage (708行)       — 核心实现
SftpBackupStorageFactory (133行) — 工厂
```

- 主要扩展点：`BackupStorageFactory`、`GlobalApiMessageInterceptor`
- 显著模式：Ansible 部署 agent；REST callback 处理异步操作结果

### ImageStore（无实现）

镜像仓库存储后端，开源代码库中无实现类，也无 header 定义，仅存在 SDK 客户端桩代码和测试 Schema。

## 网络服务插件

### VIP (vip)

管理虚拟 IP 地址的生命周期，为 EIP、端口转发、负载均衡等网络服务提供公网 IP 基础。

```java
// plugin/vip/src/main/java/org/zstack/network/service/vip/
VipBase (1041行) + VipManagerImpl (556行)
```

- 显著模式：VipFactory/VipBackend 双层抽象；VIP 生命周期（acquire→use→release）；端口范围追踪（`VipPortRangeVO`）；网络服务引用追踪防止误删

### 端口转发 (portForwarding)

将 VIP 上的端口范围映射到 VM 内网 IP 的端口，实现 DNAT 规则管理。

```java
// plugin/portForwarding/src/main/java/org/zstack/network/service/portforwarding/
PortForwardingManagerImpl (1360行)
```

- 显著模式：`PortForwardingBackend` 按 provider 分发；Flow 链处理 attach/detach；VIP 集成——监听 VIP 释放事件防止规则悬空；端口范围冲突检测

### 负载均衡 (loadBalancer)

管理负载均衡器实例、监听器、服务器组及证书，将流量分发到后端 VM。

```java
// plugin/loadBalancer/src/main/java/org/zstack/network/service/lb/
LoadBalancerManagerImpl (1117行)
```

- 显著模式：`LoadBalancerBackend` 按 provider 分发；ServerGroup 支持（分组/权重）；Certificate 管理（TLS 终结）；ACL 集成；VIP 端口占用追踪

### DNS (network 模块内)

为 VM 提供 DNS 解析服务，支持多种网络设备作为 DNS 后端。

```java
// network/src/main/java/org/zstack/network/service/
DnsExtension (235行)
```

- 非独立插件，作为 `NetworkServiceExtension` 嵌入 network 模块
- Backend 抽象按 provider 分发（VirtualRouterDnsBackend、VyosDnsBackend、FlatDnsBackend）

### SNAT (network 模块内)

为 VM 提供 SNAT 出网能力，使内网 VM 可通过网关访问外网。

```java
// network/src/main/java/org/zstack/network/service/
SnatExtension (157行)
```

- 非独立插件，嵌入 network 模块
- SNAT 一旦启用不释放（设计决策）；与 EIP 互斥——同一网卡不能同时启用 SNAT 和 EIP

### IPsec（无实现）

IPsec VPN 隧道服务，开源代码库中无实现类，也无 header 定义，仅存在 SDK 客户端桩代码和测试 Schema。

## 虚拟路由器 / VyOS

### VyOS (virtualRouterProvider 子包)

以 VyOS 虚拟路由器作为网络服务提供者，承载全部网络服务后端。

```java
// plugin/virtualRouterProvider/src/main/java/org/zstack/network/service/virtualrouter/vyos/
VyosVmFactory (100行) + VyosVersionVersionManagerImpl (54行) + 各 Backend（27-99行）
```

- 非独立插件，作为 virtualRouterProvider 的子包
- 所有 Backend 继承 VirtualRouter 对应父类，仅重写 VM 获取逻辑以选择 VyOS 类型
- 版本管理支持 VyOS 镜像升级
- 体现**模板方法模式**

## 安全与身份插件

### LDAP (ldap)

对接外部 LDAP/AD 服务器，实现用户认证与账号绑定。

```java
// plugin/ldap/src/main/java/org/zstack/ldap/
LdapManagerImpl (591行)
```

- 主要扩展点：`LoginBackend`、`LdapSearchExtensionPoint`
- 显著模式：Spring LDAP 集成（LdapTemplate）；账号绑定表（`LdapAccountRefVO`）关联 LDAP UID 与 ZStack Account；LoginBackend 注册为登录后端

### ACL (acl)

访问控制列表管理，控制 API 调用权限与资源访问策略。

```java
// plugin/acl/src/main/java/org/zstack/acl/
AccessControlListManagerImpl (500行)
```

- 显著模式：ACL 条目（`ACLEntryVO`）管理——策略/规则/动作；级联删除扩展确保资源删除时清理 ACL；重定向规则（RedirectRule）支持 API 路径重写

## 运维与任务插件

### Long Job (longjob)

管理长时间运行的任务（如批量迁移、大规模快照），提供进度追踪与断点续做。

```java
// longjob/src/main/java/org/zstack/longjob/
LongJobManagerImpl (928行)
```

- 主要扩展点：`ManagementNodeReadyExtensionPoint`、`ManagementNodeChangeListener`、`ApiTimeoutExtensionPoint`、`LongJobFactory`
- 显著模式：
  - LongJob 接口定义 start/cancel/resume/clean 生命周期
  - `LongJobFactory` 按 jobName 解析具体实现
  - **FlowContextHandler** 持久化 FlowChain 上下文实现断点续做
  - 管理节点切换时自动恢复运行中的 LongJob
  - API 超时扩展防止长任务被误杀

### Alert（无实现）

告警通知服务，开源代码库中无实现类，也无 header 定义，仅存在 SDK 客户端桩代码和测试 Schema。

### Log (core 模块内)

管理日志保留策略（按大小/时间自动清理），运行时修改 Log4j2 配置。

```java
// core/src/main/java/org/zstack/core/log/
LogManagerImpl (181行)
```

- 非插件，属于 core 框架层
- GlobalConfig 驱动日志保留参数（logRetentionSize/logRetentionDays）
- 启动时直接修改 Log4j2 XML 配置文件实现运行时调整

## 基础设施插件

### Host Network Interface / LLDP (hostNetworkInterface)

通过 LLDP 协议发现主机物理网卡的邻居交换机信息，辅助网络拓扑可视化。

```java
// plugin/hostNetworkInterface/src/main/java/org/zstack/network/hostNetworkInterface/lldp/
LldpManagerImpl (519行)
```

- 主要扩展点：`HostAfterConnectedExtensionPoint`、`HostDeleteExtensionPoint`、`KVMPingAgentNoFailureExtensionPoint`
- 显著模式：主机连接后自动触发 LLDP 发现；物理交换机/端口追踪（`HostNetworkInterfaceLldpVO`）；Ping 失败不告警

### XmlHook (kvm 子包)

允许用户在 VM 启动前注入自定义 XML 片段到 libvirt 域定义中，实现高级定制。

```java
// plugin/kvm/src/main/java/org/zstack/kvm/xmlhook/
XmlHookManagerImpl (177行) + XmlHookBase (233行)
```

- 非独立插件，作为 kvm 插件子包
- 在 VM 启动前拦截并修改 libvirt XML
- 按集群绑定 Hook 脚本；集群 OS 更新时同步更新 Hook

### GPU（无实现）

GPU 设备直通（vGPU/pGPU）管理，开源代码库中无实现类，也无 header 定义，仅存在 SDK 客户端桩代码和测试 Schema。

## 插件全景总结

| 类别 | 插件 | 代码库状态 | 核心类行数 |
|------|------|-----------|-----------|
| 主存储 | NFS | ✅ 完整实现 | 1971 |
| 主存储 | LocalStorage | ✅ 完整实现 | 3340 |
| 主存储 | SharedBlock | ❌ 无实现 | - |
| 备份存储 | SFTP | ✅ 完整实现 | 708 |
| 备份存储 | ImageStore | ❌ 无实现 | - |
| 网络服务 | VIP | ✅ 完整实现 | 1041 |
| 网络服务 | 端口转发 | ✅ 完整实现 | 1360 |
| 网络服务 | 负载均衡 | ✅ 完整实现 | 1117 |
| 网络服务 | DNS | ✅ 嵌入 network | 235 |
| 网络服务 | SNAT | ✅ 嵌入 network | 157 |
| 网络服务 | IPsec | ❌ 无实现 | - |
| 虚拟路由 | VyOS | ✅ VR 子包 | 100 |
| 安全身份 | LDAP | ✅ 完整实现 | 591 |
| 安全身份 | ACL | ✅ 完整实现 | 500 |
| 运维任务 | Long Job | ✅ 完整实现 | 928 |
| 运维任务 | Alert | ❌ 无实现 | - |
| 运维任务 | Log | ✅ core 模块 | 181 |
| 基础设施 | LLDP | ✅ 完整实现 | 519 |
| 基础设施 | XmlHook | ✅ KVM 子包 | 233 |
| 基础设施 | GPU | ❌ 无实现 | - |

**关键发现**：20 个插件中，15 个在开源代码库有实现（其中 4 个非独立插件目录），5 个无实现（仅存在 SDK 客户端桩代码和测试 Schema），CloudInit 完全不存在。
