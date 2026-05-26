# SDN 控制器集成

ZStack 通过 SDN 控制器集成支持高级网络功能，如 OVN、H3C VCFC、Tungsten Fabric 等。本章分析 SDN 控制器框架的设计与实现。

## SDN 控制器架构

```
┌──────────────────────────────────────────────────────┐
│           SdnControllerManagerImpl (876行)             │
│  ├── SDN 控制器 CRUD                                  │
│  ├── L2 网络创建/删除时同步 SDN                        │
│  ├── VM 网卡添加/删除时同步 SDN                        │
│  ├── IP 范围变更时同步 SDN                             │
│  └── 安全组委托给 SDN                                 │
├──────────────────────────────────────────────────────┤
│  SdnControllerFactory (扩展点)                         │
│  ├── getSdnController()       — 控制器实例             │
│  ├── getSdnControllerL2()     — L2 网络操作            │
│  ├── getSdnControllerL3()     — L3 网络操作            │
│  ├── getSdnControllerSecurityGroup() — 安全组操作      │
│  ├── getSdnControllerDhcp()   — DHCP 操作              │
│  └── getSyncChain()           — 同步链                 │
├──────────────────────────────────────────────────────┤
│  支持的 SDN 类型                                       │
│  ├── OvnDpdk    — OVN + DPDK                         │
│  ├── H3C VCFC   — 华为 H3C                            │
│  ├── Tungsten   — Tungsten Fabric / Contrail          │
│  └── HardwareVxlan — 硬件 Vxlan                       │
└──────────────────────────────────────────────────────┘
```

## SdnControllerVO — 控制器数据模型

```java
@Entity
@Table
public class SdnControllerVO {
    @Column private String uuid;
    @Column private String name;
    @Column private String vendorType;      // SDN 厂商类型
    @Column private String vendorVersion;   // 版本号
    @Column private String ip;              // 控制器 IP
    @Column private String username;
    @Column private String password;
    @Column
    @Enumerated(EnumType.STRING)
    private SdnControllerStatus status;     // Connecting / Connected / Disconnected
}
```

> `SdnControllerStatus` 是枚举类型，非 String。三个值：`Connecting`（连接中）、`Connected`（已连接）、`Disconnected`（已断开）

## SdnControllerManagerImpl — 核心实现

> 源码路径：`zstack/plugin/sdnController/src/main/java/org/zstack/sdnController/SdnControllerManagerImpl.java`（876 行）

### 实现的扩展点

```java
public class SdnControllerManagerImpl extends AbstractService
    implements SdnControllerManager,
        L2NetworkCreateExtensionPoint,      // L2 创建时同步 SDN
        L2NetworkDeleteExtensionPoint,      // L2 删除时同步 SDN
        InstantiateResourceOnAttachingNicExtensionPoint,  // 挂载网卡时同步
        PreVmInstantiateResourceExtensionPoint,           // VM 创建前同步
        VmReleaseResourceExtensionPoint,                 // VM 释放时同步
        ReleaseNetworkServiceOnDetachingNicExtensionPoint, // 卸载网卡时同步
        SecurityGroupGetSdnBackendExtensionPoint,         // 安全组委托
        AfterAddIpRangeExtensionPoint,     // IP 范围变更时同步
        IpRangeDeletionExtensionPoint,     // IP 范围删除时同步
        GetSdnControllerExtensionPoint {   // SDN 控制器查找
}
```

### 创建 SDN 控制器

```java
private void doCreateSdnController(SdnControllerVO vo,
        APIAddSdnControllerMsg msg, Completion completion) {
    SdnControllerFactory factory = getSdnControllerFactory(msg.getVendorType());
    SdnController controller = factory.getSdnController(vo);

    FlowChain chain = FlowChainBuilder.newShareFlowChain();
    chain.then(new ShareFlow() {
        @Override
        public void setup() {
            // Step 1: 前置初始化
            flow(new NoRollbackFlow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    controller.preInitSdnController(msg, completion);
                }
            });
            // Step 2: 创建数据库记录
            flow(new Flow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    controller.createSdnControllerDb(msg, vo, completion);
                }
                @Override
                public void rollback(FlowRollback trigger, Map data) {
                    controller.deleteSdnControllerDb(vo);
                    trigger.rollback();
                }
            });
            // Step 3: 初始化控制器
            flow(new Flow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    controller.initSdnController(msg, completion);
                }
            });
            // Step 4: 后置初始化
            flow(new NoRollbackFlow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    controller.postInitSdnController(vo, completion);
                }
            });
            done(...);
            error(...);
        }
    }).start();
}
```

### L2 网络创建时同步 SDN

```java
@Override
public void postCreateL2Network(L2NetworkInventory l2,
        APICreateL2NetworkMsg msg, Completion completion) {
    // 检查 vSwitch 类型是否需要 SDN 控制器
    VSwitchType vSwitchType = VSwitchType.valueOf(l2.getvSwitchType());
    if (vSwitchType.getSdnControllerType() == null) {
        // LinuxBridge/MacVlan 不需要 SDN 控制器
        completion.success();
        return;
    }

    // 从 SystemTag 获取 SDN 控制器 UUID
    String sdnControllerUuid = L2NetworkSystemTags
        .L2_NETWORK_SDN_CONTROLLER_UUID
        .getTokenByTag(sysTag, ...);

    // 委托给 SdnControllerL2 创建 L2 网络
    SdnControllerFactory factory = getSdnControllerFactory(
        sdnControllerVO.getVendorType());
    SdnControllerL2 controller = factory.getSdnControllerL2(sdnControllerVO);
    controller.createL2Network(l2, msg, completion);
}
```

### VM 网卡添加到 SDN

```java
@Override
public void preInstantiateVmResource(VmInstanceSpec spec,
        Completion completion) {
    // 收集需要 SDN 控制的网卡
    Map<String, List<VmNicInventory>> nicMaps = new HashMap<>();
    for (VmNicInventory nic : spec.getDestNics()) {
        L2NetworkVO l2 = getL2ByL3(nic.getL3NetworkUuid());
        VSwitchType vst = VSwitchType.valueOf(l2.getvSwitchType());
        if (vst.getSdnControllerType() == null) continue;

        String controllerUuid = getSdnControllerUuid(l2);
        nicMaps.computeIfAbsent(controllerUuid, k -> new ArrayList<>())
               .add(nic);
    }

    if (nicMaps.isEmpty()) {
        completion.success();
        return;
    }

    // 批量添加网卡到 SDN 控制器
    sdnAddVmNics(nicMaps, completion);
}

private void sdnAddVmNics(Map<String, List<VmNicInventory>> nicMaps,
        Completion completion) {
    // While 循环：对每个 SDN 控制器并行添加
    new While<>(nicMaps.entrySet()).each((e, wcomp) -> {
        sdnAddVmNic(e.getKey(), e.getValue(), new Completion(wcomp) {
            @Override
            public void success() { wcomp.done(); }
            @Override
            public void fail(ErrorCode err) {
                wcomp.addError(err);
                wcomp.allDone();
            }
        });
    }).run(new WhileDoneCompletion(completion) {
        @Override
        public void done(ErrorCodeList errorCodeList) {
            if (errorCodeList.getCauses().isEmpty()) {
                completion.success();
            } else {
                completion.fail(errorCodeList.getCauses().get(0));
            }
        }
    });
}
```

### VM 网卡从 SDN 删除

```java
@Override
public void releaseVmResource(VmInstanceSpec spec, Completion completion) {
    // 只在 Destroy 和 DetachNic 时处理
    if (spec.getCurrentVmOperation() != DetachNic
     && spec.getCurrentVmOperation() != Destroy) {
        completion.success();
        return;
    }

    // 收集需要从 SDN 删除的网卡
    Map<String, List<VmNicInventory>> nicMaps = buildNicMaps(spec);

    if (nicMaps.isEmpty()) {
        completion.success();
        return;
    }

    // 批量从 SDN 控制器删除网卡（逻辑端口）
    removeLogicalPort(nicMaps, completion);
}
```

### IP 范围变更同步

```java
@Override
public void afterAddIpRange(IpRangeInventory ipr, List<String> sysTags) {
    L3NetworkVO l3 = dbf.findByUuid(ipr.getL3NetworkUuid());
    SdnControllerVO sdn = getSdnControllerVO(L3NetworkInventory.valueOf(l3));
    if (sdn == null) return;

    // 通知 SDN 控制器新增 IP 范围
    SdnControllerFactory factory = getSdnControllerFactory(sdn.getVendorType());
    SdnControllerL2 controller = factory.getSdnControllerL2(sdn);
    controller.addL3NetworkIpRange(l3, ipr, new Completion(null) {
        @Override
        public void success() {
            logger.debug("success to create ipRange on sdn controller");
        }
        @Override
        public void fail(ErrorCode err) {
            logger.warn("failed to create ipRange on sdn controller: " + err);
        }
    });
}
```

### 安全组委托

```java
@Override
public SecurityGroupSdnBackend getSecurityGroupSdnBackend(
        String sdnControllerUuid) {
    SdnControllerVO vo = dbf.findByUuid(
        sdnControllerUuid, SdnControllerVO.class);
    SdnControllerFactory factory = getSdnControllerFactory(vo.getVendorType());
    return factory.getSdnControllerSecurityGroup(vo);
}

// SecurityGroupManagerImpl 中的 SDN 后端查找
private SecurityGroupSdnBackend getSdnBackendFroL3Uuid(String l3Uuid) {
    String controllerUuid = L3NetworkHelper
        .getSdnControllerUuidFromL3Uuid(l3Uuid);
    if (controllerUuid == null) return null;
    return sdnControllerMgr.getSecurityGroupSdnBackend(controllerUuid);
}
```

## VSwitch 类型与 SDN 的关系

```java
// VSwitchType 定义了哪些 vSwitch 需要 SDN 控制器
// 这是一个普通类（非枚举），类型由插件动态注册
public class VSwitchType {
    private static Map<String, VSwitchType> types = Collections.synchronizedMap(new HashMap<String, VSwitchType>());
    private final String typeName;
    private String sdnControllerType = null;  // null = 不需要 SDN
    // ...
}
```

## SDN 控制器 Ping 追踪

```java
// SdnControllerPingTracker 定期检查 SDN 控制器连通性
// 创建 SDN 控制器后开始追踪
pingTracker.track(vo.getUuid());

// 如果控制器断连，标记状态为 Disconnected
// 影响后续的 VM 创建/网卡操作
```

## 小结

| 功能 | 方法 | 扩展点 |
|------|------|--------|
| 创建 SDN 控制器 | `doCreateSdnController()` | `SdnControllerFactory` |
| L2 网络同步 | `postCreateL2Network()` | `L2NetworkCreateExtensionPoint` |
| VM 网卡添加 | `preInstantiateVmResource()` | `PreVmInstantiateResourceExtensionPoint` |
| VM 网卡删除 | `releaseVmResource()` | `VmReleaseResourceExtensionPoint` |
| IP 范围同步 | `afterAddIpRange()` | `AfterAddIpRangeExtensionPoint` |
| 安全组委托 | `getSecurityGroupSdnBackend()` | `SecurityGroupGetSdnBackendExtensionPoint` |

SDN 控制器的设计精髓：**通过扩展点织入现有流程，对上层透明**。VM 创建流程无需感知 SDN 的存在，SdnControllerManagerImpl 通过扩展点自动拦截并处理。
