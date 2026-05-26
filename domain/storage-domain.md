# 20 - 存储域

ZStack 的存储域（storage 模块）负责管理主存储（PrimaryStorage）、备份存储（BackupStorage）和云盘（Volume）三大核心资源。存储模块位于 `zstack/storage/` 目录下，包含 5 个子包：`primary`、`backup`、`volume`、`snapshot`、`addon`。

## 模块结构

```
zstack/storage/src/main/java/org/zstack/storage/
├── primary/          # 主存储管理
├── backup/           # 备份存储管理
├── volume/           # 云盘管理
├── snapshot/         # 快照管理
└── addon/            # 存储插件扩展
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/

## 核心类一览

| 类名 | 行数 | 职责 |
|------|------|------|
| PrimaryStorageManagerImpl | 1565 | 主存储生命周期、容量管理、分配策略 |
| PrimaryStorageBase | 1809 | 主存储抽象基类，定义 hook 方法 |
| BackupStorageManagerImpl | 464 | 备份存储生命周期、容量预留 |
| VolumeManagerImpl | 1428 | 云盘创建/删除/挂载/卸载 |
| VolumeBase | 3455 | 云盘实例，处理所有云盘操作消息 |

## PrimaryStorageManagerImpl

### 类定义与依赖

PrimaryStorageManagerImpl 是主存储的核心管理器，实现了多个扩展接口：

```java
public class PrimaryStorageManagerImpl extends AbstractService implements PrimaryStorageManager,
        ManagementNodeChangeListener, ManagementNodeReadyExtensionPoint,
        VmInstanceStartExtensionPoint, VmInstanceCreateExtensionPoint,
        InstanceOfferingUserConfigValidator, DiskOfferingUserConfigValidator,
        PrimaryStorageSortExtensionPoint, PrimaryStorageFeatureAllocatorExtensionPoint {
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:79

关键依赖注入：

```java
@Autowired
private CloudBus bus;
@Autowired
private DatabaseFacade dbf;
@Autowired
private PluginRegistry pluginRgty;
@Autowired
private PrimaryStorageOverProvisioningManager ratioMgr;
@Autowired
private PrimaryStorageCapacityUpdater capacityUpdater;
```

### Factory 模式

PrimaryStorageManagerImpl 使用 Factory 模式管理不同类型的主存储。每种主存储类型（如 LocalStorage、Ceph、NFS）都有对应的 `PrimaryStorageFactory` 实现：

```java
Map<String, PrimaryStorageFactory> primaryStorageFactories = new HashMap<>();
Map<String, PrimaryStorageAllocatorStrategyFactory> allocatorFactories = new HashMap<>();
Map<String, List<PrimaryStorageExtensionFactory>> extensionFactories = new HashMap<>();
```

在 `start()` 方法中，通过 PluginRegistry 收集所有扩展：

```java
private void populateExtensions() {
    for (PrimaryStorageAllocatorStrategyFactory f : pluginRgty.getExtensionList(PrimaryStorageAllocatorStrategyFactory.class)) {
        PrimaryStorageAllocatorStrategyFactory old = allocatorFactories.get(f.getPrimaryStorageAllocatorStrategyType().toString());
        if (old != null) {
            throw new CloudRuntimeException(String.format("duplicate PrimaryStorageAllocatorStrategyFactory[%s, %s] for type[%s]",
                    f.getClass().getName(), old.getClass().getName(), f.getPrimaryStorageAllocatorStrategyType()));
        }
        allocatorFactories.put(f.getPrimaryStorageAllocatorStrategyType().toString(), f);
    }

    for (PrimaryStorageFactory f : pluginRgty.getExtensionList(PrimaryStorageFactory.class)) {
        PrimaryStorageFactory old = primaryStorageFactories.get(f.getPrimaryStorageType().toString());
        if (old != null) {
            throw new CloudRuntimeException(String.format("duplicate PrimaryStorageFactory[%s, %s] for type[%s]",
                    f.getClass().getName(), old.getClass().getName(), f.getPrimaryStorageType()));
        }
        primaryStorageFactories.put(f.getPrimaryStorageType().toString(), f);
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1232

### 主存储分配

主存储分配是存储域最核心的功能之一。当 VM 创建或云盘挂载时，系统需要从可用主存储中选择一个满足条件的存储。

#### 分配策略

ZStack 提供了多种主存储分配策略，都继承自 `AbstractPrimaryStorageAllocatorStrategy`：

| 策略类 | 说明 |
|--------|------|
| DefaultPrimaryStorageAllocatorStrategy | 默认策略，使用 FlowChain 筛选和排序 |
| LeastVolumePrimaryStorageAllocatorStrategy | 选择云盘数最少的主存储 |
| MaximumAvailableCapacityAllocatorStrategy | 选择可用容量最大的主存储 |
| CustomOrderPrimaryStorageAllocatorStrategy | 按自定义顺序选择 |

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/DefaultPrimaryStorageAllocatorStrategy.java

`AbstractPrimaryStorageAllocatorStrategy` 是所有策略的基类，核心逻辑是两阶段处理：

```java
@Override
public List<PrimaryStorageInventory> allocateAllCandidates(PrimaryStorageAllocationSpec spec) {
    List<PrimaryStorageVO> candidates;
    candidates = allocateAll(spec);       // 第一阶段：筛选候选
    Collections.shuffle(candidates);       // 随机打散
    candidates = sortAll(spec, candidates); // 第二阶段：排序
    return PrimaryStorageInventory.valueOf(candidates);
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/AbstractPrimaryStorageAllocatorStrategy.java:46

两个阶段都使用 FlowChain 实现，`allocateBuilder` 负责筛选，`sortBuilder` 负责排序。FlowChain 的 Flow 元素通过 Spring XML 配置注入。

#### 分配流程

当收到 `AllocatePrimaryStorageMsg` 时，PrimaryStorageManagerImpl 的处理流程：

1. **确定分配策略**：依次检查扩展点、DiskOffering 配置、消息参数，最终回退到默认策略

```java
private String getAllocateStrategyFromMsg(AllocatePrimaryStorageMsg msg) {
    String allocatorStrategyType = null;
    for (PrimaryStorageAllocatorStrategyExtensionPoint ext : pluginRgty.getExtensionList(PrimaryStorageAllocatorStrategyExtensionPoint.class)) {
        allocatorStrategyType = ext.getPrimaryStorageAllocatorStrategyName(msg);
        if (allocatorStrategyType != null) {
            break;
        }
    }

    if (allocatorStrategyType == null && msg.getDiskOfferingUuid() != null) {
        allocatorStrategyType = Q.New(DiskOfferingVO.class)
                .eq(DiskOfferingVO_.uuid, msg.getDiskOfferingUuid())
                .select(DiskOfferingVO_.allocatorStrategy)
                .findValue();
    }

    if (allocatorStrategyType == null) {
        allocatorStrategyType = msg.getAllocationStrategy() == null ?
                PrimaryStorageConstant.DEFAULT_PRIMARY_STORAGE_ALLOCATION_STRATEGY_TYPE
                : msg.getAllocationStrategy();
    }
    return allocatorStrategyType;
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:797

2. **构建分配规格**：将消息参数转换为 `PrimaryStorageAllocationSpec`

```java
private PrimaryStorageAllocationSpec buildAllocateSpecFromMsg(AllocatePrimaryStorageMsg msg) {
    PrimaryStorageAllocationSpec spec = new PrimaryStorageAllocationSpec();
    spec.setPossiblePrimaryStorageTypes(msg.getPossiblePrimaryStorageTypes());
    spec.setRequiredFeatures(msg.getRequiredFeatures());
    spec.setSize(msg.getSize());
    spec.setNoOverProvisioning(msg.isNoOverProvisioning());
    spec.setRequiredClusterUuids(msg.getRequiredClusterUuids());
    spec.setRequiredHostUuid(msg.getRequiredHostUuid());
    spec.setRequiredZoneUuid(msg.getRequiredZoneUuid());
    spec.setAvoidPrimaryStorageUuids(msg.getExcludePrimaryStorageUuids());
    spec.setCandidatePrimaryStorageUuids(msg.getCandidatePrimaryStorageUuids());
    // ... 更多字段
    return spec;
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:828

3. **执行分配**：调用策略的 `allocateAllCandidates()` 方法

### 超分比管理

ZStack 支持主存储超分比（Over-Provisioning Ratio），通过 `PrimaryStorageOverProvisioningManager` 管理：

- 物理容量 × 超分比 = 可用逻辑容量
- 超分比可通过 GlobalConfig 或 SystemTag 按主存储单独设置
- `PrimaryStorageCapacityUpdater` 负责原子性地更新容量信息

### 主存储连接

PrimaryStorageBase 是主存储的抽象基类，定义了大量 abstract hook 方法供子类实现：

```java
protected abstract void handle(InstantiateVolumeOnPrimaryStorageMsg msg);
protected abstract void handle(DeleteVolumeOnPrimaryStorageMsg msg);
protected abstract void handle(CreateImageCacheFromVolumeOnPrimaryStorageMsg msg);
protected abstract void handle(DownloadDataVolumeToPrimaryStorageMsg msg);
protected abstract void connectHook(ConnectParam param, Completion completion);
protected abstract void pingHook(Completion completion);
protected abstract void syncPhysicalCapacity(ReturnValueCompletion<PhysicalCapacityUsage> completion);
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageBase.java:120-170

连接参数通过内部类 `ConnectParam` 传递：

```java
public static class ConnectParam {
    private boolean newAdded;

    public boolean isNewAdded() {
        return newAdded;
    }

    public void setNewAdded(boolean newAdded) {
        this.newAdded = newAdded;
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageBase.java:108

### 垃圾回收（Trash）

PrimaryStorageManagerImpl 内置了自动清理垃圾的机制。当云盘被删除时，其物理文件不会立即删除，而是移入回收站，由定期任务清理：

```java
class AutoDeleteTrashTask {
    Future<Void> runnable;
    PeriodicTask task;

    public AutoDeleteTrashTask(PeriodicTask task) {
        this.runnable = thdf.submitPeriodicTask(task);
        this.task = task;
    }

    public void cancel() {
        runnable.cancel(true);
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1040

定期任务通过 `getTrashPeriodicTask()` 创建，遍历 `InstallPathRecycleVO` 表中的回收记录，逐个发送 `CleanUpTrashOnPrimaryStroageMsg` 清理：

```java
public void run() {
    List<InstallPathRecycleVO> vos = findRecycle(psUuid);
    if (vos.isEmpty()) {
        return;
    }
    for (InstallPathRecycleVO vo : vos) {
        CleanUpTrashOnPrimaryStroageMsg pmsg = new CleanUpTrashOnPrimaryStroageMsg();
        pmsg.setPrimaryStorageUuid(vo.getStorageUuid());
        pmsg.setTrashId(vo.getTrashId());
        bus.makeTargetServiceIdByResourceUuid(pmsg, PrimaryStorageConstant.SERVICE_ID, vo.getStorageUuid());
        bus.send(pmsg, new CloudBusCallBack(pmsg) {
            @Override
            public void run(MessageReply reply) {
                if (reply.isSuccess()) {
                    logger.debug(String.format("Delete trash [%s] on primary storage [%s] successfully", vo.getTrashId(), vo.getStorageUuid()));
                }
            }
        });
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1090

### 主机-存储连接状态刷新

PrimaryStorageManagerImpl 启动了一个定期任务，检查 Disconnected 状态的主机-存储连接，尝试恢复：

```java
private synchronized void startRefreshPrimaryStorageHostStatusTask() {
    refreshPrimaryStorageHostStatusTask = thdf.submitPeriodicTask(new PeriodicTask() {
        @Override
        public void run() {
            List<PrimaryStorageHostRefVO> refs = Q.New(PrimaryStorageHostRefVO.class)
                    .eq(PrimaryStorageHostRefVO_.status, PrimaryStorageHostStatus.Disconnected)
                    .list();

            // 按 primaryStorageUuid 分组
            Map<String, List<String>> disconnectedHostsByPsUuid = new HashMap<>();
            refs.forEach(ref -> {
                disconnectedHostsByPsUuid.computeIfAbsent(ref.getPrimaryStorageUuid(), key -> new ArrayList<>()).add(ref.getHostUuid());
            });

            // 发送 CheckHostStorageConnectionMsg 检查
            List<CheckHostStorageConnectionMsg> msgs = new ArrayList<>();
            for (Map.Entry<String, List<String>> entry : disconnectedHostsByPsUuid.entrySet()) {
                CheckHostStorageConnectionMsg msg = new CheckHostStorageConnectionMsg();
                msg.setPrimaryStorageUuid(entry.getKey());
                msg.setHostUuids(entry.getValue());
                bus.makeTargetServiceIdByResourceUuid(msg, PrimaryStorageConstant.SERVICE_ID, entry.getKey());
                msgs.add(msg);
            }
            // 并发发送，最多 10 个
            new While<>(msgs).step((msg, comp) -> {
                bus.send(msg, new CloudBusCallBack(comp) { ... });
            }, 10).run(new NopeWhileDoneCompletion());
        }
    });
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1165

### 管理节点接管

当管理节点离开集群时，存活的管理节点需要接管其管理的主存储：

```java
@Override
public void nodeLeft(ManagementNodeInventory inv) {
    logger.debug(String.format("management node[uuid:%s] left, node[uuid:%s] starts taking over primary storage...",
            inv.getUuid(), Platform.getManagementServerId()));
    loadPrimaryStorage(true);  // skipConnected=true，只接管断开连接的
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1280

`loadPrimaryStorage()` 通过一致性哈希（`destMaker.isManagedByUs()`）判断哪些主存储应由当前节点管理，然后发送 `ConnectPrimaryStorageMsg` 重新连接。

### VM 创建时的存储干预

PrimaryStorageManagerImpl 实现了 `VmCreateInstanceExtensionPoint`，在 VM 创建前设置根云盘和数据云盘的主存储约束：

```java
@Override
public void preCreateVmInstance(CreateVmInstanceMsg msg) {
    settingRootVolume(msg);
    settingDataVolume(msg);
    // 处理 InstanceOffering 中的 cluster 约束
    String instanceOffering = msg.getInstanceOfferingUuid();
    if (InstanceOfferingSystemTags.INSTANCE_OFFERING_USER_CONFIG.hasTag(instanceOffering)) {
        InstanceOfferingUserConfig config = OfferingUserConfigUtils.getInstanceOfferingConfig(instanceOffering, InstanceOfferingUserConfig.class);
        String clusterUuid = config.getAllocate().getClusterUuid();
        if (clusterUuid != null) {
            msg.setClusterUuid(clusterUuid);
        }
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1384

`settingRootVolume()` 方法从 DiskOffering 的 SystemTag 中提取主存储约束，设置到 `CreateVmInstanceMsg` 的 `candidatePrimaryStorageUuidsForRootVolume` 字段。

## BackupStorageManagerImpl

### 类定义

BackupStorageManagerImpl 是备份存储的管理器，结构比 PrimaryStorageManagerImpl 简单得多：

```java
public class BackupStorageManagerImpl extends AbstractService implements BackupStorageManager,
        ManagementNodeChangeListener, ManagementNodeReadyExtensionPoint {
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/backup/BackupStorageManagerImpl.java

### Factory 模式

与主存储类似，备份存储也使用 Factory 模式：

```java
Map<String, BackupStorageFactory> backupStorageFactories = new HashMap<>();
Map<String, BackupStorageAllocatorStrategyFactory> allocatorStrategyFactories = new HashMap<>();
```

在 `populateBackupStorageFactory()` 中收集扩展：

```java
private void populateBackupStorageFactory() {
    for (BackupStorageFactory factory : pluginRgty.getExtensionList(BackupStorageFactory.class)) {
        BackupStorageFactory old = backupStorageFactories.get(factory.getBackupStorageType().toString());
        if (old != null) {
            throw new CloudRuntimeException(String.format("duplicate BackupStorageFactory[%s, %s] for type[%s]",
                    factory.getClass().getName(), old.getClass().getName(), factory.getBackupStorageType()));
        }
        backupStorageFactories.put(factory.getBackupStorageType().toString(), factory);
    }

    for (BackupStorageAllocatorStrategyFactory factory : pluginRgty.getExtensionList(BackupStorageAllocatorStrategyFactory.class)) {
        BackupStorageAllocatorStrategyFactory old = allocatorStrategyFactories.get(factory.getType().toString());
        if (old != null) {
            throw new CloudRuntimeException(String.format("duplicate BackupStorageAllocatorStrategyFactory[%s, %s] for type[%s]",
                    old.getClass().getName(), factory.getClass().getName(), factory.getType()));
        }
        allocatorStrategyFactories.put(factory.getType().toString(), factory);
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/backup/BackupStorageManagerImpl.java:362

### 容量预留

备份存储的容量预留使用悲观锁（`PESSIMISTIC_WRITE`）保证原子性：

```java
@Transactional
private boolean reserve(String bsUuid, long size) {
    BackupStorageVO vo = dbf.getEntityManager().find(BackupStorageVO.class, bsUuid, LockModeType.PESSIMISTIC_WRITE);
    if (vo == null) {
        logger.warn(String.format("reservation failure, cannot find backup storage[uuid:%s]", bsUuid));
        return false;
    }

    if (vo.getAvailableCapacity() < size) {
        logger.warn(String.format("reservation failure, cannot reserve capacity[%s bytes] on backup storage[uuid:%s]", size, bsUuid));
        return false;
    }

    long avail = vo.getAvailableCapacity() - size;
    vo.setAvailableCapacity(avail);
    dbf.getEntityManager().merge(vo);
    return true;
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/backup/BackupStorageManagerImpl.java:229

分配流程：先通过策略获取候选列表，然后逐个尝试预留容量，直到成功：

```java
private void handle(AllocateBackupStorageMsg msg) {
    String allocatorStrategy = msg.getAllocatorStrategy() == null ? BackupStorageConstant.DEFAULT_ALLOCATOR_STRATEGY : msg.getAllocatorStrategy();
    BackupStorageAllocatorStrategyFactory factory = getAllocatorFactory(allocatorStrategy);
    BackupStorageAllocatorStrategy strategy = factory.getAllocatorStrategy();

    BackupStorageAllocationSpec spec = new BackupStorageAllocationSpec();
    spec.setAllocationMessage(msg);
    spec.setSize(msg.getSize());
    spec.setRequiredZoneUuid(msg.getRequiredZoneUuid());
    spec.setRequiredPrimaryStorageUuid(msg.getRequiredPrimaryStorageUuid());

    List<BackupStorageInventory> invs = strategy.allocateAllCandidates(spec);
    Iterator<BackupStorageInventory> it = invs.iterator();
    BackupStorageInventory target = null;
    while (it.hasNext()) {
        BackupStorageInventory inv = it.next();
        if (reserve(inv.getUuid(), msg.getSize())) {
            target = inv;
            break;
        }
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/backup/BackupStorageManagerImpl.java:249

### 管理节点接管

与主存储相同的接管模式：

```java
@Override
public void nodeLeft(ManagementNodeInventory inv) {
    logger.debug(String.format("management node[uuid:%s] left, node[uuid:%s] starts taking over backup storage...", inv.getUuid(), Platform.getManagementServerId()));
    loadBackupStorage(true);
}

@Override
@AsyncThread
public void managementNodeReady() {
    logger.debug(String.format("management node[uuid:%s] joins, starts load backup storage...", Platform.getManagementServerId()));
    loadBackupStorage(false);
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/backup/BackupStorageManagerImpl.java:444

## VolumeManagerImpl

### 类定义

VolumeManagerImpl 是云盘的管理器，负责云盘的创建、删除、实例化等操作：

```java
public class VolumeManagerImpl extends AbstractService implements VolumeManager, ManagementNodeReadyExtensionPoint,
        ResourceOwnerAfterChangeExtensionPoint, VmStateChangedExtensionPoint, VmDetachVolumeExtensionPoint,
        VmAttachVolumeExtensionPoint, HostAfterConnectedExtensionPoint {
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java

### 云盘创建

云盘创建有三种方式：

1. **直接创建空云盘**（`CreateDataVolumeMsg`）
2. **从快照创建**（`CreateDataVolumeFromVolumeSnapshotMsg`）
3. **从模板创建**（`CreateDataVolumeFromVolumeTemplateMsg`）

#### 直接创建空云盘

```java
private void handle(CreateDataVolumeMsg msg) {
    // 前置扩展点
    pluginRgty.getExtensionList(CreateDataVolumeExtensionPoint.class).forEach(extensionPoint -> {
        extensionPoint.preCreateVolume(msg);
    });

    VolumeVO vo = new VolumeVO();
    vo.setUuid(msg.getResourceUuid() != null ? msg.getResourceUuid() : Platform.getUuid());
    vo.setName(msg.getName());
    vo.setDiskOfferingUuid(msg.getDiskOfferingUuid());
    vo.setSize(msg.getDiskSize());
    vo.setActualSize(0L);
    vo.setType(VolumeType.Data);
    vo.setStatus(VolumeStatus.NotInstantiated);
    vo.setAccountUuid(msg.getAccountUuid());

    // 处理 QoS SystemTag
    if (msg.getSystemTags() != null) {
        Iterator<String> iterators = msg.getSystemTags().iterator();
        while (iterators.hasNext()) {
            String tag = iterators.next();
            if (VolumeSystemTags.VOLUME_QOS.isMatch(tag)) {
                vo.setVolumeQos(VolumeSystemTags.VOLUME_QOS.getTokenByTag(tag, VolumeSystemTags.VOLUME_QOS_TOKEN));
                iterators.remove();
                break;
            }
        }
    }

    // 持久化到数据库
    vo = new SQLBatchWithReturn<VolumeVO>() {
        @Override
        protected VolumeVO scripts() {
            dbf.getEntityManager().persist(finalVo1);
            dbf.getEntityManager().flush();
            dbf.getEntityManager().refresh(finalVo1);
            return finalVo1;
        }
    }.execute();

    // 如果指定了主存储，则立即实例化
    if (msg.getPrimaryStorageUuid() != null || requiredPrimaryStorageUuids != null) {
        InstantiateVolumeMsg imsg = new InstantiateVolumeMsg();
        imsg.setVolumeUuid(vo.getUuid());
        imsg.setPrimaryStorageUuid(msg.getPrimaryStorageUuid());
        bus.makeTargetServiceIdByResourceUuid(imsg, VolumeConstant.SERVICE_ID, vo.getUuid());
        bus.send(imsg, new CloudBusCallBack(msg) {
            @Override
            public void run(MessageReply r) {
                if (!r.isSuccess()) {
                    dbf.remove(finalVo);  // 失败时删除 VO
                }
            }
        });
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java:1012

关键点：
- 空云盘创建时状态为 `NotInstantiated`，不占用主存储空间
- 只有指定了主存储时才会触发实例化（`InstantiateVolumeMsg`）
- 实例化失败时会删除已创建的 VO 记录

#### 从快照创建

```java
private void handle(CreateDataVolumeFromVolumeSnapshotMsg msg) {
    VolumeVO vo = new VolumeVO();
    vo.setUuid(Platform.getUuid());
    vo.setState(VolumeState.Enabled);
    vo.setStatus(VolumeStatus.Creating);
    vo.setType(VolumeType.Data);
    vo.setSize(0);  // 大小由快照决定

    // 持久化并创建标签
    vvo = new SQLBatchWithReturn<VolumeVO>() { ... }.execute();

    // 触发状态变更事件
    new FireVolumeCanonicalEvent().fireVolumeStatusChangedEvent(null, VolumeInventory.valueOf(vvo));

    // 从快照实例化
    instantiateDataVolumeFromSnapshot(vo, msg.getVolumeSnapshotUuid(), msg.getSystemTags(), new ReturnValueCompletion<VolumeInventory>(msg) {
        @Override
        public void success(VolumeInventory volume) {
            reply.setInventory(volume);
            bus.reply(msg, reply);
        }

        @Override
        public void fail(ErrorCode errorCode) {
            reply.setError(errorCode);
            bus.reply(msg, reply);
        }
    });
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java:829

`instantiateDataVolumeFromSnapshot()` 发送 `InstantiateDataVolumeFromVolumeSnapshotMsg` 到快照服务，由快照服务协调主存储完成实例化。

### 云盘生命周期

云盘有两个维度的状态：

- **VolumeState**：Enabled / Disabled — 管理员控制
- **VolumeStatus**：NotInstantiated / Creating / Ready / Deleted / Migrating — 运行时状态

状态流转：

```
NotInstantiated → Creating → Ready
                          ↘ Deleted (失败)
Ready → Deleted → (Expunge 定期清理)
Ready → Migrating → Ready (迁移)
```

### 云盘清理（Expunge）

VolumeManagerImpl 启动了一个定期任务，清理已删除的云盘：

```java
private synchronized void startExpungeTask() {
    volumeExpungeTask = thdf.submitCancelablePeriodicTask(new CancelablePeriodicTask() {
        @Override
        public boolean run() {
            List<Tuple> vols = getDeletedVolumeManagedByUs();
            Timestamp current = dbf.getCurrentSqlTime();
            for (final Tuple v : vols) {
                final String uuid = v.get(0, String.class);
                Timestamp date = v.get(1, Timestamp.class);
                long end = date.getTime() + TimeUnit.SECONDS.toMillis(VolumeGlobalConfig.VOLUME_EXPUNGE_PERIOD.value(Long.class));
                if (current.getTime() >= end) {
                    VolumeDeletionPolicy deletionPolicy = deletionPolicyMgr.getDeletionPolicy(uuid);
                    if (deletionPolicy == VolumeDeletionPolicy.Never) {
                        continue;  // Never 策略不清理
                    }
                    ExpungeVolumeMsg msg = new ExpungeVolumeMsg();
                    msg.setVolumeUuid(uuid);
                    bus.makeTargetServiceIdByResourceUuid(msg, VolumeConstant.SERVICE_ID, uuid);
                    bus.send(msg, ...);
                }
            }
            return false;
        }

        @Override
        public long getInterval() {
            return VolumeGlobalConfig.VOLUME_EXPUNGE_INTERVAL.value(Long.class);
        }
    });
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java:1197

关键配置：
- `VOLUME_EXPUNGE_INTERVAL`：清理任务执行间隔
- `VOLUME_EXPUNGE_PERIOD`：云盘删除后保留时间
- `VOLUME_DELETION_POLICY`：删除策略（Direct / Delay / Never）

### VolumeBase

VolumeBase 是云盘实例的基类，处理所有云盘操作消息。它定义了大量的消息处理分支：

```java
private void handleLocalMessage(Message msg) {
    if (msg instanceof VolumeDeletionMsg) {
        handle((VolumeDeletionMsg) msg);
    } else if (msg instanceof DeleteVolumeMsg) {
        handle((DeleteVolumeMsg) msg);
    } else if (msg instanceof InstantiateVolumeMsg) {
        handle((InstantiateVolumeMsg) msg);
    } else if (msg instanceof ExpungeVolumeMsg) {
        handle((ExpungeVolumeMsg) msg);
    } else if (msg instanceof RecoverVolumeMsg) {
        handle((RecoverVolumeMsg) msg);
    } else if (msg instanceof SyncVolumeSizeMsg) {
        handle((SyncVolumeSizeMsg) msg);
    } else if (msg instanceof ReInitVolumeMsg) {
        handle((ReInitVolumeMsg) msg);
    } else if (msg instanceof ChangeVolumeTypeMsg) {
        handle((ChangeVolumeTypeMsg) msg);
    } else if (msg instanceof FlattenVolumeMsg) {
        handle((FlattenVolumeMsg) msg);
    } else {
        bus.dealWithUnknownMessage(msg);
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeBase.java:126

VolumeBase 使用 `syncThreadId` 实现同步锁，确保同一云盘的操作串行执行：

```java
public VolumeBase(VolumeVO vo) {
    self = vo;
    syncThreadId = String.format("volume-%s", self.getUuid());
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeBase.java:103

### VM 状态变更监听

VolumeManagerImpl 监听 VM 状态变更，自动更新云盘状态：

```java
@Override
public void vmStateChanged(VmInstanceInventory vm, VmInstanceState oldState, VmInstanceState newState) {
    if (newState == VmInstanceState.Destroyed && vm != null && vm.getRootVolumeUuid() != null) {
        SQL.New(VolumeVO.class).eq(VolumeVO_.uuid, vm.getRootVolumeUuid())
                .set(VolumeVO_.status, VolumeStatus.Deleted)
                .update();
    }
    if (oldState == VmInstanceState.VolumeMigrating && newState == VmInstanceState.Stopped && vm != null && vm.getRootVolumeUuid() != null) {
        SQL.New(VolumeVO.class).eq(VolumeVO_.uuid, vm.getRootVolumeUuid()).eq(VolumeVO_.status, VolumeStatus.Migrating)
                .set(VolumeVO_.status, VolumeStatus.Ready)
                .update();
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java:1335

### 主机连接时自动挂载

VolumeManagerImpl 实现了 `HostAfterConnectedExtensionPoint`，当主机重新连接时，自动挂载该主机上的本地存储云盘：

```java
@Override
public void afterHostConnected(HostInventory host) {
    String hostUuid = host.getUuid();
    List<VolumeHostRefVO> refVOs = Q.New(VolumeHostRefVO.class).eq(VolumeHostRefVO_.hostUuid, hostUuid).list();
    if (refVOs == null || refVOs.isEmpty()) {
        return;
    }
    refVOs.forEach(refVO -> {
        AttachDataVolumeToHostMsg mmsg = new AttachDataVolumeToHostMsg();
        mmsg.setHostUuid(refVO.getHostUuid());
        mmsg.setVolumeUuid(refVO.getVolumeUuid());
        mmsg.setMountPath(refVO.getMountPath());
        mmsg.setDevice(refVO.getDevice());
        bus.makeTargetServiceIdByResourceUuid(mmsg, HostConstant.SERVICE_ID, hostUuid);
        bus.send(mmsg, ...);
    });
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/volume/VolumeManagerImpl.java:1405

## 存储域与计算域的交互

存储域与计算域之间存在紧密的交互关系：

1. **VM 创建时**：PrimaryStorageManagerImpl 通过 `VmCreateInstanceExtensionPoint.preCreateVmInstance()` 设置主存储约束
2. **主机维护时**：如果主存储不可访问，主机也会被标记为 Disconnected（`noStorageAccessible()`）
3. **主机重连时**：VolumeManagerImpl 自动挂载本地存储云盘
4. **VM 销毁时**：根云盘状态自动更新为 Deleted
5. **容量检查**：VM 启动前检查所有云盘所在主存储是否处于维护状态

```java
private void checkVmAllVolumePrimaryStorageState(String vmUuid) {
    String sql = "select uuid from PrimaryStorageVO where uuid in (" +
            " select distinct(primaryStorageUuid) from VolumeVO" +
            " where vmInstanceUuid = :vmUuid and primaryStorageUuid is not null)" +
            " and state = :psState";
    List<String> result = SQL.New(sql, String.class)
            .param("vmUuid", vmUuid)
            .param("psState", PrimaryStorageState.Maintenance)
            .list();
    if (result != null && !result.isEmpty()) {
        throw new OperationFailureException(argerr("the VM[uuid:%s] volume stored location primary storage is in a state of maintenance", vmUuid));
    }
}
```

> 源码位置：zstack/storage/src/main/java/org/zstack/storage/primary/PrimaryStorageManagerImpl.java:1344

## 关键扩展点

| 扩展点 | 用途 |
|--------|------|
| PrimaryStorageFactory | 创建不同类型的主存储实例 |
| PrimaryStorageAllocatorStrategyExtensionPoint | 自定义分配策略名称 |
| PrimaryStorageExtensionFactory | 主存储扩展（如 Ceph RBD） |
| PSCapacityExtensionPoint | 容量变更通知 |
| BackupStorageFactory | 创建不同类型的备份存储实例 |
| CreateDataVolumeExtensionPoint | 云盘创建前后的回调 |
| InstantiateDataVolumeOnCreationExtensionPoint | 云盘实例化扩展 |
| VolumeAttachedJudger | 判断云盘是否已挂载 |

## 总结

ZStack 存储域的设计遵循了与计算域一致的架构模式：

- **Factory 模式**：通过 PrimaryStorageFactory / BackupStorageFactory 支持多种存储类型
- **Strategy 模式**：通过 PrimaryStorageAllocatorStrategy 支持多种分配策略，策略内部使用 FlowChain 实现筛选和排序
- **ExtensionPoint 模式**：通过大量扩展点实现松耦合
- **容量管理**：主存储支持超分比，备份存储使用悲观锁预留容量
- **垃圾回收**：主存储有 Trash 机制，云盘有 Expunge 定期任务
- **管理节点接管**：主存储和备份存储都实现了 ManagementNodeChangeListener，支持 HA
