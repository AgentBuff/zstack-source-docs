# 虚拟路由器 Agent

VirtualRouter Agent 是部署在虚拟路由器 VM 内的 Python Agent，负责 DHCP、DNS、EIP、SNAT、LB、端口转发等网络服务。监听 **端口 7272**。

## 目录结构

```
virtualrouter/virtualrouter/
├── __init__.py              (1行)
├── virtualrouter.py         (116行, 核心入口)
├── virtualrouterdaemon.py   (42行, 守护进程启动器)
└── plugins/
    ├── configure_nic.py      (129行, 网卡配置)
    ├── dns.py                (121行, DNS管理)
    ├── dnsmasq.py            (355行, DHCP服务, 最大插件)
    ├── echo.py               (25行, 健康检查)
    ├── eip.py                (184行, 弹性IP)
    ├── lb.py                 (148行, 负载均衡)
    ├── port_forwarding.py    (157行, 端口转发)
    ├── snat.py               (147行, 源地址转换)
    └── vip.py                (71行, 虚拟IP)
```

## 核心架构

### 入口与启动流程

```python
# virtualrouter/virtualrouter/virtualrouter.py
class VRAgent(plugin.Plugin):
    """插件基类，空类"""
    pass

class VirtualRouter(object):
    http_server = http.HttpServer()
    http_server.port = 7272  # 固定端口

    def __init__(self):
        self.plugin_path = os.path.join(os.path.dirname(os.path.realpath(__file__)), 'plugins')
        self.plugin_rgty = plugin.PluginRegistry(self.plugin_path)

    def start(self, in_thread=True):
        self.plugin_rgty.configure_plugins(self)  # 注入 VR 实例
        self.plugin_rgty.start_plugins()
        self.http_server.register_async_uri('/init', self.init)
        self.http_server.register_async_uri('/ping', self.ping)
        if in_thread:
            self.http_server.start_in_thread()
        else:
            self.http_server.start()
```

启动链路：
```
virtualrouterdaemon.py::main()
  → VirutalRouterDaemon(pidfile, py_process_name)
    → VirtualRouter()
      → PluginRegistry(plugins/)
      → start()
        → configure_plugins(self)     # 将 VirtualRouter 实例注入插件
        → start_plugins()             # 调用各插件 start()
        → register_async_uri(/init, /ping)
        → HttpServer.start_in_thread()
```

### 与管理节点通信

VirtualRouter Agent **不主动连接管理节点**，被动等待管理节点通过 HTTP 请求调用：

```
管理节点 ──HTTP POST──→ VR Agent (port 7272)
         ←──JSON Response──
```

- `/init` 端点接收 VR 的 UUID
- `/ping` 返回该 UUID 供管理节点识别

## 完整 HTTP 端点映射

| 插件 | 端点路径 | 方法 | 功能 |
|------|----------|------|------|
| 核心 | `/init` | `VirtualRouter.init` | 初始化，接收 UUID |
| 核心 | `/ping` | `VirtualRouter.ping` | 心跳检测 |
| echo | `/echo` | `EchoPlugin.echo` | 健康检查（唯一同步端点） |
| configure_nic | `/configurenic` | `NicPlugin.configure_nic` | 配置网卡 IP |
| dns | `/setdns` | `Dns.set_dns` | 设置 DNS |
| dns | `/removedns` | `Dns.remove_dns` | 移除 DNS |
| dnsmasq | `/adddhcp` | `Dnsmasq.add_dhcp_entry` | 添加 DHCP 条目 |
| dnsmasq | `/removedhcp` | `Dnsmasq.remove_dhcp_entry` | 删除 DHCP 条目 |
| eip | `/createeip` | `Eip.create_eip` | 创建弹性 IP |
| eip | `/removeeip` | `Eip.remove_eip` | 删除弹性 IP |
| eip | `/synceip` | `Eip.sync_eip` | 同步弹性 IP |
| lb | `/lb/refresh` | `Lb.refresh` | 刷新负载均衡 |
| lb | `/lb/delete` | `Lb.delete` | 删除负载均衡 |
| port_forwarding | `/createportforwarding` | `PortForwarding.create_rule` | 创建端口转发 |
| port_forwarding | `/revokeportforwarding` | `PortForwarding.revoke_rule` | 撤销端口转发 |
| port_forwarding | `/syncportforwarding` | `PortForwarding.sync_rule` | 同步端口转发 |
| snat | `/setsnat` | `Snat.set_snat` | 设置 SNAT |
| snat | `/removesnat` | `Snat.remove_snat` | 移除 SNAT |
| snat | `/syncsnat` | `Snat.sync_snat` | 同步 SNAT |
| vip | `/createvip` | `Vip.create_vip` | 创建虚拟 IP |
| vip | `/removevip` | `Vip.remove_vip` | 删除虚拟 IP |

## 各插件核心逻辑

### configure_nic — 网卡配置

- 通过 `ip link` 获取 MAC→网卡名映射
- 写入 `/etc/sysconfig/network-scripts/ifcfg-<nic>` 配置文件
- 调用 `/sbin/ifup` 激活网卡
- 为非管理网卡创建 iptables 入站链 `<nic>-in`，默认规则：允许 ESTABLISHED/DHCP/DNS/ICMP/SSH，拒绝其余
- 使用 `@lock.file_lock('/run/xtables.lock')` 防止 iptables 并发

### dnsmasq — DHCP 服务（最复杂插件，355 行）

管理 4 个配置文件：

| 文件 | 用途 |
|------|------|
| `/etc/hosts.dhcp` | DHCP 条目（MAC→IP 映射） |
| `/etc/hosts.leases` | 租约文件 |
| `/etc/hosts.option` | DHCP 选项（网关/DNS/子网掩码） |
| `/etc/hosts.dns` | DNS 主机映射 |

```python
# virtualrouter/virtualrouter/plugins/dnsmasq.py
class DhcpEntry(object):
    def to_dhcp_entry_string(self):      # DHCP 条目格式
    def to_dhcp_option_string_list(self): # DHCP 选项格式
    def to_host_entry_string(self):       # DNS 主机格式
```

- **增量合并** (`_merge`) vs **全量重建** (`_rebuild_all`)：由 `cmd.rebuild` 字段控制
- 智能刷新策略：累计 SIGHUP 超过阈值后改为 restart
- 删除 DHCP 条目时调用 `dhcp_release` 释放租约

### eip — 弹性 IP

基于 iptables NAT 表实现 DNAT/SNAT：

```python
# virtualrouter/virtualrouter/plugins/eip.py
# 链命名规则：eip-{type}-{vip_nic}-{priv_nic}
# 例如：eip-dnat-eth2-eth0
# 支持 snatInboundTraffic 选项：为入站流量添加网关 SNAT
# sync_eip：先清除所有 eip- 前缀链，再重建
```

### lb — 负载均衡

使用 **HAProxy** 作为 LB 引擎：

```python
# virtualrouter/virtualrouter/plugins/lb.py
# Jinja2 模板生成 HAProxy 配置文件 /etc/haproxy/<lbUuid>-<listenerUuid>.cfg
# 优雅重载：haproxy -D -f <cfg> -p <pid> -sf $(cat <pid>)
# 重载前用 iptables 临时 DROP SYN 包防止连接丢失
# 使用 @rollback 装饰器实现操作回滚
# 配置未变（md5sum 相同）时跳过重载
```

### port_forwarding — 端口转发

```python
# virtualrouter/virtualrouter/plugins/port_forwarding.py
# 链命名：pf-{type}-{vip_nic}-{protocol}-{port}
# 支持 allowedCidr 源地址限制
# 支持 snatInboundTraffic 网关 SNAT
# sync_rule：先清除所有 pf- 前缀链再重建
```

### snat — 源地址转换

```python
# virtualrouter/virtualrouter/plugins/snat.py
# 链命名：snat-{type}-{priv_nic}
# 创建 SNAT 链 + FORWARD 链（含同网卡转发规则）
```

### vip — 虚拟 IP

最简插件（71 行），调用 `linux.create_vip_if_not_exists()` / `linux.delete_vip_by_ip_if_exists()`。

## iptables 链命名约定

所有网络服务插件遵循统一的链命名约定：

```
{功能前缀}-{类型}-{网卡名/协议/端口}
```

示例：
- `eip-dnat-eth2-eth0` — EIP DNAT 规则
- `pf-fwd-eth2-tcp-80` — 端口转发规则
- `snat-fwd-eth0` — SNAT 规则

## 与 kvmagent 架构对比

| 维度 | VirtualRouter Agent | KVM Agent |
|------|---------------------|-----------|
| **端口** | 7272 | 7070 |
| **插件基类** | `VRAgent(plugin.Plugin)` | `KvmAgent(plugin.Plugin)` |
| **插件数量** | 9 个 | 44 个 |
| **核心操作** | iptables NAT/Filter + dnsmasq/haproxy | QEMU/Libvirt 虚拟机管理 |
| **HA 机制** | 无 | `ha_cleanup_handlers` |
| **监控采集** | 无 | `metric_collectors` |
| **init 端点** | 有，接收 UUID | 无 |
| **配置注入** | `configure_plugins(self)` 传入 VR 实例 | `configure_plugins(config)` 传入 dict |

**关键差异**：VR Agent 是**网络功能专用 Agent**，核心操作围绕 iptables NAT/Filter 规则和 dnsmasq/haproxy 服务；kvmagent 是**计算功能 Agent**，核心操作围绕 QEMU/Libvirt 虚拟机管理。

## 关键设计模式

| 模式 | 实现 | 说明 |
|------|------|------|
| **声明式一致性** | `sync_*` 方法先清除再重建 | 确保规则状态与管理节点一致 |
| **双重锁机制** | `@lock.lock()` + `@lock.file_lock()` | 防止并发操作 iptables |
| **优雅重载** | HAProxy `-sf` 参数 | 零宕机重启 LB |
| **回滚** | `@rollback` 装饰器 | 操作失败时自动回滚 |
| **链命名约定** | `{功能}-{类型}-{网卡}` | 统一的 iptables 链命名 |
