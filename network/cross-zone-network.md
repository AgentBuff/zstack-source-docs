# 跨资源池网络路径

跨资源池（跨可用区/跨集群）网络是 ZStack 网络体系中最复杂的场景。本章分析三种跨资源池网络路径的实现：Vxlan Overlay、VPC Router 集中路由和物理 VLAN Stretch。

## 跨资源池场景

```
┌──────────────────────────────────────────────────────┐
│  场景1: 同区域跨集群                                   │
│  集群A ←→ 集群B (同一 Zone)                           │
│  方案: VLAN / Vxlan                                   │
├──────────────────────────────────────────────────────┤
│  场景2: 跨区域同 VPC                                   │
│  可用区1 ←→ 可用区2 (不同 Zone)                        │
│  方案: Vxlan Overlay / VPC Router + OSPF              │
├──────────────────────────────────────────────────────┤
│  场景3: 跨区域不同 VPC                                  │
│  VPC-A (可用区1) ←→ VPC-B (可用区2)                    │
│  方案: IPsec VPN / VPC Peering                        │
└──────────────────────────────────────────────────────┘
```

## 方案1: Vxlan Overlay（开源支持）

Vxlan 是开源 ZStack 唯一支持的跨可用区网络方案。

### 架构

```
可用区1                              可用区2
┌──────────────┐                    ┌──────────────┐
│ Host-A       │                    │ Host-B       │
│ VTEP:10.0.1.1│                    │ VTEP:10.0.2.1│
│              │                    │              │
│ VM-A         │                    │ VM-B         │
│ 10.0.1.100   │                    │ 10.0.2.100   │
│   │          │                    │   │          │
│   ▼          │                    │   ▼          │
│ br_vxlan_100 │                    │ br_vxlan_100 │
│   │          │                    │   │          │
│   ▼          │                    │   ▼          │
│ vxlan0       │                    │ vxlan0       │
│ VNI:100      │                    │ VNI:100      │
│   │          │                    │   │          │
└───┼──────────┘                    └───┼──────────┘
    │                                     │
    ▼                                     ▼
  UDP 封装 (VNI:100, Dst:10.0.2.1:4789)
    └──────────── 物理网络 ────────────────┘
```

### 关键数据流

```
VM-A (10.0.1.100) → VM-B (10.0.2.100)

1. VM-A 发送报文: src=10.0.1.100, dst=10.0.2.100
2. br_vxlan_100 查 FDB 表:
   - 目标 MAC → 远端 VTEP 10.0.2.1
3. vxlan0 封装:
   - 外层: src=10.0.1.1, dst=10.0.2.1, UDP:4789
   - VNI: 100
   - 内层: 原始报文
4. 物理网络路由到可用区2
5. Host-B 的 vxlan0 解封装
6. br_vxlan_100 转发给 VM-B
```

### RemoteVtepVO — 跨可用区关键

> 源码路径：`zstack/plugin/vxlan/src/main/java/org/zstack/network/l2/vxlan/vtep/RemoteVtepVO.java`

```java
@Entity
@Table
public class RemoteVtepVO {
    @Column private String uuid;
    @Column private String clusterUuid;    // 远端集群
    @Column private String vtepIp;         // 远端 VTEP IP
    @Column private Integer port;          // 远端端口
    @Column private String poolUuid;       // 同一个 VxlanNetworkPool
}
```

`RemoteVtepVO` 记录了远端可用区的 VTEP 信息。当 VxlanNetworkPool 挂载到新集群时，管理节点会：
1. 在新集群的主机上创建 VtepVO
2. 将已有集群的 VtepVO 作为 RemoteVtepVO 同步到新集群
3. 将新集群的 VtepVO 作为 RemoteVtepVO 同步到已有集群
4. 在所有主机上更新 FDB 表

### VxlanNetworkPoolFactory 的跨可用区处理

```java
// VxlanNetworkPoolFactory.afterAttachL2NetworkToCluster()
// 当 VxlanNetworkPool 挂载到新集群时：

// 1. 为新集群的主机创建 VtepVO
for (HostInventory host : newClusterHosts) {
    VtepVO vtep = new VtepVO();
    vtep.setHostUuid(host.getUuid());
    vtep.setClusterUuid(cluster.getUuid());
    vtep.setVtepIp(allocateVtepIp(pool));
    vtep.setPoolUuid(pool.getUuid());
    dbf.persist(vtep);
}

// 2. 同步远端 VTEP 信息
// 已有集群的 VTEP → 新集群的 RemoteVtepVO
// 新集群的 VTEP → 已有集群的 RemoteVtepVO

// 3. 在所有主机上更新 FDB 表
// 调用 kvmagent: /network/l2vxlan/populatefdb
```

### Vxlan Overlay 的限制

- 需要底层网络支持 VTEP 之间的 UDP 4789 端口通信
- VTEP IP 必须在物理网络中可路由
- FDB 表规模受限于主机数量
- 不提供子网间路由（需要 VR 或 VPC Router）

## 方案2: VPC Router 集中路由（企业版）

VPC Router 通过 OSPF 实现跨可用区路由：

```
可用区1                              可用区2
┌──────────────┐                    ┌──────────────┐
│ VPC Router-A │                    │ VPC Router-B │
│ 10.0.1.1     │◄──OSPF──►         │ 172.16.1.1   │
│              │  (路由交换)         │              │
│ VM-A         │                    │ VM-B         │
│ 10.0.1.100   │                    │ 172.16.1.100 │
│   │          │                    │   │          │
│   ▼          │                    │   ▼          │
│ L2 Bridge    │                    │ L2 Bridge    │
└──────────────┘                    └──────────────┘

路由学习:
  Router-A: 172.16.0.0/16 via Router-B
  Router-B: 10.0.0.0/16 via Router-A
```

### 数据流

```
VM-A (10.0.1.100) → VM-B (172.16.1.100)

1. VM-A 发送报文: dst=172.16.1.100
2. 报文到达 VPC Router-A (VM 的默认网关)
3. Router-A 查 OSPF 路由表:
   172.16.0.0/16 via Router-B
4. Router-A → Router-B (通过物理网络或 Vxlan 隧道)
5. Router-B 查路由表:
   172.16.1.0/24 → eth3 (直连)
6. Router-B → VM-B
```

### VPC Router 跨可用区的优势

- **自动路由学习**：OSPF 自动传播新子网
- **故障自愈**：链路故障时自动切换
- **策略路由**：不同子网走不同路径
- **防火墙**：子网间访问控制

## 方案3: 物理 VLAN Stretch

最简单的跨可用区方案——物理交换机配置相同的 VLAN：

```
可用区1                              可用区2
┌──────────────┐                    ┌──────────────┐
│ Host-A       │                    │ Host-B       │
│              │                    │              │
│ VM-A         │                    │ VM-B         │
│ 10.0.1.100   │                    │ 10.0.1.101   │
│   │          │                    │   │          │
│   ▼          │                    │   ▼          │
│ br_vlan100   │                    │ br_vlan100   │
│ (VLAN 100)   │                    │ (VLAN 100)   │
└──────────────┘                    └──────────────┘
        │                                   │
        └────── 物理交换机 (VLAN 100) ───────┘
```

### VLAN Stretch 的条件

- 两个可用区的物理交换机必须配置相同的 VLAN ID
- 两个可用区的 IP 子网必须相同（同一个 L3 网络）
- 物理网络必须支持跨交换机的 VLAN 透传

### VLAN Stretch 在 ZStack 中的实现

```java
// L2VlanNetwork 挂载到多个集群
// 同一个 L2VlanNetwork (VLAN 100) 挂载到集群A和集群B
// 同一个 L3 网络覆盖两个集群
// VM 在两个集群间二层互通

// L2NetworkClusterRefVO 记录:
// L2-VLAN-100 → Cluster-A
// L2-VLAN-100 → Cluster-B
```

### VLAN Stretch 的限制

- 依赖物理交换机配置
- VLAN ID 数量有限 (0-4095)
- 不提供三层路由
- 难以跨数据中心

## 三种方案对比

| 特性 | Vxlan Overlay | VPC Router + OSPF | VLAN Stretch |
|------|--------------|-------------------|--------------|
| 开源支持 | 是 | 否（企业版） | 是 |
| 跨可用区 | 是 | 是 | 是（需物理配置） |
| 三层路由 | 需 VR | 内置 | 无 |
| 可扩展性 | 16M VNI | OSPF 区域 | 4096 VLAN |
| 配置复杂度 | 中 | 高 | 低（但需物理配置） |
| 性能 | UDP 封装开销 | 路由器转发 | 直通 |
| 故障恢复 | 无 | OSPF 自动切换 | 无 |

## 混合方案

实际部署中，三种方案可以组合使用：

```
┌─────────────────────────────────────────────────┐
│  可用区1                                          │
│  ├── VLAN 100 (物理网络)                          │
│  ├── Vxlan 1000 (Overlay)                        │
│  └── VPC Router-A (OSPF Area 0.0.0.1)            │
├─────────────────────────────────────────────────┤
│  可用区2                                          │
│  ├── VLAN 100 (物理网络, 与可用区1 相同 VLAN)       │
│  ├── Vxlan 1000 (Overlay, 与可用区1 同 Pool)       │
│  └── VPC Router-B (OSPF Area 0.0.0.2)            │
├─────────────────────────────────────────────────┤
│  跨可用区连接                                      │
│  ├── VLAN Stretch: 同子网 VM 二层互通              │
│  ├── Vxlan Overlay: 不同子网 VM 通过 Vxlan 隧道    │
│  └── OSPF: VPC Router 间三层路由                  │
└─────────────────────────────────────────────────┘
```

## 小结

跨资源池网络路径的设计精髓：**Vxlan Overlay 求通用，VPC Router 求智能，VLAN Stretch 求简单**。开源 ZStack 通过 VxlanNetworkPool + RemoteVtepVO 实现了完整的跨可用区 Overlay 网络，企业版则通过 VPC Router + OSPF 提供了更强大的三层路由能力。
