# Flat 网络提供者（分布式网关）

Flat Provider 是 ZStack 的分布式网络服务提供者，它在每台 KVM 主机上通过 Linux namespace 提供 DHCP、DNS、SNAT、EIP 等服务，无需集中式虚拟路由器。本章分析 Flat 的架构与实现。

## Flat vs VirtualRouter 对比

```
┌─────────────────────────────────────────────────────┐
│  Flat (分布式)                                       │
│  每台主机独立提供网络服务                               │
│  ┌──────┐  ┌──────┐  ┌──────┐                       │
│  │Host-A│  │Host-B│  │Host-C│                       │
│  │ ns0  │  │ ns0  │  │ ns0  │  ← 每台主机有 namespace │
│  │DHCP  │  │DHCP  │  │DHCP  │                       │
│  │SNAT  │  │SNAT  │  │SNAT  │                       │
│  └──────┘  └──────┘  └──────┘                       │
│  优点：无单点故障，性能好                               │
│  缺点：无集中式 NAT/EIP                                │
├─────────────────────────────────────────────────────┤
│  VirtualRouter (集中式)                               │
│  所有流量经过 VR 虚拟机                                 │
│  ┌──────┐  ┌──────┐  ┌──────┐                       │
│  │Host-A│  │Host-B│  │Host-C│                       │
│  └──┬───┘  └──┬───┘  └──┬───┘                       │
│     │         │         │                            │
│     └─────────┼─────────┘                            │
│               ▼                                      │
│         ┌──────────┐                                 │
│         │    VR    │  ← 集中式网关                     │
│         │DHCP/SNAT │                                 │
│         │EIP/LB    │                                 │
│         └──────────┘                                 │
│  优点：功能完整，集中管理                               │
│  缺点：单点故障（需 HA），性能瓶颈                       │
└─────────────────────────────────────────────────────┘
```

## FlatProvider — 极简实现

> 源码路径：`zstack/plugin/flatNetworkProvider/src/main/java/org/zstack/network/service/flat/FlatProvider.java`

```java
public class FlatProvider implements NetworkServiceProvider {
    private NetworkServiceProviderVO self;

    @Override
    public void handleMessage(Message msg) {
        // Flat 不处理任何消息
        // 所有逻辑在 NetworkServiceExtensionPoint 实现中
    }

    @Override
    public void attachToL2Network(L2NetworkInventory l2Network,
            APIAttachNetworkServiceProviderToL2NetworkMsg msg) {
        // 挂载时无需额外操作
    }

    @Override
    public void detachFromL2Network(L2NetworkInventory l2Network,
            APIDetachNetworkServiceProviderFromL2NetworkMsg msg) {
        // 卸载时无需额外操作
    }
}
```

Flat 的 Provider 实现是空壳——真正的逻辑分散在各个 Extension 中。这是 ZStack 网络服务模型的设计哲学：**Provider 是身份标识，Extension 是行为实现**。

## Flat DHCP — Namespace 模式

Flat 的 DHCP 服务通过 Linux namespace 在每台主机上提供。核心实现在 kvmagent 的 mevoco.py 中：

> 源码路径：`zstack-utility/kvmagent/kvmagent/plugins/mevoco.py`

### NamespaceInfraEnv — 基础设施

```python
class NamespaceInfraEnv(object):
    """
    网络拓扑：
    VM ── vm_bridge (br_<l2uuid_short>)
          │
          near_vm_outer ── NAMESPACE ── near_host_outer
                                          │
                                     br_conn_all_ns (主机桥)
                                          │
                                     169.254.64.1 (主机端)
                                     169.254.64.2 (namespace 端)
    """
    CONNECT_ALL_NETNS_BR_NAME = "br_conn_all_ns"
    CONNECT_ALL_NETNS_BR_OUTER_IP = "169.254.64.1"
    CONNECT_ALL_NETNS_BR_INNER_IP = "169.254.64.2"
    IP_MASK_BIT = 18

    def __init__(self, vm_bridge_name, namespace_name):
        self.vm_bridge_name = vm_bridge_name
        self.namespace_name = namespace_name
        # 从 namespace ID 派生设备名
        ns_id = namespace_name[-8:]
        self.near_vm_outer = "nvm_%s_o" % ns_id
        self.near_vm_inner = "nvm_%s_i" % ns_id
        self.near_host_outer = "nht_%s_o" % ns_id
        self.near_host_inner = "nht_%s_i" % ns_id
```

### prepare_dev — 创建 Namespace 基础设施

```python
@lock.lock('namespace_infra_env')
def prepare_dev(self):
    # 1. 创建 namespace
    self._create_namespace_if_not_exist()
    # 2. 创建主机桥 br_conn_all_ns（所有 namespace 共享）
    self._create_host_bridge_if_not_exist()
    # 3. 创建 veth pair: near_vm_outer ↔ near_vm_inner
    #    near_vm_outer 加入 vm_bridge
    #    near_vm_inner 加入 namespace
    self._create_link_pair_to_br_and_ns(
        self.near_vm_outer, self.near_vm_inner,
        self.vm_bridge_name, self.namespace_name)
    # 4. 创建 veth pair: near_host_outer ↔ near_host_inner
    #    near_host_outer 加入 br_conn_all_ns
    #    near_host_inner 加入 namespace
    self._create_link_pair_to_br_and_ns(
        self.near_host_outer, self.near_host_inner,
        self.CONNECT_ALL_NETNS_BR_NAME, self.namespace_name)
    # 5. 配置 IP 地址
    self._add_host_bridge_ip_if_not_exist()
    self._add_near_host_inner_ip_if_not_exist()
    # 6. 禁用 namespace 内 IPv6 RA
    self._set_namespace_attribute()
```

### add_ip_eb_tables — 元数据服务路由

```python
@lock.lock('namespace_infra_env')
@lock.file_lock('/run/xtables.lock')
def add_ip_eb_tables(self, l3_uuid, gateway_ip, dhcp_server_ip):
    # DNAT: VM 访问 169.254.169.254 → 重定向到 namespace 内的 metadata 服务
    # ebtables 规则在 vm_bridge 上拦截
    ebtables.run(
        "ebtables -t nat -A PREROUTING -i %s -p IPv4 "
        "-d %s --ip-dst 169.254.169.254 -j dnat "
        "--to-destination %s --dnat-target ACCEPT"
        % (self.near_vm_outer, gateway_mac, dhcp_server_mac))
    # iptables 规则在 namespace 内处理
    shell.call("ip netns exec %s iptables -t nat -A PREROUTING "
               "-d 169.254.169.254 -j DNAT --to-destination %s"
               % (self.namespace_name, dhcp_server_ip))
```

## Flat EIP — 分布式弹性 IP

Flat 的 EIP 实现在 kvmagent 的 deip.py 中，使用 network namespace + veth pair + iptables：

> 源码路径：`zstack-utility/kvmagent/kvmagent/plugins/deip.py`

### Eip.apply_eip — 应用 EIP

```python
class Eip(object):
    PUB_ODEV = "pub_odev"  # 公网端 veth 外侧
    PUB_IDEV = "pub_idev"  # 公网端 veth 内侧（namespace 内）
    PRI_ODEV = "pri_odev"  # 私网端 veth 外侧
    PRI_IDEV = "pri_idev"  # 私网端 veth 内侧（namespace 内）

    def apply_eip(self, eip_str):
        # 解析 EIP 描述字符串
        # eip:uuid,eip_addr:172.20.51.136,vnic:eth0,vnic_ip:10.0.0.1,
        # vm:uuid,vip:uuid
        info = self.parse_eip_string(eip_str)
        namespace = self.generate_namespace_name(
            info['bridge'], info['eip_addr'])

        # 1. 创建 veth pair: pub_odev ↔ pub_idev
        create_dev_if_needed(self.PUB_ODEV, self.PUB_IDEV)
        # 2. pub_odev 加入公网网桥
        add_dev_to_br_if_needed(self.PUB_ODEV, public_bridge)
        # 3. pub_idev 加入 namespace，配置 VIP
        add_dev_namespace_if_needed(self.PUB_IDEV, namespace)
        set_ip_to_idev_if_needed(self.PUB_IDEV, eip_addr, namespace)

        # 4. 创建 veth pair: pri_odev ↔ pri_idev
        create_dev_if_needed(self.PRI_ODEV, self.PRI_IDEV)
        # 5. pri_odev 加入私网网桥
        add_dev_to_br_if_needed(self.PRI_ODEV, vm_bridge)
        # 6. pri_idev 加入 namespace，配置私网 IP
        add_dev_namespace_if_needed(self.PRI_IDEV, namespace)
        set_ip_to_idev_if_needed(self.PRI_IDEV, vnic_ip, namespace)

        # 7. 配置 iptables NAT 规则
        # DNAT: 公网 → 私网
        create_iptable_rule_if_needed(namespace,
            "PREROUTING -d %s -j DNAT --to-destination %s"
            % (eip_addr, vnic_ip))
        # SNAT: 私网 → 公网
        create_iptable_rule_if_needed(namespace,
            "POSTROUTING -s %s -j SNAT --to-source %s"
            % (vnic_ip, eip_addr))
```

### Eip.delete_eip — 删除 EIP

```python
def delete_eip(self, eip_str):
    info = self.parse_eip_string(eip_str)
    namespace = self.generate_namespace_name(
        info['bridge'], info['eip_addr'])

    # 1. 删除 namespace（自动清理 veth pair 和 iptables 规则）
    self.delete_eip_with_ns(namespace, info)
    # 2. 清理 SR-IOV VF 的 FDB 条目
    self.del_bridge_fdb_entry_for_pri_idev(info)
```

## Flat SNAT — 分布式源地址转换

Flat 的 SNAT 与 EIP 共享 namespace 基础设施。SNAT 规则在 namespace 内配置：

```python
# 在 namespace 内添加 SNAT 规则
# 让私网 VM 可以通过公网 IP 访问外网
shell.call("ip netns exec %s iptables -t nat -A POSTROUTING "
           "-s %s -j SNAT --to-source %s"
           % (namespace, guest_cidr, snat_public_ip))
```

## Flat Provider 自动挂载

Flat Provider 在 L2 网络创建后自动挂载，与 VR 类似：

```java
// FlatProviderFactory.afterCreateL2Network()
// Flat 自动挂载到所有类型的 L2 网络
// 包括 NoVlan、Vlan、Vxlan
@Override
public void afterCreateL2Network(L2NetworkInventory l2) {
    attachFlatNetworkServiceProviderToL2Network(l2.getUuid());
}
```

## Flat 与 VR 共存

同一个 L3 网络可以同时绑定 Flat 和 VR 的不同服务：

```
L3-Guest:
  Flat → DHCP, DNS, SNAT    (分布式)
  VR   → EIP, PortForwarding (集中式)
```

这种混合模式让用户可以享受分布式的性能优势，同时保留 VR 的高级网络服务。

## 数据面流量路径

### Flat DHCP 流量

```
VM (DHCP Discover)
  → vm_bridge
  → near_vm_outer (veth)
  → near_vm_inner (namespace 内)
  → dnsmasq (namespace 内, 192.168.1.3)
  → DHCP Offer/ACK
```

### Flat EIP 流量

```
外部 → 公网网桥 → pub_odev → namespace → DNAT → pri_idev → 私网网桥 → VM
VM   → 私网网桥 → pri_odev → namespace → SNAT → pub_idev → 公网网桥 → 外部
```

### Flat Metadata 流量

```
VM → 169.254.169.254
  → vm_bridge (ebtables DNAT)
  → namespace (iptables DNAT)
  → metadata 服务 (169.254.64.2:80)
```

## 小结

| 服务 | 实现方式 | 关键文件 |
|------|----------|----------|
| DHCP | namespace + dnsmasq | `mevoco.py: NamespaceInfraEnv` |
| DNS | namespace + dnsmasq | `mevoco.py: NamespaceInfraEnv` |
| SNAT | namespace + iptables SNAT | `mevoco.py` |
| EIP | namespace + veth + iptables DNAT/SNAT | `deip.py: Eip` |
| Metadata | ebtables DNAT + namespace | `mevoco.py: add_ip_eb_tables` |

Flat 的设计精髓：**每台主机独立提供网络服务，通过 namespace 隔离**。无单点故障，无性能瓶颈，但功能集不如 VR 完整（无 LB、无 HA）。
