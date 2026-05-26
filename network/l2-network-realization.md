# L2 网络实现与 Underlay

L2 网络是 ZStack 网络体系的基础层，负责在物理主机上创建网桥、绑定 VLAN、连接虚拟机网卡。本章从 `L2NetworkManagerImpl` 出发，分析 Underlay 网络的完整实现。

## L2 网络类型体系

```
L2NetworkVO (基类)
├── L2NoVlanNetwork   — 不带 VLAN 标签的扁平网络（直接用 L2NetworkVO，type="L2NoVlanNetwork"）
├── L2VlanNetwork     — 带 VLAN 标签的网络 (vlan: 0-4095)
└── VxlanNetwork      — Vxlan 隧道网络 (vni: 1-16777215)
    └── VxlanNetworkPool — Vxlan 网络池（容器）
```

### L2 网络类型

```mermaid
classDiagram
    class L2NetworkAO {
        +String uuid
        +String name
        +String type
        +String vSwitchType
        +String zoneUuid
        +String physicalInterface
    }
    class L2NetworkVO {
        +Set attachedClusterRefs
    }
    class L2VlanNetworkVO {
        +int vlan
    }
    class VxlanNetworkPoolVO {
        +Set attachedVtepRefs
        +Set attachedVniRanges
    }
    class VxlanNetworkVO {
        +Integer vni
        +String poolUuid
    }

    L2NetworkAO <|-- L2NetworkVO
    L2NetworkVO <|-- L2VlanNetworkVO
    L2NetworkVO <|-- VxlanNetworkPoolVO
    L2NetworkVO <|-- VxlanNetworkVO
    note for L2NetworkVO "NoVlan 网络直接使用 L2NetworkVO\n(type=\"L2NoVlanNetwork\")，无子类"
```

> 源码路径：`zstack/header/src/main/java/org/zstack/header/network/l2/L2NetworkType.java`

```java
public class L2NetworkType {
    private static Map<String, L2NetworkType> types = Collections.synchronizedMap(new HashMap<>());
    private final String typeName;

    public L2NetworkType(String typeName) {
        this.typeName = typeName;
        types.put(typeName, this);
    }

    public static L2NetworkType valueOf(String typeName) {
        L2NetworkType type = types.get(typeName);
        if (type == null) {
            throw new IllegalArgumentException("L2NetworkType type: " + typeName + " was not registered by any L2NetworkFactory");
        }
        return type;
    }

    @Override
    public String toString() { return typeName; }
}
```

`L2NetworkType` 不是 String 常量类，而是类型对象类。每个类型（如 `L2NoVlanNetwork`）是 `L2NetworkType` 的实例，通过构造函数注册到内部 Map 中。子模块通过 `new L2NetworkType("L2NoVlanNetwork")` 声明新类型。

Vxlan 类型定义在 plugin 模块：

> 源码路径：`zstack/plugin/vxlan/src/main/java/org/zstack/network/l2/vxlan/vxlanNetwork/VxlanNetworkVO.java`

```java
@Entity
@Table
@PrimaryKeyJoinColumn(name = "uuid", referencedColumnName = "uuid")
public class VxlanNetworkVO extends L2NetworkVO {
    @Column private Integer vni;           // Vxlan VNI
    @Column private String poolUuid;       // 所属 Vxlan 池
}
```

> **注**：`L2VlanNetworkVO` 和 `VxlanNetworkVO` 都使用 `@PrimaryKeyJoinColumn`（而非 `@Inheritance`）声明与 `L2NetworkVO` 的 JOINED 继承关系。`@Inheritance(strategy = JOINED)` 只在根实体 `L2NetworkVO` 上声明一次。NoVlan 网络没有子类，直接使用 `L2NetworkVO` 并将 `type` 设为 `"L2NoVlanNetwork"`。

## L2NetworkVO — 核心数据模型

> 源码路径：`zstack/header/src/main/java/org/zstack/header/network/l2/L2NetworkVO.java`

```java
@MappedSuperclass
public class L2NetworkAO extends ResourceVO {
    @Column private String name;
    @Column private String description;
    @Column private String type;           // L2NoVlanNetwork / L2VlanNetwork
    @Column private String vSwitchType;    // vSwitch 类型
    @Column private Integer virtualNetworkId;
    @Column private Boolean isolated;
    @Column private String pvlan;
    @Column private String zoneUuid;
    @Column private String physicalInterface;  // 物理网卡名 (如 eth0)
    @Column private Timestamp createDate;
    @Column private Timestamp lastOpDate;
}

@Entity
@Table
public class L2NetworkVO extends L2NetworkAO implements ToInventory, OwnedByAccount {
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l2NetworkUuid", insertable = false, updatable = false)
    private Set<L2NetworkClusterRefVO> attachedClusterRefs = new HashSet<>();

    @Transient
    private String accountUuid;
}
```

`L2NetworkVO` 继承 `L2NetworkAO`，后者以 `@MappedSuperclass` 定义所有列字段。`L2NetworkVO` 本身仅定义 `attachedClusterRefs`（EAGER 加载的集群关联）和 `accountUuid`（Transient 字段）。

## vSwitch 类型

ZStack 支持5种 vSwitch 类型，决定了 L2 网络在主机上的实现方式：

| vSwitch 类型 | 实现 | SDN 控制器 |
|-------------|------|-----------|
| LinuxBridge | 默认，brctl 网桥 | 无（sdnControllerType=null） |
| OvsDpdk | OVS + DPDK | 无（sdnControllerType=null） |
| MacVlan | macvlan 驱动 | 无（sdnControllerType=null） |
| OvsKernel | OVS 内核态 | 无（sdnControllerType=null） |
| OvnDpdk | OVN + DPDK | 必需（sdnControllerType 在运行时设置） |

## L2NetworkManagerImpl — L2 网络管理器

> 源码路径：`zstack/network/src/main/java/org/zstack/network/l2/L2NetworkManagerImpl.java`（610 行）

### 创建 L2 网络

```java
private void handle(APICreateL2NetworkMsg msg) {
    APICreateL2NetworkEvent evt = new APICreateL2NetworkEvent(msg.getId());

    L2NetworkVO vo = new L2NetworkVO();
    // ... 填充基本字段
    vo.setType(msg.getType());
    vo.setPhysicalInterface(msg.getPhysicalInterface());
    vo.setvSwitchType(msg.getvSwitchType() == null
        ? VSwitchType.LinuxBridge.toString()
        : msg.getvSwitchType());

    // 1. 触发 beforeCreateL2Network 扩展点
    // 2. 持久化到数据库
    // 3. 触发 postCreateL2Network 扩展点（SDN 控制器在此介入）
    // 4. 触发 afterCreateL2Network 扩展点（Provider 自动挂载在此）
}
```

### 挂载 L2 到集群

L2 网络必须挂载到集群后才能使用。挂载流程触发主机上的网桥创建：

```java
private void handle(APIAttachL2NetworkToClusterMsg msg) {
    FlowChain chain = FlowChainBuilder.newShareFlowChain();
    chain.setName("attach-l2-to-cluster");
    chain.then(new ShareFlow() {
        @Override
        public void setup() {
            flow(new NoRollbackFlow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    // 1. 写入 L2NetworkClusterRefVO 绑定记录
                    // 2. 触发 L2NetworkAttachClusterExtensionPoint
                    //    → 各扩展点在集群中的主机上准备网络
                    trigger.next();
                }
            });
            flow(new Flow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    // 对集群中每台主机，调用 Agent 创建网桥
                    realizeL2NetworkOnHosts(l2Network, cluster, trigger);
                }
                @Override
                public void rollback(...) {
                    // 回滚：删除主机上的网桥
                }
            });
            done(...);
            error(...);
        }
    }).start();
}
```

### realizeL2NetworkOnHosts — 在主机上实现 L2 网络

```java
private void realizeL2NetworkOnHosts(L2NetworkInventory l2,
        ClusterInventory cluster, FlowTrigger trigger) {
    // 查找 L2NetworkRealizationExtensionPoint 实现
    // 按 (L2Type, HypervisorType, VSwitchType) 三元组匹配
    L2NetworkRealizationExtensionPoint ext =
        getRealizationExtension(l2, cluster);

    // 对集群中每台主机，发送 HTTP 请求到 kvmagent
    for (HostInventory host : hosts) {
        ext.realize(l2, host, completion);
    }
}
```

## L2NetworkRealizationExtensionPoint — 实现扩展点

这是 L2 网络在主机上落地的关键扩展点，按三元组匹配：

```
(L2NoVlanNetwork, KVM, LinuxBridge) → L2NoVlanNetworkFactory
(L2VlanNetwork, KVM, LinuxBridge)   → L2VlanNetworkFactory
(VxlanNetwork, KVM, LinuxBridge)    → VxlanNetworkFactory
```

以 NoVlan 为例，最终调用 kvmagent 的 network_plugin：

> 源码路径：`zstack-utility/kvmagent/kvmagent/plugins/network_plugin.py`

```python
# HTTP 端点
KVM_REALIZE_L2NOVLAN_PATH = "/network/l2novlan/createbridge"

class CreateBridgeCmd(kvmagent.AgentCommand):
    physicalInterfaceName = jsonobject.StringField()  # 物理网卡名
    bridgeName = jsonobject.StringField()             # 网桥名
    l2NetworkUuid = jsonobject.StringField()          # L2 UUID
    disableIptables = jsonobject.BooleanField()       # 是否禁用 iptables
    mtu = jsonobject.IntegerField()                   # MTU 值

@kvmagent.handle_request(KVM_REALIZE_L2NOVLAN_PATH)
def create_bridge(req):
    cmd = jsonobject.loads(req[http.REQUEST_BODY])
    # 1. 创建网桥 br_<l2uuid_short>
    # 2. 将物理网卡加入网桥
    # 3. 设置 MTU
    shell.call("brctl addbr %s" % cmd.bridgeName)
    shell.call("brctl addif %s %s" % (cmd.bridgeName,
                                       cmd.physicalInterfaceName))
    shell.call("ip link set %s mtu %d" % (cmd.bridgeName, cmd.mtu))
    # ...
```

VLAN 网桥类似，`CreateVlanBridgeCmd` 继承 `CreateBridgeCmd`，额外添加 `vlan` 字段：

```python
KVM_REALIZE_L2VLAN_PATH = "/network/l2vlan/createbridge"

# Java 端: CreateVlanBridgeCmd extends CreateBridgeCmd
# 额外字段: private int vlan
# 继承字段: physicalInterfaceName, bridgeName, l2NetworkUuid, ...

@kvmagent.handle_request(KVM_REALIZE_L2VLAN_PATH)
def create_vlan_bridge(req):
    cmd = jsonobject.loads(req[http.REQUEST_BODY])
    # 1. 创建 vlan 子接口 eth0.<vlan>
    # 2. 创建网桥
    # 3. 将 vlan 子接口加入网桥
    shell.call("ip link add link %s name %s.%d type vlan id %d"
               % (cmd.physicalInterfaceName,
                  cmd.physicalInterfaceName, cmd.vlan, cmd.vlan))
    shell.call("brctl addbr %s" % cmd.bridgeName)
    shell.call("brctl addif %s %s.%d"
               % (cmd.bridgeName,
                  cmd.physicalInterfaceName, cmd.vlan))
```

## L2 网络与集群的关联

```
L2NetworkVO
    │
    ├── L2NetworkClusterRefVO (绑定表)
    │       ├── l2NetworkUuid
    │       └── clusterUuid
    │
    └── 挂载后触发：
            ├── L2NetworkAttachClusterExtensionPoint
            │   → VxlanNetworkFactory: 准备 VTEP
            │   → FlatProviderFactory: 自动挂载 Provider
            │   → VirtualRouterManagerImpl: 自动挂载 VR Provider
            │
            └── realizeL2NetworkOnHosts()
                → kvmagent: 创建网桥
```

## 删除 L2 网络

删除流程通过 `L2NetworkDeleteExtensionPoint` 扩展点实现级联清理：

```java
private void handle(APIDeleteL2NetworkMsg msg) {
    FlowChain chain = FlowChainBuilder.newShareFlowChain();
    chain.then(new ShareFlow() {
        @Override
        public void setup() {
            // 1. preDeleteL2Network — 前置检查
            // 2. beforeDeleteL2Network — 级联删除 L3 网络
            // 3. deleteL2Network — SDN 控制器清理
            // 4. 从主机删除网桥
            // 5. afterDeleteL2Network — 后置清理
            // 6. 删除数据库记录
        }
    }).start();
}
```

## 小结

| 操作 | Java 端 | Agent 端 |
|------|---------|----------|
| 创建 NoVlan 网桥 | L2NoVlanNetworkFactory | network_plugin: `/network/l2novlan/createbridge` |
| 创建 Vlan 网桥 | L2VlanNetworkFactory | network_plugin: `/network/l2vlan/createbridge` |
| 删除网桥 | L2NetworkManagerImpl | network_plugin: `/network/*/deletebridge` |
| 挂载到集群 | APIAttachL2NetworkToClusterMsg | realizeL2NetworkOnHosts |

L2 网络的核心设计模式：**Manager 管生命周期，Factory 管实现，ExtensionPoint 管扩展**。三层分离使得新增 L2 类型（如 Vxlan）只需实现对应的 Factory 和 ExtensionPoint，无需修改核心代码。
