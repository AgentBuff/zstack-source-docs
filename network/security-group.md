# 安全组

安全组（SecurityGroup）是 ZStack 的分布式防火墙，通过 iptables + ipset 在每台 KVM 主机上实现 VM 级别的网络访问控制。本章分析安全组的架构、规则计算和 iptables 链设计。

## 安全组架构

```
┌──────────────────────────────────────────────────────┐
│         SecurityGroupManagerImpl (3661行)              │
│  ├── 安全组 CRUD                                      │
│  ├── 规则管理（添加/删除/启用/禁用/优先级）               │
│  ├── VM 网卡绑定/解绑                                  │
│  ├── 规则下发到主机（iptables + ipset）                  │
│  ├── SDN 委托模式                                     │
│  └── VM 迁移时规则同步                                  │
├──────────────────────────────────────────────────────┤
│  数据面 (kvmagent securitygroup_plugin.py)             │
│  ├── iptables 链层级                                   │
│  ├── ipset 高效匹配                                    │
│  ├── conntrack 清理                                   │
│  └── SDN 委托模式                                     │
└──────────────────────────────────────────────────────┘
```

## iptables 链层级设计

这是安全组最核心的设计——多层链嵌套实现高效规则匹配：

```
FORWARD 链
  └── sg-default (安全组总入口)
        ├── sg-vnic-in (网卡入方向)
        │     ├── sg-<uuid1>-in (安全组1 入规则)
        │     └── sg-<uuid2>-in (安全组2 入规则)
        └── sg-vnic-out (网卡出方向)
              ├── sg-<uuid1>-out (安全组1 出规则)
              └── sg-<uuid2>-out (安全组2 出规则)
```

### 链命名规则

```
sg-default          — 所有安全组规则的入口
sg-vnic-in          — 网卡入方向规则汇总
sg-vnic-out         — 网卡出方向规则汇总
sg-<sg-uuid>-in     — 某安全组的入方向规则
sg-<sg-uuid>-out    — 某安全组的出方向规则
```

## 规则计算引擎

> 源码路径：`zstack/plugin/securityGroup/src/main/java/org/zstack/network/securitygroup/SecurityGroupManagerImpl.java`

```java
// SecurityGroupManagerImpl 内部的规则计算逻辑
// 为每个 VM 网卡计算完整的 iptables 规则集
HostRuleTO calculateByVmNic(
        VmNicInventory nic,
        List<SecurityGroupInventory> groups) {
    HostRuleTO to = new HostRuleTO();
    to.setNicName(nic.getInternalName());  // 如 vnic1.0

    for (SecurityGroupInventory sg : groups) {
        // 入方向规则
        for (SecurityGroupRuleInventory rule : sg.getIngressRules()) {
            if (rule.getState().equals("Enabled")) {
                to.addIngressRule(sg.getUuid(), rule);
            }
        }
        // 出方向规则
        for (SecurityGroupRuleInventory rule : sg.getEgressRules()) {
            if (rule.getState().equals("Enabled")) {
                to.addEgressRule(sg.getUuid(), rule);
            }
        }
    }
    return to;
}
```

## 安全组规则数据模型

```java
// SecurityGroupRuleVO
@Entity
@Table
public class SecurityGroupRuleVO extends ResourceVO {
    @Column private String securityGroupUuid;
    @Column private SecurityGroupRuleType type;         // Ingress / Egress
    @Column private SecurityGroupRuleProtocolType protocol;     // TCP / UDP / ICMP / ALL
    @Column private int startPort;
    @Column private int endPort;
    @Column private SecurityGroupRuleState state;        // Enabled / Disabled
    @Column private String srcIpRange;   // 源 IP 范围 (入方向)
    @Column private String dstIpRange;   // 目标 IP 范围 (出方向)
    @Column private String allowedCidr;
    @Column private String remoteSecurityGroupUuid;
}
```

## kvmagent 端实现

> 源码路径：`zstack-utility/kvmagent/kvmagent/plugins/securitygroup_plugin.py`（733 行）

### 数据结构

```python
class VmNicSecurityTO(object):
    """VM 网卡安全组传输对象"""
    def __init__(self):
        self.name = None           # 网卡名 (vnic1.0)
        self.uuid = None           # 网卡 UUID
        self.mac = None            # MAC 地址
        self.ips = []              # IP 地址列表
        self.ingress_policy = None # 入方向默认策略 (DENY/ALLOW)
        self.egress_policy = None  # 出方向默认策略
        self.action_code = None    # 操作码 (applyChain/deleteChain/...)
        self.security_group_refs = []  # 安全组引用列表

    def _build_refs(self):
        # 按优先级排序安全组引用
        self.security_group_refs.sort(key=lambda r: r.priority)

class SecurityGroup(object):
    """安全组"""
    def __init__(self):
        self.uuid = None
        self.ingress_rules = []    # IPv4 入规则
        self.egress_rules = []     # IPv4 出规则
        self.ip6_ingress_rules = [] # IPv6 入规则
        self.ip6_egress_rules = [] # IPv6 出规则

    def add_rule(self, rule):
        if rule.version == 4:
            if rule.ruleType == 'Ingress':
                self.ingress_rules.append(rule)
            else:
                self.egress_rules.append(rule)
        else:
            if rule.ruleType == 'Ingress':
                self.ip6_ingress_rules.append(rule)
            else:
                self.ip6_egress_rules.append(rule)

class RuleTO(object):
    """规则传输对象"""
    def __init__(self):
        self.priority = None       # 优先级
        self.ruleType = None       # Ingress / Egress
        self.state = None          # Enabled / Disabled
        self.version = None        # 4 / 6
        self.protocol = None       # TCP / UDP / ICMP / ALL
        self.src_ips = None        # 源 IP (ipset 名或 CIDR)
        self.dst_ips = None        # 目标 IP
        self.dst_ports = None      # 目标端口范围
        self.action = None         # ACCEPT / DROP
        self.remote_group_uuid = None  # 远端安全组 UUID
        self.remote_group_vm_ips = None  # 远端安全组 VM IP 列表
```

### 规则应用流程

```python
class SecurityGroupPlugin(kvmagent.KvmAgent):
    # HTTP 端点
    APPLY_RULES_PATH = "/securitygroup/applyrules"
    REFRESH_RULES_ON_HOST_PATH = "/securitygroup/refreshrulesonhost"
    CLEANUP_UNUSED_RULES_PATH = "/securitygroup/cleanupunusedrules"
    UPDATE_GROUP_MEMBER_PATH = "/securitygroup/updategroupmember"
    CHECK_DEFAULT_RULES_PATH = "/securitygroup/checkdefaultrulesonhost"

    @kvmagent.handle_request(APPLY_RULES_PATH)
    def apply_rules(req):
        cmd = jsonobject.loads(req.body)
        # cmd.nics: 需要应用规则的网卡列表
        # cmd.security_groups: 安全组列表

        for nic in cmd.nics:
            if nic.action_code == 'applyChain':
                # 创建 iptables 链并应用规则
                _apply_chain(nic, cmd.security_groups)
            elif nic.action_code == 'deleteChain':
                # 删除网卡的 iptables 链
                _delete_chain(nic)
            elif nic.action_code == 'deleteGroup':
                # 从网卡删除某个安全组的规则
                _delete_group(nic)
            elif nic.action_code == 'updateGroup':
                # 更新安全组规则
                _update_group(nic, cmd.security_groups)
```

### ipset 高效匹配

```python
def _create_ipset_and_add_member(ipset_name, ips, ip_version=4):
    """创建 ipset 并添加 IP 成员"""
    family = "inet" if ip_version == 4 else "inet6"
    # 创建 ipset
    shell.call("ipset create %s hash:net family %s"
               % (ipset_name, family))
    # 添加 IP 成员
    for ip in ips:
        shell.call("ipset add %s %s" % (ipset_name, ip))

    # iptables 规则使用 ipset 匹配
    # -m set --match-set <ipset_name> src
    # 比 -s ip1 -s ip2 ... 高效得多
```

ipset 的优势：当安全组规则引用远端安全组时，远端安全组可能有数百个 VM IP。使用 ipset 可以将 O(n) 条 iptables 规则压缩为 1 条。

### conntrack 清理

```python
def _cleanup_conntrack(nic_ip, nic_name):
    """清理连接跟踪表"""
    # 当安全组规则变更时，需要清理已有的连接
    # 否则旧规则可能继续生效
    shell.call("conntrack -D -s %s" % nic_ip)  # 源方向
    shell.call("conntrack -D -d %s" % nic_ip)  # 目标方向
    shell.call("conntrack -D -r %s" % nic_ip)  # 回复方向
```

## VM 迁移时的安全组处理

```java
// SecurityGroupManagerImpl 实现 VmInstanceMigrateExtensionPoint

@Override
public void beforeMigrateVm(VmInstanceInventory vm) {
    // 迁移前：无需操作
    // 规则已在目标主机上准备（通过 SDN 或直接下发）
}

@Override
public void afterMigrateVm(VmInstanceInventory vm) {
    // 迁移后：在目标主机上刷新安全组规则
    for (VmNicInventory nic : vm.getVmNics()) {
        refreshVmSecurityGroupRules(nic, targetHost);
    }
    // 迁移后：清理源主机上的规则
    for (VmNicInventory nic : vm.getVmNics()) {
        cleanupNicRulesOnHost(nic, sourceHost);
    }
}

@Override
public void failedToMigrateVm(VmInstanceInventory vm) {
    // 迁移失败：确保源主机规则仍然有效
    for (VmNicInventory nic : vm.getVmNics()) {
        refreshVmSecurityGroupRules(nic, sourceHost);
    }
}
```

## SDN 委托模式

当 L2 网络使用 SDN 控制器时，安全组规则可以委托给 SDN 控制器：

```java
// SecurityGroupGetSdnBackendExtensionPoint
// SdnControllerManagerImpl 实现此接口

@Override
public SecurityGroupSdnBackend getSecurityGroupSdnBackend(
        String sdnControllerUuid) {
    SdnControllerVO vo = dbf.findByUuid(
        sdnControllerUuid, SdnControllerVO.class);
    SdnControllerFactory factory =
        getSdnControllerFactory(vo.getVendorType());
    return factory.getSdnControllerSecurityGroup(vo);
}

// SDN 模式下，安全组规则不通过 iptables 下发
// 而是通过 SDN 控制器的 API 下发
// 如 H3C VCFC、Tungsten Fabric 等
```

## FailureHostWorker — 故障主机恢复

```java
class FailureHostWorker extends Thread {
    // 定期检查故障主机
    // 当主机恢复后，重新应用安全组规则
    @Override
    public void run() {
        while (true) {
            List<HostVO> failedHosts = getFailedHosts();
            for (HostVO host : failedHosts) {
                if (isHostConnected(host)) {
                    // 主机恢复，重新应用所有安全组规则
                    refreshAllRulesOnHost(host);
                }
            }
            Thread.sleep(interval);
        }
    }
}
```

## 默认规则

```java
// createDefaultRule() — 创建安全组时自动添加默认规则
private void createDefaultRule(String sgUuid, int ipVersion) {
    // 默认入方向：允许同安全组内通信 + 允许所有 CIDR
    SecurityGroupRuleVO ingress = new SecurityGroupRuleVO();
    ingress.setType(SecurityGroupRuleType.Ingress);
    ingress.setProtocol(SecurityGroupRuleProtocolType.ALL);
    ingress.setRemoteSecurityGroupUuid(sgUuid);
    ingress.setAllowedCidr(WORLD_OPEN_CIDR);
    ingress.setAction(SecurityGroupRuleAction.ACCEPT.toString());
    // 默认出方向：允许所有
    SecurityGroupRuleVO egress = new SecurityGroupRuleVO();
    egress.setType(SecurityGroupRuleType.Egress);
    egress.setProtocol(SecurityGroupRuleProtocolType.ALL);
    egress.setRemoteSecurityGroupUuid(sgUuid);
    egress.setAllowedCidr(WORLD_OPEN_CIDR);
    egress.setAction(SecurityGroupRuleAction.ACCEPT.toString());
}
```

注意：安全组的默认策略（policy）是入方向 DENY、出方向 ALLOW，即未匹配任何规则时拒绝入站流量、允许出站流量。

## 小结

| 组件 | 职责 | 关键设计 |
|------|------|----------|
| SecurityGroupManagerImpl | 安全组生命周期 | 3661行，最大单文件管理器 |
| 规则计算 | 按 VM 网卡聚合规则 | SecurityGroupManagerImpl 内部逻辑 |
| iptables 链 | 规则下发 | 多层嵌套链 |
| ipset | 高效 IP 匹配 | O(n) → O(1) |
| conntrack | 连接清理 | 规则变更时清理 |
| SDN 委托 | SDN 模式 | 委托给 SDN 控制器 |
| FailureHostWorker | 故障恢复 | 定期重试 |

安全组的设计精髓：**多层链嵌套实现规则隔离，ipset 实现高效匹配，SDN 委托实现多后端支持**。
