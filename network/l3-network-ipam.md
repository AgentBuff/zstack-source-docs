# L3 网络与 IPAM

L3 网络是 IP 地址管理的核心层，连接 L2 网络和上层网络服务。本章分析 L3 网络生命周期、IP 分配策略、IPv4/IPv6 双栈支持。

## L3 网络架构

```
┌─────────────────────────────────────────────┐
│              L3NetworkVO                     │
│  ├── dns (EAGER)        DNS 服务器列表       │
│  ├── ipRanges (EAGER)   IP 地址范围          │
│  ├── networkServices    网络服务绑定          │
│  ├── hostRoutes         主机路由              │
│  └── reservedIpRanges   保留 IP 范围         │
├─────────────────────────────────────────────┤
│  IpRangeVO                                   │
│  ├── startIp / endIp / netmask / gateway     │
│  └── ipVersion (IPv4 / IPv6)                 │
├─────────────────────────────────────────────┤
│  UsedIpVO                                    │
│  ├── ip / l3NetworkUuid / vmNicUuid          │
│  └── ipVersion                               │
├─────────────────────────────────────────────┤
│  IPAM 策略 (可插拔)                           │
│  ├── DefaultIpAllocatorStrategy              │
│  └── 自定义策略 (IpAllocatorStrategy)         │
└─────────────────────────────────────────────┘
```

## L3NetworkVO — 核心数据模型

> 源码路径：`zstack/header/src/main/java/org/zstack/header/network/l3/L3NetworkVO.java`

```java
@Entity
@Table
public class L3NetworkVO {
    @Column private String uuid;
    @Column private String name;
    @Column private String description;
    @Column private String type;           // L3NetworkType
    @Column private String l2NetworkUuid;  // 关联的 L2 网络
    @Column private String zoneUuid;
    @Enumerated(EnumType.STRING)
    @Column private L3NetworkState state;  // Enabled / Disabled (枚举类型)
    // EAGER 加载的集合（全部为 Set<>）
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l3NetworkUuid", insertable = false, updatable = false)
    @NoView
    private Set<L3NetworkDnsVO> dns = new HashSet<L3NetworkDnsVO>();
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l3NetworkUuid", insertable = false, updatable = false)
    @NoView
    private Set<IpRangeVO> ipRanges = new HashSet<IpRangeVO>();
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l3NetworkUuid", insertable = false, updatable = false)
    @NoView
    private Set<NetworkServiceL3NetworkRefVO> networkServices = new HashSet<NetworkServiceL3NetworkRefVO>();
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l3NetworkUuid", insertable = false, updatable = false)
    @NoView
    private Set<L3NetworkHostRouteVO> hostRoutes = new HashSet<L3NetworkHostRouteVO>();
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "l3NetworkUuid", insertable = false, updatable = false)
    @NoView
    private Set<ReservedIpRangeVO> reservedIpRanges = new HashSet<ReservedIpRangeVO>();
}
```

> **注**：`L3NetworkVO` 的所有集合字段均为 `Set<>`（非 `List<>`），使用 `@JoinColumn` 而非 `@OneToMany(mappedBy=...)`。`dns` 字段类型为 `Set<L3NetworkDnsVO>`（非 `String`），每个 DNS 服务器是独立的 VO 记录。`state` 字段是 `L3NetworkState` 枚举（`Enabled`/`Disabled`），非 String。`usedIps` 不在 `L3NetworkVO` 中，已用 IP 通过 `UsedIpVO` 独立查询。

## L3NetworkManagerImpl — L3 网络管理器

> 源码路径：`zstack/network/src/main/java/org/zstack/network/l3/L3NetworkManagerImpl.java`（1043 行）

### 创建 L3 网络

```java
private void handle(APICreateL3NetworkMsg msg) {
    APICreateL3NetworkEvent evt = new APICreateL3NetworkEvent(msg.getId());

    L3NetworkVO vo = new L3NetworkVO();
    vo.setL2NetworkUuid(msg.getL2NetworkUuid());
    vo.setDns(msg.getDns());
    // ... 填充字段

    // 可选：接入 SDN 控制器
    if (msg.getSdnControllerUuid() != null) {
        // 标记 L3 关联 SDN 控制器
        L2NetworkSystemTags.L2_NETWORK_SDN_CONTROLLER_UUID
            .createFromL3NetworkTag(msg.getSdnControllerUuid(), vo.getUuid());
    }

    vo = dbf.persistAndRefresh(vo);
    // 触发扩展点
    bus.publish(evt);
}
```

### IP 范围管理

```java
private void handle(APIAddIpRangeMsg msg) {
    // 1. 验证 IP 范围合法性
    validateIpRange(msg);

    // 2. 检查 CIDR 重叠
    checkCidrOverlap(msg);

    // 3. 持久化 IpRangeVO
    IpRangeVO ipr = new IpRangeVO();
    ipr.setStartIp(msg.getStartIp());
    ipr.setEndIp(msg.getEndIp());
    ipr.setNetmask(msg.getNetmask());
    ipr.setGateway(msg.getGateway());
    ipr.setL3NetworkUuid(msg.getL3NetworkUuid());
    ipr = dbf.persistAndRefresh(ipr);

    // 4. 触发 AfterAddIpRangeExtensionPoint
    //    → SDN 控制器同步 IP 范围
    //    → VR 分配网关 IP
}
```

## IP 分配 — 核心流程

### allocateIp — 分配 IP 地址

```java
public IpInventory allocateIp(
        String l3NetworkUuid, IpAllocatorStrategy strategy,
        VmInstanceSpec spec) {
    // 1. 查找 L3 网络的所有 IP 范围
    List<IpRangeVO> ranges = getIpRanges(l3NetworkUuid);

    // 2. 使用策略分配
    if (strategy != null) {
        return strategy.allocateIp(ranges, spec);
    }

    // 3. 默认策略：顺序分配
    for (IpRangeVO range : ranges) {
        String ip = allocateFromRange(range);
        if (ip != null) {
            return ip;
        }
    }
    throw new OperationFailureException("no available IP");
}
```

### 并发分配处理

```java
private String allocateFromRange(IpRangeVO range) {
    while (true) {
        String nextIp = getNextAvailableIp(range);
        try {
            UsedIpVO used = new UsedIpVO();
            used.setIp(nextIp);
            used.setL3NetworkUuid(range.getL3NetworkUuid());
            dbf.persist(used);  // 唯一约束保证原子性
            return nextIp;
        } catch (SQLIntegrityConstraintViolationException e) {
            // 并发冲突：另一个线程已分配此 IP，重试
            continue;
        }
    }
}
```

ZStack 利用数据库唯一约束（`l3NetworkUuid + ip`）实现无锁并发分配。冲突时重试而非加锁，这是高并发场景下的经典设计。

## IPv4/IPv6 双栈

```java
// IpRangeVO 支持 IP 版本
@Column private Integer ipVersion;  // 4 或 6

// 创建 IPv6 范围
private void handle(APIAddIpv6RangeMsg msg) {
    IpRangeVO ipr = new IpRangeVO();
    ipr.setStartIp(msg.getStartIp6());
    ipr.setEndIp(msg.getEndIp6());
    ipr.setPrefixLen(msg.getPrefixLen());
    ipr.setGateway(msg.getGateway6());
    ipr.setIpVersion(6);
    // ...
}
```

双栈设计的关键：同一个 L3 网络可以同时包含 IPv4 和 IPv6 范围，VM 网卡可以同时拥有两种地址。

## IP 释放与回收

### releaseIp — 释放 IP

```java
public void releaseIp(String ip, String l3NetworkUuid) {
    UsedIpVO used = queryUsedIp(ip, l3NetworkUuid);
    if (used != null) {
        dbf.remove(used);
    }
}
```

### reAllocateNicIp — 网卡换 IP

```java
public void reAllocateNicIp(VmNicInventory nic, Completion completion) {
    FlowChain chain = FlowChainBuilder.newShareFlowChain();
    chain.then(new ShareFlow() {
        @Override
        public void setup() {
            flow(new Flow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    // 1. 分配新 IP
                    allocateIp(nic.getL3NetworkUuid(), ...);
                    trigger.next();
                }
            });
            flow(new Flow() {
                @Override
                public void run(FlowTrigger trigger, Map data) {
                    // 2. 释放旧 IP
                    releaseIp(nic.getIp(), nic.getL3NetworkUuid());
                    trigger.next();
                }
            });
            done(...);
            error(...);
        }
    }).start();
}
```

先分配后释放的顺序很重要——如果先释放再分配，并发场景下可能分配到刚释放的 IP。

## IPAM 策略扩展

```java
// 扩展点接口
public interface IpAllocatorStrategy {
    IpInventory allocateIp(List<IpRangeVO> ranges, VmInstanceSpec spec);
}

// 默认策略：顺序分配
public class DefaultIpAllocatorStrategy implements IpAllocatorStrategy {
    @Override
    public IpInventory allocateIp(List<IpRangeVO> ranges, ...) {
        for (IpRangeVO range : ranges) {
            String ip = getNextAvailableIp(range);
            if (ip != null) return ip;
        }
        return null;
    }
}
```

自定义策略可以实现如：随机分配、按子网亲和性分配、按负载均衡分配等。

## SDN 控制器集成

L3 网络创建时可选关联 SDN 控制器：

```java
// SdnControllerL3 标记接口
public interface SdnControllerL3 {
    // SDN 控制器接管 L3 网络的 DHCP/DNS 等服务
}

// L3NetworkManagerImpl 中检查 SDN 关联
private SdnControllerVO getSdnController(String l3Uuid) {
    String controllerUuid = L3NetworkHelper
        .getSdnControllerUuidFromL3Uuid(l3Uuid);
    if (controllerUuid == null) return null;
    return dbf.findByUuid(controllerUuid, SdnControllerVO.class);
}
```

## 小结

| 操作 | 方法 | 关键设计 |
|------|------|----------|
| 创建 L3 | `handle(APICreateL3NetworkMsg)` | 可选关联 SDN 控制器 |
| 添加 IP 范围 | `handle(APIAddIpRangeMsg)` | CIDR 重叠检查 |
| 分配 IP | `allocateIp()` | 无锁并发（唯一约束+重试） |
| 释放 IP | `releaseIp()` | 直接删除 UsedIpVO |
| 换 IP | `reAllocateNicIp()` | 先分配后释放 |
| IPv6 支持 | `APIAddIpv6RangeMsg` | ipVersion 字段区分 |

L3 网络的核心设计：**IP 分配无锁化**（数据库唯一约束保证原子性）、**策略可插拔**（IpAllocatorStrategy）、**双栈原生支持**（ipVersion 字段）。
