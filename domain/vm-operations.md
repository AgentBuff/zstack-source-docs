# 18 - VM 运维操作

VM 创建完成后，ZStack 提供了丰富的运维操作，包括启动、停止、重启、销毁、迁移、挂载/卸载云盘、挂载网卡等。所有操作都在 `VmInstanceBase` 中实现，使用 FlowChain 编排，并通过 `ThreadFacade.chainSubmit()` 保证同一 VM 的操作串行执行。

## 操作总览

| 操作 | API 消息 | 核心方法 | FlowChain |
|------|----------|----------|-----------|
| 启动 | APIStartVmInstanceMsg | startVm() | getStartVmWorkFlowChain() |
| 停止 | APIStopVmInstanceMsg | stopVm() | 直接发送 StopVmOnHypervisorMsg |
| 重启 | APIRebootVmInstanceMsg | rebootVm() | 先停后启 |
| 销毁 | APIDestroyVmInstanceMsg | destroyVm() | CascadeFacade 级联删除 |
| 迁移 | APIMigrateVmMsg | migrateVm() | getMigrateVmWorkFlowChain() |
| 挂载云盘 | AttachDataVolumeToVmMsg | attachDataVolume() | VmAttachVolumeOnHypervisorFlow |
| 卸载云盘 | DetachDataVolumeFromVmMsg | detachDataVolume() | DetachVolumeFromVmOnHypervisorMsg |
| 挂载网卡 | VmAttachNicMsg | attachNicInQueue() | VmAllocateNicFlow + 热插 |

## startVm — 启动虚拟机

### 入口

```java
protected void handle(final APIStartVmInstanceMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getName() {
            return String.format("start-vm-%s", self.getUuid());
        }

        @Override
        public String getSyncSignature() {
            return syncThreadName;
        }

        @Override
        public void run(SyncTaskChain chain) {
            startVm(msg, chain);
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7597-7614

### 启动流程

启动 VM 使用 `getStartVmWorkFlowChain()` 获取 FlowChain，流程与创建 VM 类似但更简单：

1. **状态校验**：检查 VM 当前状态是否允许启动
2. **状态变更**：`changeVmStateInDb(VmInstanceStateEvent.starting)`
3. **构建 VmInstanceSpec**：`buildSpecFromInventory(inv, VmOperation.Start)`
4. **执行 FlowChain**：分配主机（如果需要）→ 准备云盘 → 准备网络 → 在 Hypervisor 上启动
5. **状态变更**：`changeVmStateInDb(VmInstanceStateEvent.running)`

```java
protected void startVm(final StartVmInstanceMsg msg, final SyncTaskChain taskChain) {
    startVm(msg, new Completion(taskChain) {
        @Override
        public void success() {
            VmInstanceInventory inv = VmInstanceInventory.valueOf(self);
            StartVmInstanceReply reply = new StartVmInstanceReply();
            reply.setInventory(inv);
            bus.reply(msg, reply);
            taskChain.next();
        }

        @Override
        public void fail(ErrorCode errorCode) {
            StartVmInstanceReply reply = new StartVmInstanceReply();
            reply.setError(err(VmErrors.START_ERROR, errorCode, errorCode.getDetails()));
            bus.reply(msg, reply);
            taskChain.next();
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7552-7571

## stopVm — 停止虚拟机

### 入口

```java
private void handle(final StopVmInstanceMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getName() {
            return String.format("stop-vm-%s", self.getUuid());
        }

        @Override
        public String getSyncSignature() {
            return syncThreadName;
        }

        @Override
        public void run(SyncTaskChain chain) {
            stopVm(msg, chain);
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:2762-2779

停止 VM 的流程相对简单，直接发送 `StopVmOnHypervisorMsg` 到 Host 服务，然后更新 VM 状态为 Stopped。

## rebootVm — 重启虚拟机

### 入口

```java
private void handle(final RebootVmInstanceMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getName() {
            return String.format("reboot-vm-%s", self.getUuid());
        }

        @Override
        public String getSyncSignature() {
            return syncThreadName;
        }

        @Override
        public void run(SyncTaskChain chain) {
            rebootVm(msg, chain);
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:2722-2739

重启 VM 的实现是先停后启：

```java
private void rebootVm(final RebootVmInstanceMsg msg, final SyncTaskChain chain) {
    rebootVm(msg, new Completion(chain) {
        @Override
        public void success() {
            RebootVmInstanceReply reply = new RebootVmInstanceReply();
            VmInstanceInventory inv = VmInstanceInventory.valueOf(self);
            reply.setInventory(inv);
            bus.reply(msg, reply);
            chain.next();
        }

        @Override
        public void fail(ErrorCode errorCode) {
            RebootVmInstanceReply reply = new RebootVmInstanceReply();
            reply.setError(err(VmErrors.REBOOT_ERROR, errorCode, errorCode.getDetails()));
            bus.reply(msg, reply);
            chain.next();
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:2741-2760

## destroyVm — 销毁虚拟机

销毁 VM 是最复杂的运维操作之一，涉及 CascadeFacade 的级联删除机制。

### 入口

```java
protected void handle(final APIDestroyVmInstanceMsg msg) {
    final APIDestroyVmInstanceEvent evt = new APIDestroyVmInstanceEvent(msg.getId());
    destroyVm(msg, new Completion(msg) {
        @Override
        public void success() {
            bus.publish(evt);
        }

        @Override
        public void fail(ErrorCode errorCode) {
            evt.setError(errorCode);
            bus.publish(evt);
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7616-7630

### 级联删除流程

```java
private void destroyVm(APIDestroyVmInstanceMsg msg, final Completion completion) {
    final String issuer = VmInstanceVO.class.getSimpleName();
    final List<VmDeletionStruct> ctx = new ArrayList<VmDeletionStruct>();
    VmDeletionStruct s = new VmDeletionStruct();
    s.setInventory(getSelfInventory());
    s.setDeletionPolicy(deletionPolicyMgr.getDeletionPolicy(self.getUuid()));
    ctx.add(s);

    FlowChain chain = FlowChainBuilder.newSimpleFlowChain();
    chain.setName(String.format("delete-vm-%s", msg.getUuid()));

    if (msg.getDeletionMode() == APIDeleteMessage.DeletionMode.Permissive) {
        // 宽容模式：先检查再删除
        chain.then(new NoRollbackFlow() {
            @Override
            public void run(final FlowTrigger trigger, Map data) {
                casf.asyncCascade(CascadeConstant.DELETION_CHECK_CODE, issuer, ctx,
                    new Completion(trigger) {
                        @Override public void success() { trigger.next(); }
                        @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
                    });
            }
        }).then(new NoRollbackFlow() {
            @Override
            public void run(final FlowTrigger trigger, Map data) {
                casf.asyncCascade(CascadeConstant.DELETION_DELETE_CODE, issuer, ctx,
                    new Completion(trigger) {
                        @Override public void success() { trigger.next(); }
                        @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
                    });
            }
        });
    } else {
        // 强制模式：直接删除
        chain.then(new NoRollbackFlow() {
            @Override
            public void run(final FlowTrigger trigger, Map data) {
                casf.asyncCascade(CascadeConstant.DELETION_FORCE_DELETE_CODE, issuer, ctx,
                    new Completion(trigger) {
                        @Override public void success() { trigger.next(); }
                        @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
                    });
            }
        });
    }

    chain.done(new FlowDoneHandler(msg) {
        @Override
        public void handle(Map data) {
            casf.asyncCascadeFull(CascadeConstant.DELETION_CLEANUP_CODE, issuer, ctx, new NopeCompletion());
            completion.success();
        }
    }).error(new FlowErrorHandler(msg) {
        @Override
        public void handle(ErrorCode errCode, Map data) {
            completion.fail(err(SysErrors.DELETE_RESOURCE_ERROR, errCode, errCode.getDetails()));
        }
    }).start();
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7632-7705

### 级联删除的三阶段

CascadeFacade 的级联删除分为三个阶段：

| 阶段 | Code | 说明 |
|------|------|------|
| 检查 | DELETION_CHECK_CODE | 检查是否可以删除（如 VM 上有正在运行的服务） |
| 删除 | DELETION_DELETE_CODE | 执行实际删除操作 |
| 清理 | DELETION_CLEANUP_CODE | 清理残留资源 |

### 删除策略

`doDestroy()` 方法根据删除策略执行不同的操作：

```java
protected void doDestroy(final VmInstanceDeletionPolicy deletionPolicy, Message msg, final Completion completion) {
    final VmInstanceInventory inv = VmInstanceInventory.valueOf(self);
    extEmitter.beforeDestroyVm(inv);

    destroy(deletionPolicy, msg, new Completion(completion) {
        @Override
        public void success() {
            if (deletionPolicy == VmInstanceDeletionPolicy.Direct) {
                if (self.getState() != VmInstanceState.Destroyed) {
                    changeVmStateInDb(VmInstanceStateEvent.destroyed);
                }
                callVmJustBeforeDeleteFromDbExtensionPoint();
                dbf.removeCollection(self.getVmCdRoms(), VmCdRomVO.class);
                dbf.remove(getSelf());
                dbf.eoCleanup(VmInstanceVO.class, self.getUuid());
            } else if (deletionPolicy == VmInstanceDeletionPolicy.DBOnly
                    || deletionPolicy == VmInstanceDeletionPolicy.KeepVolume) {
                String accountUuid = acntMgr.getOwnerAccountUuidOfResource(inv.getUuid());
                new SQLBatch() {
                    @Override
                    protected void scripts() {
                        callVmJustBeforeDeleteFromDbExtensionPoint();
                        sql(VmNicVO.class).eq(VmNicVO_.vmInstanceUuid, self.getUuid()).hardDelete();
                        sql(VolumeVO.class).eq(VolumeVO_.vmInstanceUuid, self.getUuid())
                                .eq(VolumeVO_.type, VolumeType.Root).hardDelete();
                        sql(VmCdRomVO.class).eq(VmCdRomVO_.vmInstanceUuid, self.getUuid()).hardDelete();
                        sql(VmInstanceVO.class).eq(VmInstanceVO_.uuid, self.getUuid()).hardDelete();
                    }
                }.execute();
                callVmJustAfterDeleteFromDbExtensionPoint(inv, accountUuid);
            } else if (deletionPolicy == VmInstanceDeletionPolicy.Delay) {
                changeVmStateInDb(VmInstanceStateEvent.destroyed);
            } else if (deletionPolicy == VmInstanceDeletionPolicy.Never) {
                changeVmStateInDb(VmInstanceStateEvent.destroyed);
            }

            extEmitter.afterDestroyVm(inv);
            completion.success();
        }
        // ...
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:2607-2660

| 删除策略 | 说明 |
|----------|------|
| Direct | 直接删除：停止 VM + 删除云盘 + 删除数据库记录 |
| DBOnly | 仅删除数据库记录，保留物理资源 |
| KeepVolume | 删除数据库记录但保留云盘 |
| Delay | 延迟删除：标记为 Destroyed，等待后续清理 |
| Never | 仅标记为 Destroyed，不删除任何资源 |

## migrateVm — 迁移虚拟机

### 入口

```java
protected void handle(final APIMigrateVmMsg msg) {
    thdf.chainSubmit(new ChainTask(msg) {
        @Override
        public String getName() {
            return String.format("migrate-vm-%s", self.getUuid());
        }

        @Override
        public String getSyncSignature() {
            return syncThreadName;
        }

        @Override
        public void run(final SyncTaskChain chain) {
            reportProgress("0");
            migrateVm(msg, new Completion(chain) { /* ... */ });
        }
    });
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:7082-7099

### 迁移流程

```java
protected void migrateVm(final MigrateVmMessage msg, final Completion completion) {
    refreshVO();
    ErrorCode allowed = validateOperationByState((Message) msg, self.getState(), VmErrors.MIGRATE_ERROR);
    if (allowed != null) {
        completion.fail(allowed);
        return;
    }

    VmInstanceInventory inv = VmInstanceInventory.valueOf(self);
    String originState = inv.getState();

    FlowChain chain = FlowChainBuilder.newSimpleFlowChain();
    chain.setName(String.format("migrate-vm-%s", self.getUuid()));

    // Step 1: 调用前置扩展点
    chain.then(new NoRollbackFlow() {
        String __name__ = "call-pre-vm-migration-extension";
        @Override
        public void run(FlowTrigger trigger, Map data) {
            new While<>(pluginRgty.getExtensionList(VmPreMigrationExtensionPoint.class))
                .each((extension, whileCompletion) ->
                    extension.preVmMigration(inv, VmMigrationType.HostMigration,
                        msg.getHostUuid(), new Completion(whileCompletion) {
                            @Override public void success() { whileCompletion.done(); }
                            @Override public void fail(ErrorCode errorCode) {
                                whileCompletion.addError(errorCode);
                                whileCompletion.allDone();
                            }
                        }))
                .run(new WhileDoneCompletion(trigger) {
                    @Override
                    public void done(ErrorCodeList errorCodeList) {
                        if (!errorCodeList.getCauses().isEmpty()) {
                            trigger.fail(errorCodeList);
                            return;
                        }
                        trigger.next();
                    }
                });
        }
    });

    // Step 2: 执行迁移
    chain.then(new NoRollbackFlow() {
        String __name__ = String.format("migrate-vm-%s", self.getUuid());
        @Override
        public void run(FlowTrigger trigger, Map data) {
            doMigrateVm(msg, new Completion(trigger) {
                @Override public void success() { trigger.next(); }
                @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
            });
        }
    });

    chain.done(/* ... */).error(/* ... */).start();
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:6913-6986

### doMigrateVm — 实际迁移执行

```java
private void doMigrateVm(final MigrateVmMessage msg, final Completion completion) {
    VmInstanceInventory inv = VmInstanceInventory.valueOf(self);
    final VmInstanceSpec spec = buildSpecFromInventory(inv, VmOperation.Migrate);

    final VmInstanceState originState = self.getState();
    changeVmStateInDb(VmInstanceStateEvent.migrating);
    spec.setMessage((Message) msg);
    spec.setAllocationScene(msg.getAllocationScene());

    FlowChain chain = getMigrateVmWorkFlowChain(inv);
    setFlowMarshaller(chain);

    String lastHostUuid = self.getHostUuid();
    chain.setName(String.format("do-migrate-vm-%s", self.getUuid()));
    chain.getData().put(VmInstanceConstant.Params.VmInstanceSpec.toString(), spec);

    // 迁移后同步 VM 状态
    chain.then(new NoRollbackFlow() {
        final String __name__ = String.format("sync-vm-%s-stat-after-migrate", self.getUuid());

        @Override
        public void run(FlowTrigger trigger, Map data) {
            HostInventory host = spec.getDestHost();
            checkState(host.getUuid(), new NoErrorCompletion(completion) {
                @Override
                public void done() {
                    SQL.New(VmInstanceVO.class).eq(VmInstanceVO_.uuid, self.getUuid())
                            .set(VmInstanceVO_.zoneUuid, host.getZoneUuid())
                            .set(VmInstanceVO_.clusterUuid, host.getClusterUuid())
                            .set(VmInstanceVO_.lastHostUuid, lastHostUuid)
                            .set(VmInstanceVO_.hostUuid, host.getUuid())
                            .update();
                    self = dbf.reload(self);
                    trigger.next();
                }
            });
        }
    });

    chain.then(new VmMigratePostCallExtensionFlow());

    chain.done(new FlowDoneHandler(completion) {
        @Override
        public void handle(final Map data) {
            VmInstanceInventory vm = VmInstanceInventory.valueOf(self);
            extEmitter.afterMigrateVm(vm, vm.getLastHostUuid(), new NoErrorCompletion(completion) {
                @Override
                public void done() { completion.success(); }
            });
        }
    }).error(new FlowErrorHandler(completion) {
        @Override
        public void handle(final ErrorCode errCode, Map data) {
            String destHostUuid = spec.getDestHost().getUuid().equals(lastHostUuid)
                    ? null : spec.getDestHost().getUuid();
            extEmitter.failedToMigrateVm(VmInstanceInventory.valueOf(self), destHostUuid, errCode,
                new NoErrorCompletion(completion) {
                    @Override
                    public void done() {
                        if (!HostErrors.FAILED_TO_MIGRATE_VM_ON_HYPERVISOR.isEqual(errCode.getCode())) {
                            changeVmStateInDb(originState.getDrivenEvent());
                            completion.fail(errCode);
                            return;
                        }
                        // Hypervisor 层面迁移失败，检查 VM 实际状态
                        checkState(originalCopy.getHostUuid(), new NoErrorCompletion(completion) {
                            @Override
                            public void done() { completion.fail(errCode); }
                        });
                    }
                });
        }
    }).start();
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:6988-7061

迁移失败时的处理特别值得注意：如果 Hypervisor 层面迁移失败（`FAILED_TO_MIGRATE_VM_ON_HYPERVISOR`），ZStack 不会简单地回滚状态，而是通过 `checkState()` 检查 VM 在原主机上的实际状态，确保状态与实际一致。

## attachDataVolume — 挂载云盘

### 入口

```java
protected void attachDataVolume(final AttachDataVolumeToVmMsg msg, final NoErrorCompletion completion) {
    final AttachDataVolumeToVmReply reply = new AttachDataVolumeToVmReply();
    refreshVO();
    ErrorCode err = validateOperationByState(msg, self.getState(), VmErrors.ATTACH_VOLUME_ERROR);
    if (err != null) {
        throw new OperationFailureException(err);
    }

    final VolumeInventory volume = msg.getVolume();
    final VmInstanceInventory vmInv = VmInstanceInventory.valueOf(self);

    new VmAttachVolumeValidator().validate(vmInv, volume.getUuid());

    VmInstanceSpec spec = new VmInstanceSpec();
    spec.setMessage(msg);
    spec.setVmInventory(vmInv);
    spec.setCurrentVmOperation(VmOperation.AttachVolume);
    spec.setDestDataVolumes(list(volume));

    FlowChain chain;
    if (volume.getStatus().equals(VolumeStatus.Ready.toString())) {
        // 云盘已就绪：直接在 Hypervisor 上挂载
        chain = FlowChainBuilder.newSimpleFlowChain();
        chain.then(new VmAssignDeviceIdToAttachingVolumeFlow());
        chain.then(new VmAttachVolumeOnHypervisorFlow());
    } else {
        // 云盘未就绪：需要先创建
        chain = getAttachUninstantiatedVolumeWorkFlowChain(spec.getVmInventory());
    }

    setFlowMarshaller(chain);

    // 插入前置扩展点 Flow
    chain.insert(new NoRollbackFlow() {
        final String __name__ = "call-pre-attach-volume-extension";
        @Override
        public void run(FlowTrigger trigger, Map data) {
            extEmitter.preAttachVolume(getSelfInventory(), volume, new Completion(trigger) {
                @Override public void success() { trigger.next(); }
                @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
            });
        }
    });

    chain.setName(String.format("vm-%s-attach-volume-%s", self.getUuid(), volume.getUuid()));
    chain.getData().put(VmInstanceConstant.Params.VmInstanceSpec.toString(), spec);
    chain.getData().put(VmInstanceConstant.Params.AttachingVolumeInventory.toString(), volume);

    chain.done(new FlowDoneHandler(msg, completion) {
        @Override
        public void handle(Map data) {
            extEmitter.afterAttachVolume(getSelfInventory(), volume);
            reply.setHypervisorType(self.getHypervisorType());
            bus.reply(msg, reply);
            completion.done();
        }
    }).error(new FlowErrorHandler(msg, completion) {
        @Override
        public void handle(final ErrorCode errCode, Map data) {
            extEmitter.failedToAttachVolume(getSelfInventory(), volume, errCode, data);
            reply.setError(err(VmErrors.ATTACH_VOLUME_ERROR, errCode, errCode.getDetails()));
            bus.reply(msg, reply);
            completion.done();
        }
    }).start();
}
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:6820-6911

挂载云盘的两种场景：

| 场景 | FlowChain | 说明 |
|------|-----------|------|
| 云盘已就绪 (Ready) | VmAssignDeviceIdToAttachingVolumeFlow → VmAttachVolumeOnHypervisorFlow | 分配设备 ID + 热插 |
| 云盘未就绪 | getAttachUninstantiatedVolumeWorkFlowChain() | 先创建云盘再挂载 |

## detachDataVolume — 卸载云盘

### 卸载流程

```java
FlowChain chain = new SimpleFlowChain();
chain.setName(String.format("detach-volume-%s-from-vm-%s", self.getUuid(), msg.getVmInstanceUuid()));

chain.then(new NoRollbackFlow() {
    String __name__ = "pre-detach-volume";
    @Override
    public void run(FlowTrigger trigger, Map data) {
        extEmitter.beforeDetachVolume(getSelfInventory(), volume);
        trigger.next();
    }
}).then(new NoRollbackFlow() {
    String __name__ = "before-detaching-volume";
    @Override
    public void run(FlowTrigger trigger, Map data) {
        extEmitter.preDetachVolume(getSelfInventory(), volume, new Completion(trigger) {
            @Override public void success() { trigger.next(); }
            @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
        });
    }
}).then(new Flow() {
    String __name__ = "detach-volume-from-vm-on-hypervisor";

    @Override
    public boolean skip(Map data) {
        return self.getHostUuid() == null && self.getLastHostUuid() == null;
    }

    @Override
    public void run(FlowTrigger trigger, Map data) {
        String hostUuid = self.getHostUuid() == null ? self.getLastHostUuid() : self.getHostUuid();
        DetachVolumeFromVmOnHypervisorMsg innerMsg = new DetachVolumeFromVmOnHypervisorMsg();
        innerMsg.setVmInventory(VmInstanceInventory.valueOf(self));
        innerMsg.setInventory(volume);
        innerMsg.setHostUuid(hostUuid);
        bus.makeTargetServiceIdByResourceUuid(innerMsg, HostConstant.SERVICE_ID, hostUuid);
        bus.send(innerMsg, new CloudBusCallBack(trigger) {
            @Override
            public void run(MessageReply innerReply) {
                if (innerReply.isSuccess()) {
                    trigger.next();
                    return;
                }
                trigger.fail(innerReply.getError());
            }
        });
    }

    @Override
    public void rollback(FlowRollback trigger, Map data) {
        extEmitter.failedToDetachVolume(getSelfInventory(), volume, trigger.getErrorCode());
        trigger.rollback();
    }
}).then(new NoRollbackFlow() {
    String __name__ = "update-volume-in-database";
    @Override
    public void run(FlowTrigger trigger, Map data) {
        vvo.setLastDetachDate(Timestamp.valueOf(LocalDateTime.now()));
        vvo.setLastVmInstanceUuid(msg.getVmInstanceUuid());
        dbf.update(vvo);
        trigger.next();
    }
}).then(new NoRollbackFlow() {
    String __name__ = "after-detaching-volume";
    @Override
    public void run(FlowTrigger trigger, Map data) {
        extEmitter.afterDetachVolume(getSelfInventory(), volume, new Completion(trigger) {
            @Override public void success() { trigger.next(); }
            @Override public void fail(ErrorCode errorCode) { trigger.fail(errorCode); }
        });
    }
});
```

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:6720-6804

卸载云盘的 FlowChain 步骤：

1. **pre-detach-volume**：通知扩展点即将卸载
2. **before-detaching-volume**：调用 `preDetachVolume` 扩展点
3. **detach-volume-from-vm-on-hypervisor**：在 Hypervisor 上热拔云盘（如果 VM 不在运行则跳过）
4. **update-volume-in-database**：更新云盘的卸载时间和关联 VM
5. **after-detaching-volume**：通知扩展点卸载完成

## attachNic — 挂载网卡

### 入口

```java
private void handle(final VmAttachNicMsg msg) {
    final VmAttachNicReply reply = new VmAttachNicReply();
    attachNicInQueue(msg, msg.getL3NetworkUuid(), msg.isApplyToBackend(),
        new ReturnValueCompletion<VmNicInventory>(msg) {
            @Override
            public void success(VmNicInventory returnValue) {
                reply.setInventroy(returnValue);
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

> 源码位置：zstack/compute/src/main/java/org/zstack/compute/vm/VmInstanceBase.java:2581-2596

挂载网卡的流程与创建 VM 时的 VmAllocateNicFlow 类似，但额外需要在 Hypervisor 上热插网卡。

## 状态变更机制

所有 VM 操作都涉及状态变更，通过 `changeVmStateInDb()` 方法统一处理：

```java
// 状态变更会：
// 1. 更新数据库中的 VM 状态
// 2. 触发 VmCanonicalEvents 事件
// 3. 通知 VmStateChangedExtensionPoint 扩展点
changeVmStateInDb(VmInstanceStateEvent.starting);
```

VM 状态机的事件包括：

| 事件 | 状态转换 |
|------|----------|
| starting | Running → Starting |
| running | Starting → Running |
| stopping | Running → Stopping |
| stopped | Stopping → Stopped |
| rebooting | Running → Rebooting |
| migrating | Running → Migrating |
| destroyed | Running/Stopped → Destroyed |
| paused | Starting → Paused |

## 同步保证

所有 VM 操作都通过 `thdf.chainSubmit()` 提交到同步队列，保证同一 VM 的操作串行执行：

```java
thdf.chainSubmit(new ChainTask(msg) {
    @Override
    public String getSyncSignature() {
        return syncThreadName;  // 同一 VM 共享同一个签名
    }
    // ...
});
```

`syncThreadName` 在 VmInstanceBase 构造时设置，确保同一 VM 的所有操作（启动、停止、迁移等）都在同一个同步队列中执行，避免并发冲突。

## 总结

VM 运维操作的核心设计要点：

1. **FlowChain 编排**：复杂操作（迁移、挂载云盘）使用 FlowChain，简单操作（停止）直接发送消息
2. **CascadeFacade 级联删除**：销毁 VM 时自动级联删除关联资源
3. **多种删除策略**：Direct/DBOnly/KeepVolume/Delay/Never 满足不同场景
4. **迁移容错**：迁移失败时通过 `checkState()` 确保 VM 状态与实际一致
5. **Extension 通知**：所有操作前后都触发扩展点通知
6. **同步队列**：保证同一 VM 操作串行，避免并发冲突
