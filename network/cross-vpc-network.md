# 跨 VPC 网络路径

⚠️ **VPC 功能为 ZStack 企业版特性，以下内容基于概念设计和公开文档，非开源代码实现。** 开源代码中仅有数据库 schema（DDL）和 SDK Inventory 桩代码，无 Java 实现类。

## 跨 VPC 通信方式总览

```
┌──────────────────────────────────────────────────────┐
│  方式1: VPC Peering (企业版)                           │
│  VPC-A Router ←→ Peering Link ←→ VPC-B Router        │
│  特点：低延迟，同区域                                   │
├──────────────────────────────────────────────────────┤
│  方式2: IPsec VPN 隧道                                 │
│  VPC-A Router ←→ IPsec (公网) ←→ VPC-B Router        │
│  特点：跨区域，加密传输                                 │
├──────────────────────────────────────────────────────┤
│  方式3: OSPF 动态路由 (企业版)                          │
│  VPC-A Router ←→ OSPF ←→ VPC-B Router                │
│  特点：自动路由学习，大规模部署                          │
└──────────────────────────────────────────────────────┘
```

## VPC Peering — 对等连接

VPC Peering 是两个 VPC 之间的直接连接，流量不经过公网：

```
VPC-A                              VPC-B
┌──────────────┐                  ┌──────────────┐
│ VPC Router-A │                  │ VPC Router-B │
│ 10.0.1.0/24  │◄──Peering──►    │ 172.16.1.0/24│
│ 10.0.2.0/24  │  Link            │ 172.16.2.0/24│
└──────────────┘                  └──────────────┘

路由表 (VPC-A):
  10.0.1.0/24    → eth2 (直连)
  10.0.2.0/24    → eth3 (直连)
  172.16.0.0/16  → Peering Link → VPC Router-B

路由表 (VPC-B):
  172.16.1.0/24  → eth2 (直连)
  172.16.2.0/24  → eth3 (直连)
  10.0.0.0/16    → Peering Link → VPC Router-A
```

### Peering 实现原理

Peering 连接在两个 VPC Router 之间建立：

1. **控制面**：管理节点创建 Peering 记录，下发路由到两个 VPC Router
2. **数据面**：两个 VPC Router 之间通过 Vxlan 隧道或直接二层连接通信
3. **安全**：通过 VPC 防火墙规则控制 Peering 流量

### Peering 限制

- 两个 VPC 的 CIDR 不能重叠
- Peering 不支持传递性（A↔B, B↔C ≠ A↔C）
- 同区域 Peering 性能好，跨区域需要底层网络支持

## IPsec VPN 隧道

IPsec VPN 是跨公网的安全隧道，适用于跨区域 VPC 互联：

```
VPC-A (可用区1)                    VPC-B (可用区2)
┌──────────────┐                  ┌──────────────┐
│ VPC Router-A │                  │ VPC Router-B │
│ 公网: 1.1.1.1│◄──IPsec──►      │ 公网: 2.2.2.2│
│ 10.0.1.0/24  │  (加密隧道)       │ 172.16.1.0/24│
└──────────────┘                  └──────────────┘
        │                                │
        ▼                                ▼
    公网 Internet (加密传输)
```

### IPsec 配置

在 VPC Router (VyOS) 上配置 IPsec：

```bash
# VPC Router-A
set vpn ipsec esp-group ESP-GROUP compression disable
set vpn ipsec esp-group ESP-GROUP lifetime 3600
set vpn ipsec esp-group ESP-GROUP mode tunnel
set vpn ipsec esp-group ESP-GROUP proposal 1 encryption aes256
set vpn ipsec esp-group ESP-GROUP proposal 1 hash sha256

set vpn ipsec ike-group IKE-GROUP lifetime 86400
set vpn ipsec ike-group IKE-GROUP proposal 1 encryption aes256
set vpn ipsec ike-group IKE-GROUP proposal 1 hash sha256

set vpn ipsec site-to-site peer 2.2.2.2 authentication mode pre-shared-secret
set vpn ipsec site-to-site peer 2.2.2.2 authentication pre-shared-secret <key>
set vpn ipsec site-to-site peer 2.2.2.2 ike-group IKE-GROUP
set vpn ipsec site-to-site peer 2.2.2.2 local-address 1.1.1.1
set vpn ipsec site-to-site peer 2.2.2.2 tunnel 0 esp-group ESP-GROUP
set vpn ipsec site-to-site peer 2.2.2.2 tunnel 0 local prefix 10.0.0.0/16
set vpn ipsec site-to-site peer 2.2.2.2 tunnel 0 remote prefix 172.16.0.0/16
```

### IPsec 数据流

```
VM-A (10.0.1.5) → VM-B (172.16.1.5)
  │
  ▼
VPC Router-A:
  1. 查路由表: 172.16.0.0/16 → IPsec tunnel
  2. ESP 加密: 原始包 → ESP 封装
  3. 外层 IP: 1.1.1.1 → 2.2.2.2
  │
  ▼
Internet (加密传输)
  │
  ▼
VPC Router-B:
  1. ESP 解密: 外层 IP 剥离 → 原始包
  2. 查路由表: 172.16.1.0/24 → eth2
  3. 转发到 VM-B
```

## OSPF 动态路由

OSPF 是大规模跨可用区 VPC 互联的推荐方式：

```
┌─────────────────────────────────────────────────┐
│              OSPF Area 0 (骨干区域)               │
│                                                   │
│  ┌──────────┐         ┌──────────┐               │
│  │ Router-A │◄───────►│ Router-B │               │
│  │ Area 0.0 │  OSPF   │ Area 0.0 │               │
│  │  0.1     │  邻居    │  0.2     │               │
│  └────┬─────┘         └────┬─────┘               │
│       │                     │                     │
│  ┌────┴─────┐         ┌────┴─────┐               │
│  │ 可用区1   │         │ 可用区2   │               │
│  │10.0.1.0/24│         │172.16.1.0│               │
│  │10.0.2.0/24│         │172.16.2.0│               │
│  └──────────┘         └──────────┘               │
└─────────────────────────────────────────────────┘
```

### OSPF 数据模型

开源代码中 `RouterAreaVO` 和 `NetworkRouterAreaRefVO` 的数据库 schema（DDL）揭示了 OSPF 区域管理的设计：

**RouterAreaVO** — OSPF 区域定义

| 字段 | 类型 | 说明 |
|------|------|------|
| uuid | VARCHAR(32) PK | 区域 UUID |
| areaId | VARCHAR(64) | OSPF Area ID（IPv4 地址格式，如 0.0.0.1） |
| type | VARCHAR(16) | 区域类型，默认 'Standard' |
| authentication | VARCHAR(16) | 认证方式（None / Plain / MD5） |
| password | VARCHAR(16) | 认证密码 |
| keyId | INT UNSIGNED | MD5 认证 Key ID |

**NetworkRouterAreaRefVO** — 网络与路由区域的绑定关系

| 字段 | 类型 | 说明 |
|------|------|------|
| uuid | VARCHAR(32) PK | 记录 UUID |
| routerAreaUuid | VARCHAR(32) FK → RouterAreaVO | 所属路由区域 |
| vRouterUuid | VARCHAR(32) FK → VpcRouterVmVO | VPC 路由器 |
| l3NetworkUuid | VARCHAR(32) FK → L3NetworkEO | 关联的 L3 网络 |

> 以上为数据库 DDL 定义（`conf/db/upgrade/V3.4.0__schema.sql`），非 Java `@Entity` 类。开源代码中不存在对应的 Java 实体类，业务逻辑属于企业版。

### OSPF 路由学习过程

```
1. Router-A 启动 OSPF，宣告直连路由:
   - 10.0.1.0/24 (Area 0.0.0.1)
   - 10.0.2.0/24 (Area 0.0.0.1)

2. Router-B 启动 OSPF，宣告直连路由:
   - 172.16.1.0/24 (Area 0.0.0.2)
   - 172.16.2.0/24 (Area 0.0.0.2)

3. OSPF 邻居建立后，路由交换:
   Router-A 学习到:
     172.16.1.0/24 via Router-B (cost: 10)
     172.16.2.0/24 via Router-B (cost: 10)

   Router-B 学习到:
     10.0.1.0/24 via Router-A (cost: 10)
     10.0.2.0/24 via Router-A (cost: 10)

4. VM-A → VM-B 流量路径:
   VM-A → Router-A → OSPF 路由 → Router-B → VM-B
```

### OSPF 优势

- **自动路由学习**：新增子网自动传播，无需手动配置
- **故障自愈**：链路故障时自动切换到备用路径
- **可扩展**：支持数百个 VPC Router 的互联
- **区域划分**：Area 设计减少 LSA 泛洪范围

## 三种方式对比

| 特性 | VPC Peering | IPsec VPN | OSPF |
|------|------------|-----------|------|
| 延迟 | 低 | 高（加密开销） | 低 |
| 带宽 | 高 | 受公网限制 | 高 |
| 安全 | 内部网络 | 加密传输 | 内部网络 |
| 跨区域 | 需底层支持 | 支持 | 支持 |
| 可扩展 | 1:1 连接 | 1:1 连接 | N:N 互联 |
| 配置复杂度 | 低 | 中 | 高 |
| 企业版 | 是 | 否 | 是 |

## 跨 VPC 流量路径总结

```
同区域 VPC 互联:
  VM-A → VPC Router-A → Peering Link → VPC Router-B → VM-B

跨区域 VPC 互联 (安全):
  VM-A → VPC Router-A → IPsec 隧道 → VPC Router-B → VM-B

跨区域 VPC 互联 (高性能):
  VM-A → VPC Router-A → OSPF → VPC Router-B → VM-B

混合云互联:
  VM-A → VPC Router-A → IPsec → 客户网关 → 客户内网
```

## 小结

跨 VPC 网络路径的设计精髓：**Peering 求性能，IPsec 求安全，OSPF 求规模**。三种方式可以组合使用，满足不同场景的需求。开源代码中 VPC Peering 和 OSPF 的 Java 实现属于企业版，但数据库 DDL（`RouterAreaVO`、`NetworkRouterAreaRefVO`）和 SDK Inventory 桩代码已经揭示了其架构设计。
