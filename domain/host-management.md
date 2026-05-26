# 19 - 主机管理

主机（Host）是 ZStack 计算域的核心资源，承载虚拟机运行。主机管理涉及主机的添加、连接、状态维护、维护模式、容量报告等关键流程。本章深入分析 HostManagerImpl 和 HostBase 的源码实现。

## 主机管理架构

### 核心类关系

```
HostManagerImpl (AbstractService)
    ├── 实现: HostManager, ManagementNodeChangeListener, ManagementNodeReadyExtensionPoint
    ├── 职责: 主机添加、消息路由、周期任务、管理节点接管
    └── 持有: HypervisorFactory Map, HostExtensionManager List, HostTracker

HostBase (AbstractHost)
    ├── 职责: 单台主机的连接/断开/状态变更/维护模式
    ├── 子类: KVMHost (由 HypervisorFactory 创建)
    └── 持有: HostVO self, CloudBus, DatabaseFacade, HostTracker
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/host/HostManagerImpl.java
> 源码位置：zstack/compute/src/main/java/org/zstack/compute/host/HostBase.java

### 消息路由机制

HostManagerImpl 的 `handleMessage()` 方法负责消息分发：

```java
// HostManagerImpl.java:281
@Override
@MessageSafe
public void handleMessage(Message msg) {
    HostExtensionManager extensionManager = hostExtensionManagers.stream()
        .filter(it -> it.getMessageClasses()
            .stream().anyMatch(clz -> clz.isAssignableFrom(msg.getClass())))
        .findFirst().orElse(null);
    if (extensionManager != null) {
        extensionManager.handleMessage(msg);
    } else if (msg instanceof APIMessage) {
        handleApiMessage((APIMessage) msg);
    } else {
        handleLocalMessage(msg);
    }
}
```

对于 `HostMessage` 类型的消息，通过 `passThrough()` 路由到具体的 HostBase 实例：

```java
// HostManagerImpl.java:262
private void passThrough(HostMessage msg) {
    HostVO vo = dbf.findByUuid(msg.getHostUuid(), HostVO.class);
    if (vo == null && allowedMessageAfterSoftDeletion.contains(msg.getClass())) {
        HostEO eo = dbf.findByUuid(msg.getHostUuid(), HostEO.class);
        vo = ObjectUtils.newAndCopy(eo, HostVO.class);
    }
    if (vo == null) {
        throw new OperationFailureException(err(...));
    }
    HypervisorFactory factory = this.getHypervisorFactory(
        HypervisorType.valueOf(vo.getHypervisorType()));
    Host host = factory.getHost(vo);
    host.handleMessage((Message) msg);
}
```

关键设计：通过 `HypervisorFactory` 根据虚拟化类型创建对应的 Host 实例，实现多虚拟化支持。

## 主机添加流程

### 添加主机的 FlowChain

添加主机是一个多步骤的 FlowChain 编排过程：

```java
// HostManagerImpl.java:418
FlowChain chain = FlowChainBuilder.newSimpleFlowChain();
chain.setName(String.format("add-host-%s", vo.getUuid()));
chain.then(new NoRollbackFlow() {
    String __name__ = "call-before-add-host-extension";
    // 调用 HostAddExtensionPoint.beforeAddHost()
}).then(new NoRollbackFlow() {
    String __name__ = "send-connect-host-message";
    // 发送 ConnectHostMsg 连接主机
}).then(new NoRollbackFlow() {
    String __name__ = "check-host-architecture";
    // 检查主机架构与集群架构是否匹配
}).then(new NoRollbackFlow() {
    String __name__ = "check-host-os-version";
    // 检查主机操作系统版本
}).then(new NoRollbackFlow() {
    String __name__ = "call-after-add-host-extension";
    // 调用 HostAddExtensionPoint.afterAddHost()
})
```

### 添加主机的并发控制

添加主机使用两级 ChainTask 实现并发控制：

```java
// HostManagerImpl.java:305
private void addHostInQueue(final AddHostMessage msg, 
        ReturnValueCompletion<HostInventory> completion) {
    thdf.chainSubmit(new ChainTask(completion) {
        @Override
        public String getSyncSignature() {
            return "batch-add-host";  // 全局串行
        }
        @Override
        protected int getSyncLevel() {
            return ThreadGlobalProperty.MAX_THREAD_NUM / 5;  // 并发度
        }
        // ...
    });
}
```

外层 `batch-add-host` 控制全局并发度，内层 `add-host-{ip}` 保证同一 IP 不会重复添加：

```java
// HostManagerImpl.java:341
private void doAddHostInQueue(final AddHostMessage msg, ...) {
    thdf.chainSubmit(new ChainTask(completion) {
        @Override
        public String getSyncSignature() {
            return String.format("add-host-%s", msg.getManagementIp());
        }
        // ...
    });
}
```

### 添加失败的处理

添加失败时，会从数据库中彻底删除主机记录，并通知扩展点：

```java
// HostManagerImpl.java:542
.error(new FlowErrorHandler(completion) {
    @Override
    public void handle(ErrorCode errCode, Map data) {
        HostVO nvo = dbf.reload(vo);
        dbf.remove(nvo);
        dbf.eoCleanup(HostVO.class, nvo.getUuid());
        
        CollectionUtils.safeForEach(
            pluginRgty.getExtensionList(FailToAddHostExtensionPoint.class),
            ext -> ext.failedToAddHost(inv, msg));
        completion.fail(errCode);
    }
})
```

## 主机连接流程

主机连接是 HostBase 中最核心的流程，由 `ConnectHostMsg` 触发。

### 连接 FlowChain 的五个步骤

```java
// HostBase.java:1283
final FlowChain flowChain = FlowChainBuilder.newShareFlowChain();
flowChain.setName(String.format("connect-host-%s", self.getUuid()));
flowChain.then(new ShareFlow() {
    @Override
    public void setup() {
        // Step 1: 检查连接条件
        flow(new NoRollbackFlow() {
            String __name__ = "check-conditions-of-connection";
            @Override
            public void run(final FlowTrigger trigger, Map data) {
                checkConnectConditions(
                    ConnectHostInfo.fromConnectHostMsg(msg), 
                    new Completion(trigger) { ... });
            }
        });

        // Step 2: 执行连接（子类实现）
        flow(new NoRollbackFlow() {
            String __name__ = "connect-host";
            @Override
            public void run(final FlowTrigger trigger, Map data) {
                changeConnectionState(HostStatusEvent.connecting);
                connectHook(ConnectHostInfo.fromConnectHostMsg(msg), 
                    new Completion(trigger) { ... });
            }
        });

        // Step 3: 调用 PreHostConnectExtensionPoint
        flow(new NoRollbackFlow() {
            String __name__ = "call-pre-connect-extensions";
            @Override
            public void run(FlowTrigger trigger, Map data) {
                FlowChain preConnectChain = FlowChainBuilder.newSimpleFlowChain();
                for (PreHostConnectExtensionPoint p : 
                        pluginRgty.getExtensionList(PreHostConnectExtensionPoint.class)) {
                    Flow flow = p.createPreHostConnectFlow(inv);
                    if (flow != null) {
                        preConnectChain.then(flow);
                    }
                }
                // ...
            }
        });

        // Step 4: 调用 PostHostConnectExtensionPoint
        flow(new NoRollbackFlow() {
            String __name__ = "call-post-connect-extensions";
            // 类似 Step 3，调用 PostHostConnectExtensionPoint
        });

        // Step 5: 重新计算主机容量
        flow(new NoRollbackFlow() {
            String __name__ = "recalculate-host-capacity";
            @Override
            public void run(FlowTrigger trigger, Map data) {
                RecalculateHostCapacityMsg msg = new RecalculateHostCapacityMsg();
                msg.setHostUuid(self.getUuid());
                bus.makeLocalServiceId(msg, HostAllocatorConstant.SERVICE_ID);
                bus.send(msg);
                trigger.next();
            }
        });
    }
});
```

### 连接成功的处理

```java
// HostBase.java:1405
done(new FlowDoneHandler(completion) {
    @Override
    public void handle(Map data) {
        changeConnectionState(HostStatusEvent.connected);
        tracker.trackHost(self.getUuid());
        
        CollectionUtils.safeForEach(
            pluginRgty.getExtensionList(HostAfterConnectedExtensionPoint.class),
            ext -> ext.afterHostConnected(getSelfInventory()));
        completion.success();
    }
});
```

### 连接失败的处理

```java
// HostBase.java:1417
error(new FlowErrorHandler(completion) {
    @Override
    public void handle(ErrorCode errCode, Map data) {
        changeConnectionState(HostStatusEvent.disconnected);
        if (!msg.isNewAdd()) {
            connectHostFailHook(errCode);
        }
        completion.fail(errCode);
    }
});
```

连接失败时，状态变为 Disconnected，并触发 `HostDisconnectedCanonicalEvent`。

### SingleFlight 防重入

连接操作使用 SingleFlight 机制防止同一主机的并发连接请求：

```java
// HostBase.java:1232
private void handle(final ConnectHostMsg msg) {
    thdf.singleFlightSubmit(new SingleFlightTask(msg)
        .setSyncSignature(String.format("connect-host-%s-single-flight", msg.getHostUuid()))
        .run((completion) -> connect(msg, new Completion(completion) { ... }))
        .done((result) -> {
            ConnectHostReply reply = new ConnectHostReply();
            if (!result.isSuccess()) {
                reply.setError(result.getErrorCode());
            }
            bus.reply(msg, reply);
        }));
}
```

## 主机状态机

### 双维度状态模型

ZStack 的主机状态分为两个独立维度：

| 维度 | 枚举 | 含义 | 控制方 |
|------|------|------|--------|
| **HostState** | Enabled / Disabled / Maintenance / PreMaintenance | 管理状态 | 管理员手动控制 |
| **HostStatus** | Connected / Disconnected / Connecting | 连接状态 | 系统自动检测 |

```java
// HostBase.java:151
protected void checkStatus() {
    if (HostStatus.Connected != self.getStatus()) {
        ErrorCode cause = err(HostErrors.HOST_IS_DISCONNECTED,
            "host[uuid:%s, name:%s] is in status[%s], cannot perform required operation",
            self.getUuid(), self.getName(), self.getStatus());
        throw new OperationFailureException(err(HostErrors.OPERATION_FAILURE_GC_ELIGIBLE, cause,
            "unable to do the operation because the host is in status of Disconnected"));
    }
}

// HostBase.java:158
protected void checkState() {
    if (HostState.PreMaintenance == self.getState() ||
        HostState.Maintenance == self.getState()) {
        throw new OperationFailureException(operr(
            "host[uuid:%s, name:%s] is in state[%s], cannot perform required operation",
            self.getUuid(), self.getName(), self.getState()));
    }
}
```

### 连接状态变更

```java
// HostBase.java:1191
protected boolean changeConnectionState(HostStatusEvent event) {
    HostStatus before = self.getStatus();
    HostStatus next = before.nextStatus(event);
    if (before == next) {
        return false;
    }
    self.setStatus(next);
    self = dbf.updateAndRefresh(self);
    
    // 发送 CanonicalEvent
    HostStatusChangedData data = new HostStatusChangedData();
    data.setHostUuid(self.getUuid());
    data.setNewStatus(next.toString());
    data.setOldStatus(before.toString());
    evtf.fire(HostCanonicalEvents.HOST_STATUS_CHANGED_PATH, data);
    
    // 通知扩展点
    CollectionUtils.safeForEach(
        pluginRgty.getExtensionList(AfterChangeHostStatusExtensionPoint.class),
        ext -> ext.afterChangeHostStatus(self.getUuid(), before, next));
    return true;
}
```

### 管理状态变更

管理状态变更通过 `ChangeHostStateMsg` 处理，使用 ChainTask 保证串行：

```java
// HostBase.java:1455
private void handle(final ChangeHostStateMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getSyncSignature() {
            return String.format("change-host-state-%s", self.getUuid());
        }
        @Override
        public void run(SyncTaskChain chain) {
            doHostStateChange(msg, new Completion(msg, chain) { ... });
        }
    });
}
```

## 维护模式

### 维护模式流程

进入维护模式（PreMaintenance）时，需要处理主机上运行的虚拟机：

```java
// HostBase.java:361
protected void maintenanceHook(ChangeHostStateMsg changeHostStateMsg, 
        final Completion completion) {
    FlowChain chain = FlowChainBuilder.newShareFlowChain();
    
    // 获取主机上所有运行中的 VM
    List<String> operateVmUuids = Q.New(VmInstanceVO.class)
        .select(VmInstanceVO_.uuid)
        .eq(VmInstanceVO_.hostUuid, self.getUuid())
        .notEq(VmInstanceVO_.state, VmInstanceState.Unknown)
        .listValues();
    
    // 收集维护策略：迁移 or 停止
    Map<HostMaintenancePolicy, Set<String>> policyVmMap = map(
        e(HostMaintenancePolicy.MigrateVm, new HashSet<>(operateVmUuids)),
        e(HostMaintenancePolicy.StopVm, new HashSet<>()));
    
    for (HostMaintenancePolicyExtensionPoint ext : 
            pluginRgty.getExtensionList(HostMaintenancePolicyExtensionPoint.class)) {
        Map<String, HostMaintenancePolicy> vmUuidPolicyMap = 
            ext.getHostMaintenanceVmOperationPolicy(getSelfInventory());
        vmUuidPolicyMap.forEach((vmUuid, policy) -> 
            policyVmMap.get(policy).add(vmUuid));
    }
    
    // StopVm 策略优先级高于 MigrateVm
    policyVmMap.get(HostMaintenancePolicy.MigrateVm)
        .removeAll(policyVmMap.get(HostMaintenancePolicy.StopVm));
}
```

维护模式的核心设计：
1. **策略可扩展**：通过 `HostMaintenancePolicyExtensionPoint` 让插件决定每个 VM 的维护策略
2. **StopVm 优先**：如果某个 VM 被指定为 StopVm 策略，则不会出现在 MigrateVm 集合中
3. **批量迁移**：迁移操作按 `getVmMigrateQuantity()` 控制并发度

## 管理节点与主机的通信

### HTTP 通信模型

管理节点通过 HTTP 与 kvmagent 通信（端口 7070）。HostBase 的 `connectHook()` 由子类 KVMHost 实现，会向 kvmagent 发送 HTTP 请求建立连接。

### 主机追踪（HostTracker）

连接成功后，通过 `tracker.trackHost()` 注册主机追踪：

```java
// HostBase.java:1409
tracker.trackHost(self.getUuid());
```

HostTracker 负责定期 ping 主机，检测主机是否存活。

## 周期任务

### 容量报告任务

HostManagerImpl 启动时注册周期性容量报告任务：

```java
// HostManagerImpl.java:778
private synchronized void startReportHostCapacityTask() {
    reportHostCapacityTask = thdf.submitPeriodicTask(new PeriodicTask() {
        @Override
        public long getInterval() {
            return getReportInterval();  // 由 HostGlobalConfig 控制
        }
        @Override
        public void run() {
            reportHostCapacity();
        }
    });
}
```

`reportHostCapacity()` 遍历所有 Connected 状态的主机，发送 `CheckHostCapacityMsg` 和 `RecalculateHostCapacityMsg`：

```java
// HostManagerImpl.java:805
private void reportHostCapacity() {
    List<String> hostUuids = Q.New(HostVO.class)
        .select(HostVO_.uuid)
        .eq(HostVO_.status, HostStatus.Connected)
        .listValues();
    
    new While<>(hostUuids).step((hostUuid, completion) -> {
        CheckHostCapacityMsg msg = new CheckHostCapacityMsg();
        msg.setHostUuid(hostUuid);
        bus.makeTargetServiceIdByResourceUuid(msg, HostConstant.SERVICE_ID, hostUuid);
        bus.send(msg, new CloudBusCallBack(completion) {
            @Override
            public void run(MessageReply rly) {
                RecalculateHostCapacityMsg rmsg = new RecalculateHostCapacityMsg();
                rmsg.setHostUuid(hostUuid);
                bus.makeLocalServiceId(rmsg, HostAllocatorConstant.SERVICE_ID);
                bus.send(rmsg);
                completion.done();
            }
        });
    }, 15).run(new NopeWhileDoneCompletion());
}
```

### IPMI 电源状态刷新

```java
// HostManagerImpl.java:720
private synchronized void startRefreshHostPowerStatusTask() {
    refreshHostPowerStatusTask = thdf.submitPeriodicTask(new PeriodicTask() {
        @Override
        public void run() {
            List<HostIpmiVO> ipmis = Q.New(HostIpmiVO.class).list();
            ipmis = ipmis.stream()
                .filter(i -> destMaker.isManagedByUs(i.getUuid()))
                .collect(Collectors.toList());
            new While<>(ipmis).step((ipmi, comp) -> {
                refreshHostPowerStatus(ipmi);
                comp.done();
            }, 10).run(new NopeWhileDoneCompletion());
        }
    });
}
```

## 管理节点接管

当管理节点加入或离开集群时，需要重新分配主机的管理权：

```java
// HostManagerImpl.java:927
@Override
@SyncThread
public void nodeLeft(ManagementNodeInventory inv) {
    logger.debug(String.format("Management node[uuid:%s] left, node[uuid:%s] starts to take over hosts",
        inv.getUuid(), Platform.getManagementServerId()));
    loadHost(true);
}
```

### 主机加载策略

```java
// HostManagerImpl.java:1000
private void loadHost(boolean skipConnected) {
    Bucket hosts = getHostManagedByUs();
    List<String> connected = hosts.get(0);
    List<String> disconnected = hosts.get(1);
    List<String> hostsToLoad = new ArrayList<>();
    
    if (HostGlobalConfig.RECONNECT_ALL_ON_BOOT.value(Boolean.class)) {
        hostsToLoad.addAll(connected);
        hostsToLoad.addAll(disconnected);
    } else {
        hostsToLoad.addAll(disconnected);
        tracker.trackHost(connected);  // 仅追踪已连接的主机
    }
    
    // 按优先级排序
    final List<String> hostsToLoadSorted = sortWithPriority(hostsToLoad);
    
    // 并行发送 ConnectHostMsg
    bus.send(msgs, HostGlobalConfig.HOST_LOAD_PARALLELISM_DEGREE.value(Integer.class),
        new CloudBusSteppingCallback(null) { ... });
}
```

关键设计：
1. **ResourceDestinationMaker**：决定每台主机由哪个管理节点管理
2. **优先级排序**：通过 `HostPriorityCaculator` 扩展点计算主机连接优先级
3. **并行度控制**：`HOST_LOAD_PARALLELISM_DEGREE` 控制并行连接数

## 主存储断连导致主机断连

HostManagerImpl 监听主存储状态变化事件，当主存储断连且主机无可用主存储时，自动断开主机：

```java
// HostManagerImpl.java:840
private void setupCanonicalEvents() {
    evtf.on(PrimaryStorageCanonicalEvent.PRIMARY_STORAGE_HOST_STATUS_CHANGED_PATH, 
        new EventCallback() {
            @Override
            protected void run(Map tokens, Object data) {
                PrimaryStorageCanonicalEvent.PrimaryStorageHostStatusChangeData d = ...;
                if (d.getNewStatus() == PrimaryStorageHostStatus.Disconnected &&
                    d.getOldStatus() != PrimaryStorageHostStatus.Disconnected &&
                    noStorageAccessible(d.getHostUuid())) {
                    // 发送断连消息
                    ChangeHostConnectionStateMsg msg = new ChangeHostConnectionStateMsg();
                    msg.setHostUuid(d.getHostUuid());
                    msg.setConnectionStateEvent(HostStatusEvent.disconnected.toString());
                    bus.makeTargetServiceIdByResourceUuid(msg, HostConstant.SERVICE_ID, d.getHostUuid());
                    bus.send(msg);
                    
                    // 触发断连事件
                    new HostDisconnectedCanonicalEvent(d.getHostUuid(), ...).fire();
                }
            }
        });
}
```

`noStorageAccessible()` 检查主机是否所有挂载的主存储都已断连：

```java
// HostManagerImpl.java:864
private boolean noStorageAccessible(String hostUuid) {
    List<String> attachedPsUuids = SQL.New(
        "select distinct ref.primaryStorageUuid from PrimaryStorageClusterRefVO ref, HostVO h " +
        "where h.uuid =:hostUuid and ref.clusterUuid = h.clusterUuid", String.class)
        .param("hostUuid", hostUuid).list();
    
    long inaccessiblePsCount = Q.New(PrimaryStorageHostRefVO.class)
        .eq(PrimaryStorageHostRefVO_.hostUuid, hostUuid)
        .eq(PrimaryStorageHostRefVO_.status, PrimaryStorageHostStatus.Disconnected)
        .in(PrimaryStorageHostRefVO_.primaryStorageUuid, attachedPsUuids)
        .count();
    
    return inaccessiblePsCount == attachedPsCount && attachedPsCount > 0;
}
```

## HypervisorFactory 扩展机制

HostManagerImpl 通过 `HypervisorFactory` 支持多种虚拟化类型：

```java
// HostManagerImpl.java:680
private void populateExtensions() {
    for (HypervisorFactory f : pluginRgty.getExtensionList(HypervisorFactory.class)) {
        HypervisorFactory old = hypervisorFactories.get(f.getHypervisorType().toString());
        if (old != null) {
            throw new CloudRuntimeException(String.format(
                "duplicate HypervisorFactory[%s, %s] for hypervisor type[%s]",
                old.getClass().getName(), f.getClass().getName(), f.getHypervisorType()));
        }
        hypervisorFactories.put(f.getHypervisorType().toString(), f);
    }
}
```

每种虚拟化类型（KVM、VMware 等）提供自己的 `HypervisorFactory`，负责：
1. 创建对应的 HostBase 子类实例（如 KVMHost）
2. 创建主机时的特殊处理（`createHost()`）
3. 检查新添加主机（`checkNewAddedHost()`）

## 关键扩展点

| 扩展点 | 触发时机 | 用途 |
|--------|----------|------|
| `HostAddExtensionPoint` | 主机添加前后 | 验证/初始化新主机 |
| `PreHostConnectExtensionPoint` | 连接前 | 连接前的准备工作 |
| `PostHostConnectExtensionPoint` | 连接后 | 连接后的初始化 |
| `HostAfterConnectedExtensionPoint` | 连接成功后 | 通知其他模块 |
| `HostMaintenanceExtensionPoint` | 维护模式前 | 自定义维护检查 |
| `HostMaintenancePolicyExtensionPoint` | 维护模式中 | 决定 VM 迁移/停止策略 |
| `AfterChangeHostStatusExtensionPoint` | 连接状态变更后 | 响应状态变化 |
| `FailToAddHostExtensionPoint` | 添加失败后 | 清理/通知 |
| `HostPriorityCaculator` | 主机加载排序 | 决定连接优先级 |

## 总结

主机管理的核心设计要点：

1. **FlowChain 编排**：添加和连接主机都使用 FlowChain 编排多步骤流程，支持扩展点注入
2. **双维度状态**：HostState（管理状态）和 HostStatus（连接状态）分离，互不影响
3. **HypervisorFactory**：通过工厂模式支持多虚拟化类型，每种类型提供自己的 HostBase 子类
4. **SingleFlight + ChainTask**：连接操作使用 SingleFlight 防重入，状态变更使用 ChainTask 保证串行
5. **管理节点接管**：通过 ResourceDestinationMaker 分配主机归属，节点离开时自动接管
6. **事件驱动**：主存储断连事件可触发主机断连，保证数据一致性
7. **周期任务**：容量报告和 IPMI 电源状态定期刷新，保持数据实时性
