# 16 - 计算域总览

计算域是 ZStack IaaS 平台最核心的领域，涵盖了虚拟机、主机、集群、可用区等关键 IaaS 资源的管理。`compute/` 模块是整个 ZStack 代码库中最大的模块，包含 253 个 Java 源文件，其中仅 `vm/` 子目录就有 153 个文件。

## 模块目录结构

```
compute/src/main/java/org/zstack/compute/
├── vm/              # 虚拟机管理 (153 个文件)
├── host/            # 主机管理 (28 个文件)
├── cluster/         # 集群管理 (13 个文件)
├── zone/            # 可用区管理 (9 个文件)
├── allocator/       # 资源分配器 (47 个文件)
├── ComputeManagerImpl.java
└── ComputeGlobalConfig.java
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/

### vm/ 子目录详解

`vm/` 目录是计算域的核心，包含了虚拟机生命周期管理的所有 Flow、Extension 和 Manager：

| 类别 | 代表类 | 说明 |
|------|--------|------|
| 核心 Manager | VmInstanceManagerImpl | VM 实例管理器，注册 FlowChain 元素 |
| 核心 Base | VmInstanceBase (9107 行) | VM 实例的完整操作实现 |
| 创建 Flow | VmAllocateHostFlow, VmAllocateVolumeFlow, VmAllocateNicFlow, VmStartOnHypervisorFlow | VM 创建流程的四个核心步骤 |
| 运维 Flow | VmAttachVolumeOnHypervisorFlow, VmAssignDeviceIdToAttachingVolumeFlow | 挂载云盘等运维操作 |
| 迁移 Flow | VmMigratePostCallExtensionFlow | 迁移后处理 |
| 扩展发射器 | VmInstanceExtensionPointEmitter, VmInstanceNotifyPointEmitter | 事件通知机制 |
| 辅助类 | VmSystemTags, VmInstanceBase.VmPriorityOperator | 系统标签、优先级操作 |

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/

### host/ 子目录详解

| 类别 | 代表类 | 说明 |
|------|--------|------|
| Manager | HostManagerImpl (1098 行) | 主机管理器，处理添加/删除/连接 |
| Base | HostBase (1533 行) | 单台主机的操作实现 |
| 扩展 | HostExtensionPointEmitter | 主机事件通知 |
| 追踪 | HostTracker | 主机连接状态追踪 |

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/host/

### allocator/ 子目录详解

资源分配器目录包含 47 个文件，实现了主机和主存储的分配策略：

| 类别 | 代表类 | 说明 |
|------|--------|------|
| 分配管理 | HostAllocatorManager | 主机分配策略管理 |
| 策略实现 | LeastVmPreferredHostAllocatorStrategyFactory | 最少 VM 优先策略 |
| 策略实现 | MaxCpuHostAllocatorStrategy | 最大 CPU 优先策略 |
| 设计ated 分配 | DesignatedHostAllocatorStrategyFactory | 指定主机分配策略 |

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/allocator/

## 核心 Manager 类

### VmInstanceBase — 9107 行的巨类

`VmInstanceBase` 是 ZStack 中最大的单个类，承载了虚拟机的所有操作逻辑。它继承自 `AbstractVmInstance`，通过 Spring 的 `@Autowired` 注入了大量依赖：

```java
public class VmInstanceBase extends AbstractVmInstance {
    @Autowired
    protected CloudBus bus;
    @Autowired
    protected DatabaseFacade dbf;
    @Autowired
    protected ThreadFacade thdf;
    @Autowired
    protected VmInstanceManager vmMgr;
    @Autowired
    protected VmInstanceExtensionPointEmitter extEmitter;
    @Autowired
    protected CascadeFacade casf;
    @Autowired
    protected AccountManager acntMgr;
    @Autowired
    protected EventFacade evtf;
    @Autowired
    protected PluginRegistry pluginRgty;
    @Autowired
    protected VmInstanceDeletionPolicyManager deletionPolicyMgr;
    @Autowired
    protected HostAllocatorManager hostAllocatorMgr;
    // ... 更多依赖
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:98-136

VmInstanceBase 的核心字段：

```java
protected VmInstanceVO self;           // 当前 VM 的数据库对象
protected VmInstanceVO originalCopy;   // 操作前的快照，用于回滚
protected String syncThreadName;       // 同步队列名称，保证同一 VM 操作串行
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:138-140

### VmInstanceManagerImpl — FlowChain 的编排者

`VmInstanceManagerImpl` 本身不包含 VM 操作的业务逻辑，它的核心职责是：

1. **注册 FlowChain 元素**：通过 Spring XML 配置注入，在启动时构建各种操作的 FlowChainBuilder
2. **消息路由**：将 CloudBus 消息路由到 VmInstanceBase
3. **扩展点管理**：管理 VmInstanceExtensionPoint 等扩展

关键的工作流元素列表（通过 Spring XML 配置注入）：

```java
// 创建 VM 的工作流元素
List<Flow> createVmWorkFlowElements;
// 启动 VM 的工作流元素
List<Flow> startVmWorkFlowElements;
// 迁移 VM 的工作流元素
List<Flow> migrateVmWorkFlowElements;
// 挂载未实例化云盘的工作流元素
List<Flow> attachUninstantiatedVolumeWorkFlowElements;
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceManagerImpl.java

### HostManagerImpl — 主机生命周期管理

`HostManagerImpl` 实现了 `HostManager`, `ManagementNodeChangeListener`, `ManagementNodeReadyExtensionPoint` 等接口：

```java
public class HostManagerImpl extends AbstractService implements HostManager,
        ManagementNodeChangeListener, ManagementNodeReadyExtensionPoint,
        FindSameNodeExtensionPoint {
    // ...
    private Map<String, HypervisorFactory> hypervisorFactories;
    private Future reportHostCapacityTask;
    private Future refreshHostPowerStatusTask;
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/host/HostManagerImpl.java:62-63

### ClusterManagerImpl 与 ZoneManagerImpl

集群和可用区的 Manager 相对简单，主要负责 CRUD 操作和状态管理：

- **ClusterManagerImpl** (203 行)：集群的增删改查，管理集群与主机的关联
- **ZoneManagerImpl** (242 行)：可用区的增删改查，作为资源层级的最顶层

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/cluster/ClusterManagerImpl.java
> 源码位置：zstack/compute/src/main/java/org/zstack/compute/zone/ZoneManagerImpl.java

## Flow 体系 — 81 个 Flow 实现

ZStack 的计算域大量使用 FlowChain 模式来编排复杂操作。Flow 接口定义如下：

```java
public interface Flow {
    void run(FlowTrigger trigger, Map data);
    void rollback(FlowRollback trigger, Map data);
}
```

### Flow 的分类

计算域中的 81 个 Flow 实现按功能可分为以下几类：

#### 1. VM 创建流程 Flow

| Flow | 说明 |
|------|------|
| VmAllocateHostFlow | 分配目标主机 |
| VmAllocateVolumeFlow | 创建根云盘和数据云盘 |
| VmAllocateNicFlow | 创建网卡并分配 MAC/IP |
| VmStartOnHypervisorFlow | 在 Hypervisor 上启动 VM |
| VmInstantiateResourceFlow | 实例化 VM 资源 |

#### 2. VM 运维操作 Flow

| Flow | 说明 |
|------|------|
| VmAttachVolumeOnHypervisorFlow | 在 Hypervisor 上挂载云盘 |
| VmAssignDeviceIdToAttachingVolumeFlow | 为挂载云盘分配设备 ID |
| VmMigratePostCallExtensionFlow | 迁移后调用扩展点 |

#### 3. 网络服务 Flow

网络服务（如 EIP、PortForwarding、SecurityGroup）也通过 Flow 注入到 VM 创建流程中，这些 Flow 由各网络插件提供。

### FlowChain 的构建

FlowChainBuilder 在 VmInstanceManagerImpl 启动时根据 Spring XML 配置构建：

```java
// VmInstanceBase 中获取创建 VM 的 FlowChain
FlowChain chain = getCreateVmWorkFlowChain(getSelfInventory());
setFlowMarshaller(chain);
chain.setName(String.format("create-vm-%s", self.getUuid()));
chain.getData().put(VmInstanceConstant.Params.VmInstanceSpec.toString(), spec);
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7476-7480

`setFlowMarshaller()` 方法允许扩展点在 FlowChain 执行前插入自定义 Flow，这是插件机制的核心。

## Manager / Flow / Extension 三层关系

ZStack 计算域的架构可以概括为三层：

```
┌─────────────────────────────────────────┐
│  Manager 层                              │
│  - VmInstanceManagerImpl (消息路由)       │
│  - HostManagerImpl (主机管理)             │
│  - ClusterManagerImpl (集群管理)          │
│  - ZoneManagerImpl (可用区管理)           │
└──────────────┬──────────────────────────┘
               │ 构建 FlowChain
               ▼
┌─────────────────────────────────────────┐
│  Flow 层                                 │
│  - VmAllocateHostFlow                    │
│  - VmAllocateVolumeFlow                  │
│  - VmAllocateNicFlow                     │
│  - VmStartOnHypervisorFlow               │
│  - ... (81 个 Flow 实现)                  │
└──────────────┬──────────────────────────┘
               │ 触发 Extension
               ▼
┌─────────────────────────────────────────┐
│  Extension 层                            │
│  - VmInstanceExtensionPoint              │
│  - VmBeforeStartOnHypervisorExtensionPoint│
│  - PreHostConnectExtensionPoint          │
│  - PostHostConnectExtensionPoint         │
│  - ... (数十个扩展点)                     │
└─────────────────────────────────────────┘
```

### Manager 层的职责

Manager 层负责：
1. **消息路由**：接收 CloudBus 消息，路由到对应的 Base 对象
2. **FlowChain 构建**：根据操作类型构建对应的 FlowChain
3. **生命周期管理**：管理资源的创建、删除、状态变更

### Flow 层的职责

Flow 层负责：
1. **单步操作**：每个 Flow 实现一个原子操作
2. **自动回滚**：Flow 失败时自动调用 rollback
3. **数据传递**：通过 `Map data` 在 Flow 之间传递 VmInstanceSpec

### Extension 层的职责

Extension 层负责：
1. **事件通知**：在操作前后触发事件
2. **插件扩展**：允许插件注入自定义逻辑
3. **跨模块协调**：不同模块通过 Extension 协调

## VmInstanceBase 的类结构

VmInstanceBase 虽然有 9107 行，但其结构清晰，按功能分区：

### 核心字段区 (1-140 行)

```java
public class VmInstanceBase extends AbstractVmInstance {
    @Autowired protected CloudBus bus;
    @Autowired protected DatabaseFacade dbf;
    @Autowired protected ThreadFacade thdf;
    @Autowired protected VmInstanceManager vmMgr;
    @Autowired protected VmInstanceExtensionPointEmitter extEmitter;
    @Autowired protected CascadeFacade casf;
    @Autowired protected AccountManager acntMgr;
    @Autowired protected EventFacade evtf;
    @Autowired protected PluginRegistry pluginRgty;
    @Autowired protected VmInstanceDeletionPolicyManager deletionPolicyMgr;
    @Autowired protected HostAllocatorManager hostAllocatorMgr;

    protected VmInstanceVO self;
    protected VmInstanceVO originalCopy;
    protected String syncThreadName;
}
```

### 状态检查区 (142-323 行)

包含 `checkState()` 等方法，用于在 Hypervisor 上检查 VM 的实际状态。

### 消息处理区 (324-2580 行)

这是最大的区域，包含所有 API 消息和内部消息的 handler：

- `handle(APIStartVmInstanceMsg)` — 启动 VM
- `handle(APIStopVmInstanceMsg)` — 停止 VM
- `handle(APIRebootVmInstanceMsg)` — 重启 VM
- `handle(APIDestroyVmInstanceMsg)` — 销毁 VM
- `handle(APIMigrateVmMsg)` — 迁移 VM
- `handle(AttachDataVolumeToVmMsg)` — 挂载云盘
- `handle(DetachDataVolumeFromVmMsg)` — 卸载云盘
- `handle(VmAttachNicMsg)` — 挂载网卡

### 操作实现区 (2580-7460 行)

每个操作的具体实现，使用 FlowChain 编排：

- `doDestroy()` — 销毁 VM 的实际逻辑
- `attachDataVolume()` — 挂载云盘的 FlowChain
- `detachDataVolume()` — 卸载云盘的 FlowChain
- `migrateVm()` — 迁移 VM 的 FlowChain
- `doMigrateVm()` — 迁移 VM 的实际执行

### 创建流程区 (7462-8050 行)

VM 创建的核心方法：

- `instantiateVmFromNewCreate()` — 从新建创建 VM
- `startVm()` — 启动 VM
- `buildVmInstanceSpecFromStruct()` — 构建 VmInstanceSpec
- `buildSpecFromInventory()` — 从库存构建 Spec

### 辅助方法区 (8050-9107 行)

包含各种辅助方法：

- `changeVmStateInDb()` — 状态变更
- `validateOperationByState()` — 状态校验
- `getCreateVmWorkFlowChain()` — 获取创建 FlowChain
- `getStartVmWorkFlowChain()` — 获取启动 FlowChain
- `getMigrateVmWorkFlowChain()` — 获取迁移 FlowChain

## 资源层级关系

ZStack 计算域的资源层级为：

```
Zone (可用区)
  └── Cluster (集群)
        └── Host (主机)
              └── VmInstance (虚拟机)
                    ├── VmNic (网卡)
                    ├── Volume (云盘)
                    └── SecurityGroup (安全组)
```

这个层级关系在 CascadeFacade 的级联删除中体现得尤为明显：删除 Zone 会级联删除其下所有 Cluster、Host 和 VM。

## 同步机制

VmInstanceBase 使用 `ThreadFacade.chainSubmit()` 保证同一 VM 的操作串行执行：

```java
protected void handle(final APIStartVmInstanceMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getName() {
            return String.format("start-vm-%s", self.getUuid());
        }

        @Override
        public String getSyncSignature() {
            return syncThreadName;  // 同一 VM 共享同一个签名
        }

        @Override
        public void run(SyncTaskChain chain) {
            startVm(msg, chain);
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7597-7614

`syncThreadName` 在 VmInstanceBase 构造时设置，确保同一 VM 的所有操作（启动、停止、迁移等）都在同一个同步队列中执行，避免并发冲突。

## 总结

计算域是 ZStack 最复杂的模块，其核心设计模式包括：

1. **FlowChain 编排**：所有复杂操作都通过 FlowChain 编排，支持自动回滚
2. **Extension 扩展**：通过 ExtensionPoint 机制实现插件化
3. **同步队列**：通过 ThreadFacade 的 ChainTask 保证操作串行
4. **CascadeFacade**：级联删除保证资源层级一致性
5. **CloudBus 消息**：所有跨服务通信通过 CloudBus 完成

理解计算域的关键在于理解 VmInstanceBase 的 9107 行代码如何通过 FlowChain 和 Extension 机制将复杂操作分解为可组合、可回滚的步骤。
