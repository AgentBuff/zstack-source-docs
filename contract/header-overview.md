# 11 - 契约层设计哲学

## 什么是契约层

在 ZStack 的 Maven 模块体系中，`header/` 是一个极为特殊的模块——它包含 **2938 个 Java 文件**，分布在 **33 个子包**中，却拥有 **零行实现代码**。所有类要么是 `interface`，要么是 `enum`，要么是带有 JPA 注解的 POJO/VO/AO，没有任何业务逻辑实现。

> 源码位置：zstack/header/src/main/java/org/zstack/header/

这种设计并非偶然，而是 ZStack 架构的核心哲学：**将契约（Contract）与实现（Implementation）彻底分离**。

## 为什么要分离契约与实现

### 解耦：打破模块间的编译依赖

如果 `compute/` 模块直接依赖 `network/` 模块的具体实现类，那么任何网络模块的内部重构都会波及计算模块。通过让所有模块共同依赖 `header/` 这个抽象层，模块之间只通过接口和消息通信，编译依赖被彻底切断：

```
compute/ ──depends-on──> header/ <──depends-on── network/
storage/ ──depends-on──> header/ <──depends-on── identity/
plugin/  ──depends-on──> header/ <──depends-on── core/
```

### 多实现：同一契约，不同实现

ZStack 的插件体系要求同一功能可以有多种实现。例如：

- `HypervisorFactory` 接口在 header 中定义，KVM 和 Ceph 各自提供实现
- `HostAllocatorExtensionPoint` 接口定义了主机分配的扩展点，不同的分配策略各自实现
- `LoginProcessor` 接口定义了登录处理，本地登录、LDAP 登录各自实现

没有契约层，这种"一个接口、多个实现"的模式将无法在编译层面强制约束。

### 可测试性：Mock 契约而非实现

测试时只需 Mock header 中的接口和消息类，无需引入任何实现模块的依赖。这极大简化了单元测试的编写：

```java
// 测试只需依赖 header 中的接口
VmInstanceStartExtensionPoint ext = mock(VmInstanceStartExtensionPoint.class);
when(ext.preStartVm(any())).thenReturn(null);
```

## 包结构总览

header 模块按 IaaS 资源域划分子包，每个包对应一类核心资源或基础设施：

| 子包 | 职责 | 典型内容 |
|------|------|----------|
| `header/vm/` | 云主机 | VmInstanceVO, VmInstanceState, 589 个文件 |
| `header/host/` | 物理机 | HostVO, HostState, 237 个文件 |
| `header/cluster/` | 集群 | ClusterVO, ClusterState, 65 个文件 |
| `header/zone/` | 区域 | ZoneVO, ZoneState, 47 个文件 |
| `header/network/l2/` | 二层网络 | L2NetworkVO, L2NetworkType |
| `header/network/l3/` | 三层网络 | L3NetworkVO, IpRangeVO |
| `header/network/service/` | 网络服务 | NetworkServiceType, Eip, PortForwarding |
| `header/storage/primary/` | 主存储 | PrimaryStorageVO, PrimaryStorageCapacityVO |
| `header/storage/backup/` | 备份存储 | BackupStorageVO |
| `header/storage/snapshot/` | 云盘快照 | VolumeSnapshotVO |
| `header/image/` | 镜像 | ImageVO, ImageState, 189 个文件 |
| `header/identity/` | 身份认证 | AccountVO, UserVO, PolicyVO, 269 个文件 |
| `header/volume/` | 云盘 | VolumeVO, VolumeState |
| `header/configuration/` | 云主机规格 | InstanceOfferingVO, DiskOfferingVO |
| `header/message/` | 消息基类 | APIMessage, APIEvent, APIParam, 48 个文件 |
| `header/query/` | 查询框架 | APIQueryMessage, AutoQuery, QueryBuilder |
| `header/vo/` | VO 基础设施 | ResourceVO, EntityGraph, ForeignKey |
| `header/core/` | 框架核心 | FlowChain, CascadeFacade, Completion |
| `header/tag/` | 标签系统 | SystemTag, UserTag |
| `header/allocator/` | 资源分配 | HostAllocatorStrategy |
| `header/apimediator/` | API 拦截器 | ApiMessageInterceptor |
| `header/exception/` | 异常体系 | OperationFailureException |
| `header/errorcode/` | 错误码 | ErrorCode |
| `header/rest/` | REST 声明 | RestRequest, RestResponse |
| `header/search/` | 搜索 | SearchInventory |

## 解剖一个 header 包：header/vm/

以 `header/vm/` 为例，589 个文件可以归纳为以下几类：

### 资源模型类

```
VmInstanceAO.java          -- @MappedSuperclass，定义数据库列
VmInstanceVO.java          -- @Entity，添加关系和 @EntityGraph
VmInstanceEO.java          -- @Entity，软删除视图
VmInstanceVO_.java         -- QueryDSL Q-type（编译期生成元数据）
VmInstanceAO_.java         -- QueryDSL Q-type（AO 层）
VmInstanceInventory.java   -- API 响应对象，纯 POJO
```

### 状态与事件枚举

```java
// VmInstanceState.java — 状态枚举，内嵌 Transaction 表
public enum VmInstanceState {
    Created, Starting, Running, Stopping, Stopped,
    Rebooting, Destroying, Destroyed, Migrating, ...
}

// VmInstanceStateEvent.java — 驱动状态转换的事件
public enum VmInstanceStateEvent {
    starting, stopping, migrating, destroying, ...
}
```

### API 消息类

每个对外 API 都有 Msg + Event 配对：

```
APICreateVmInstanceMsg.java     -- 创建 VM 的请求消息
APICreateVmInstanceEvent.java   -- 创建 VM 的响应事件
APIStartVmInstanceMsg.java      -- 启动 VM
APIStartVmInstanceEvent.java    -- 启动 VM 响应
APIStopVmInstanceMsg.java       -- 停止 VM
APIDestroyVmInstanceMsg.java    -- 销毁 VM
APIQueryVmInstanceMsg.java      -- 查询 VM
APIQueryVmInstanceReply.java    -- 查询 VM 响应
```

### 扩展点接口

```java
// VmInstanceStartExtensionPoint.java
public interface VmInstanceStartExtensionPoint {
    String preStartVm(VmInstanceInventory inv);
    void beforeStartVm(VmInstanceInventory inv);
    void afterStartVm(VmInstanceInventory inv);
    void failedToStartVm(VmInstanceInventory inv, ErrorCode reason);
}

// VmInstanceDestroyExtensionPoint.java
public interface VmInstanceDestroyExtensionPoint {
    String preDestroyVm(VmInstanceInventory inv);
    void beforeDestroyVm(VmInstanceInventory inv);
    void afterDestroyVm(VmInstanceInventory inv);
    void failedToDestroyVm(VmInstanceInventory inv, ErrorCode reason);
}
```

### 内部消息

模块间通信的内部消息，不对外暴露 REST 接口：

```
StartVmOnHypervisorMsg.java     -- 发往 Hypervisor 的启动指令
DestroyVmOnHypervisorMsg.java   -- 发往 Hypervisor 的销毁指令
AttachVolumeToVmOnHypervisorMsg.java
MigrateVmOnHypervisorMsg.java
```

## 依赖规则：单向依赖的铁律

ZStack 的模块依赖遵循一条不可违反的铁律：

> **core/ 和 domain/ 依赖 header/，header/ 永远不依赖任何实现模块**

```
header/  ←  core/       (框架层：CloudBus, FlowChain, QueryBuilder)
header/  ←  compute/    (域层：VM, Host 的实现)
header/  ←  network/    (域层：L2/L3 网络的实现)
header/  ←  storage/    (域层：主存储/备份存储的实现)
header/  ←  identity/   (域层：账户/权限的实现)
header/  ←  plugin/     (插件层：KVM, Ceph, VirtualRouter 等)
```

这条规则确保了：

1. **header/ 可以独立编译**：不依赖任何实现模块，编译速度极快
2. **实现模块可替换**：只要满足 header 中的接口契约，实现可以完全替换
3. **循环依赖不可能**：header 不依赖任何人，所以不可能形成循环

在 Maven POM 中，这种依赖关系体现为：

```xml
<!-- compute/pom.xml -->
<dependency>
    <groupId>org.zstack</groupId>
    <artifactId>header</artifactId>
</dependency>

<!-- header/pom.xml — 不依赖任何 zstack 模块 -->
```

## 契约层的代价

契约层并非没有代价：

1. **文件数量膨胀**：一个简单的"创建 VM"操作就需要 Msg + Event + Inventory + 内部消息，至少 4 个文件
2. **间接性**：阅读代码时需要频繁在 header 和实现之间跳转
3. **编译期生成**：QueryDSL 的 Q-type（`VO_` 类）和 JPA Metamodel 在编译期生成，源码中只有骨架

但这些都是值得的权衡。在一个拥有 22 个 Maven 模块、91+ 个 Spring 配置文件的大型系统中，没有契约层的强制隔离，模块间的耦合将迅速失控。

## 小结

ZStack 的 header 模块是整个系统的"宪法"——它定义了所有资源的形态、状态、消息格式和扩展点，但不规定任何行为。这种契约与实现的彻底分离，是 ZStack 插件化架构的基石，也是其能够在单一代码库中支持多种虚拟化、存储和网络方案的关键。
