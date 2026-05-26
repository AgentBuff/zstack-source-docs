# kvmagent 详解

kvmagent 是部署在 KVM 计算节点上的 Python Agent，负责接收管理节点的 HTTP 指令，通过 libvirt API 管理 VM 生命周期。通信模型为 **管理节点 → HTTP(7070) → kvmagent → libvirt → QEMU/KVM**。

## 核心类关系

```
kvmagent.py
├── KvmAgent (extends plugin.Plugin)     — 插件基类
├── KvmRESTService                        — HTTP 服务器 + 插件注册中心
├── KvmDaemon (extends daemon.Daemon)     — 守护进程
├── replyerror                            — 统一错误处理装饰器
└── AgentResponse / AgentCommand          — 响应/请求基类

plugins/vm_plugin.py (13179行)
├── VmPlugin (extends KvmAgent)           — VM 生命周期插件
└── Vm                                     — VM 对象模型（libvirt 封装）
```

## kvmagent.py — 主入口

### KvmAgent 类

```python
# kvmagent/kvmagent/kvmagent.py
class KvmAgent(plugin.Plugin):
    def __init__(self):
        linux.recover_fake_dead('kvmagent')  # 恢复假死状态
        super(KvmAgent, self).__init__()
```

继承自 `zstacklib.utils.plugin.Plugin`，是所有插件的基类。构造时调用 `recover_fake_dead()` 检测并恢复之前因假死而残留的进程。

### KvmRESTService — HTTP 服务器与插件注册中心

```python
# kvmagent/kvmagent/kvmagent.py
class KvmRESTService(object):
    http_server = http.HttpServer()
    http_server.logfile_path = log.get_logfile_path()

    def __init__(self, config={}):
        self.plugin_path = self._get_config(self.PLUGIN_PATH) \
            or os.path.join(os.path.dirname(os.path.realpath(__file__)), 'plugins')
        self.plugin_rgty = plugin.PluginRegistry(self.plugin_path)

    def start(self, in_thread=True):
        self.plugin_rgty.configure_plugins(config)
        self.plugin_rgty.start_plugins()
        if in_thread:
            self.http_server.start_in_thread()
        else:
            self.http_server.start()
```

关键设计：
- **HTTP 服务器**：基于 CherryPy 封装，监听 **端口 7070**
- **插件注册表**：`PluginRegistry` 扫描 `plugins/` 目录，动态加载所有插件
- **启动流程**：先 `configure_plugins()` → 再 `start_plugins()` → 最后启动 HTTP 服务器

### KvmDaemon — 守护进程模式

```python
# kvmagent/kvmagent/kvmagent.py
class KvmDaemon(daemon.Daemon):
    def run(self):
        self.agent = new_rest_service()
        self.agent.start(in_thread=False)  # 阻塞模式
```

### 全局注册机制

```python
# kvmagent/kvmagent/kvmagent.py
ha_cleanup_handlers = []       # HA 清理回调
metric_collectors = []         # Prometheus 指标收集器

def register_ha_cleanup_handler(handler):    # 注册 HA 清理处理器
def register_prometheus_collector(collector): # 注册 Prometheus 收集器
```

## vm_plugin.py — VM 生命周期管理（13179 行）

### VmPlugin 类

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
class VmPlugin(kvmagent.KvmAgent):
    KVM_START_VM_PATH = "/vm/start"
    KVM_STOP_VM_PATH = "/vm/stop"
    KVM_REBOOT_VM_PATH = "/vm/reboot"
    KVM_DESTROY_VM_PATH = "/vm/destroy"
    KVM_ATTACH_VOLUME = "/vm/attachdatavolume"
    KVM_DETACH_VOLUME = "/vm/detachdatavolume"
    KVM_MIGRATE_VM_PATH = "/vm/migrate"
    # ... 100+ 路径常量
```

### start() — 插件启动与路由注册

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
def start(self):
    http_server = kvmagent.get_http_server()
    http_server.register_async_uri(self.KVM_START_VM_PATH, self.start_vm, cmd=StartVmCmd())
    http_server.register_async_uri(self.KVM_STOP_VM_PATH, self.stop_vm)
    http_server.register_async_uri(self.KVM_REBOOT_VM_PATH, self.reboot_vm)
    http_server.register_async_uri(self.KVM_DESTROY_VM_PATH, self.destroy_vm)
    http_server.register_async_uri(self.KVM_ATTACH_VOLUME, self.attach_data_volume)
    http_server.register_async_uri(self.KVM_DETACH_VOLUME, self.detach_data_volume)
    http_server.register_async_uri(self.KVM_MIGRATE_VM_PATH, self.migrate_vm)
    # ... 100+ 路由注册
```

- `register_async_uri()` — 异步处理（Agent 处理完后回调管理节点）
- `register_sync_uri()` — 同步处理（管理节点等待 HTTP 响应）
- `cmd=StartVmCmd()` 参数用于请求体的 JSON 反序列化模板

### start_vm — 启动虚拟机

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
@kvmagent.replyerror
def start_vm(self, req):
    cmd = jsonobject.loads(req[http.REQUEST_BODY])
    rsp = StartVmResponse()
    self._record_operation(cmd.vmInstanceUuid, self.VM_OP_START)
    self._start_vm(cmd)
    # 成功后收集设备信息
    rsp.nicInfos, rsp.virtualDeviceInfoList, rsp.memBalloonInfo = \
        self.get_vm_device_info(cmd.vmInstanceUuid)
    return jsonobject.dumps(rsp)

def _start_vm(self, cmd):
    vm = get_vm_by_uuid_no_retry(cmd.vmInstanceUuid, False)
    if vm and vm.state == Vm.VM_STATE_RUNNING:
        return  # 已运行，幂等处理
    vm = Vm.from_StartVmCmd(cmd)  # 从命令构建 Vm 对象（含 libvirt XML）
    vm.start(cmd.timeout, cmd.createPaused, wait_console)  # 调用 libvirt 启动
```

### stop_vm — 停止虚拟机

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
def _stop_vm(self, cmd):
    strategy = str(cmd.type)  # "grace" / "cold" / "force"
    if strategy == "cold" or strategy == "force":
        vm.stop(strategy=strategy)
    else:
        vm.stop(timeout=cmd.timeout / 2)
    # finally 中强制 kill_vm() 确保进程清理
```

### Vm 对象模型

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
class Vm(object):
    VIR_DOMAIN_RUNNING = 1
    VIR_DOMAIN_PAUSED = 3
    VIR_DOMAIN_SHUTDOWN = 4
    VIR_DOMAIN_SHUTOFF = 5

    VM_STATE_RUNNING = 'Running'
    VM_STATE_PAUSED = 'Paused'
    VM_STATE_SHUTDOWN = 'Shutdown'

    power_state = {
        VIR_DOMAIN_RUNNING: VM_STATE_RUNNING,
        VIR_DOMAIN_PAUSED: VM_STATE_PAUSED,
        VIR_DOMAIN_SHUTOFF: VM_STATE_SHUTDOWN,
    }

    def __init__(self):
        self.uuid = None
        self.domain_xmlobject = None   # 解析后的 XML 对象
        self.domain_xml = None          # 原始 XML 字符串
        self.domain = None              # libvirt domain 对象
        self.state = None
```

### Vm.start() — 通过 libvirt 启动 VM

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
def start(self, timeout=60, create_paused=False, wait_console=True):
    @LibvirtAutoReconnect
    def define_xml(conn):
        # 支持 XML hook 修改
        xml_hook = self.get_user_defined_xml_hook()
        if xml_hook is not None:
            self.domain_xml = xmlhook.get_modified_xml_from_hook(xml_hook, self.domain_xml)
        return conn.defineXML(self.domain_xml)

    domain = define_xml()
    self.domain = domain
    flag = (0, libvirt.VIR_DOMAIN_START_PAUSED)[create_paused]
    self.domain.createWithFlags(flag)
```

### Vm.from_StartVmCmd() — 构建 libvirt XML

这是最核心的方法，从 `StartVmCmd` 构建 libvirt domain XML：

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
@staticmethod
def from_StartVmCmd(cmd):
    elements = {}

    def make_root():
        root = etree.Element('domain')
        root.set('type', get_domain_type())  # 'kvm' or 'qemu'

    def make_memory_backing():
        # HugePage、nosharepages、shared access 配置

    def make_cpu():
        # 按 x86_64/aarch64/mips64el/loongarch64 分别构建 CPU topology
        # 支持 host-model / host-passthrough / custom 模式

    # ... make_os(), make_devices(), make_nic(), make_disk() 等
    # 最终生成完整的 libvirt domain XML
```

XML 构建采用嵌套函数 + `elements` 字典的模式，每个 `make_xxx()` 函数负责一个 XML 子树。

### 远程存储抽象

```python
# kvmagent/kvmagent/plugins/vm_plugin.py
class RemoteStorageFactory:
    @staticmethod
    def get_remote_storage(cmd):
        if cmd.storageInfo.type == 'nfs':   return NfsRemoteStorage(cmd)
        elif cmd.storageInfo.type == 'sshfs': return SshfsRemoteStorage(cmd)
        elif cmd.storageInfo.type == 'nbd':  return NbdRemoteStorage(cmd)
        return SshfsRemoteStorage(cmd)  # 默认 SSHFS
```

## 其他关键插件

| 插件文件 | 行数 | 职责 |
|----------|------|------|
| vm_plugin.py | 13179 | VM 生命周期（启动/停止/迁移/快照/卷管理） |
| network_plugin.py | 1610 | L2 网桥创建/删除（VLAN, VXLAN, bonding, LLDP, ipset） |
| securitygroup_plugin.py | 733 | 安全组规则应用 |
| mevoco.py | 2778 | Flat provider 的 DHCP/metadata 服务 |
| deip.py | 710 | EIP 实现（namespace + veth pair + iptables） |
| ceph_storage_plugin.py | - | Ceph 存储操作 |
| host_plugin.py | - | 主机连接管理 |

## 关键设计模式

| 模式 | 实现 | 说明 |
|------|------|------|
| **Plugin 模式** | `PluginRegistry` + `KvmAgent` 基类 | 42 个插件动态加载 |
| **HTTP RPC** | CherryPy + `register_async/sync_uri` | 管理节点通过 HTTP JSON 调用 |
| **统一错误处理** | `@replyerror` 装饰器 | 所有 handler 自动捕获异常 |
| **命令对象模式** | `AgentCommand` / `AgentResponse` | 请求/响应强类型化 |
| **XML Builder** | `etree.Element` + 嵌套 `make_xxx()` | 渐进式构建 libvirt domain XML |
| **自动重连** | `@LibvirtAutoReconnect` 装饰器 | libvirt 连接断开时自动重连 |
| **操作记录** | `TimeoutObject` + `VmOperationJudger` | 防止并发冲突操作 |
| **存储策略** | `RemoteStorageFactory` | Factory 模式按类型选择存储 |
| **HA 清理** | `ha_cleanup_handlers` | 主机故障时清理残留资源 |
