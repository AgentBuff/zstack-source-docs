# zstacklib 共享库

zstacklib 是所有 ZStack Agent 共享的 Python 工具库，提供 74 个工具模块，覆盖 Linux 系统操作、网络管理、存储管理、虚拟化、序列化、并发同步等基础能力。

## 目录结构

```
zstacklib/zstacklib/
├── __init__.py
└── utils/
    ├── linux.py          (3491行, Linux 系统操作核心)
    ├── linux_v2.py       (Linux 操作 v2 版本)
    ├── plugin.py         (插件框架)
    ├── http.py           (HTTP 服务器)
    ├── daemon.py         (守护进程)
    ├── log.py            (日志)
    ├── jsonobject.py     (JSON 序列化)
    ├── xmlobject.py      (XML 序列化)
    ├── lock.py           (进程内锁)
    ├── thread.py         (线程工具)
    ├── ip.py             (IP 地址管理)
    ├── iproute.py        (iproute2 命令)
    ├── iptables.py       (iptables 管理)
    ├── iptables_v2.py    (iptables v2)
    ├── ebtables.py       (ebtables 桥接防火墙)
    ├── ovs.py            (Open vSwitch)
    ├── ovn.py            (OVN)
    ├── ipset.py          (ipset 集合)
    ├── ceph.py           (Ceph 操作)
    ├── qemu_img.py       (qemu-img 操作)
    ├── qemu_nbd.py       (QEMU NBD)
    ├── nbd_client.py     (NBD 客户端)
    ├── iscsi.py          (iSCSI)
    ├── lvm.py            (LVM)
    ├── multipath.py      (多路径)
    ├── drbd.py           (DRBD)
    ├── libvirt_singleton.py (libvirt 单例)
    ├── qemu.py           (QEMU 操作)
    ├── qmp.py            (QMP 协议)
    ├── qga.py            (QEMU Guest Agent)
    ├── vm_operator.py    (VM 操作)
    ├── pci.py            (PCI 设备)
    ├── gpu.py            (GPU 设备)
    ├── bash.py           (Bash 命令执行)
    ├── shell.py          (Shell 工具)
    ├── sizeunit.py       (单位转换)
    ├── uuidhelper.py     (UUID 工具)
    ├── misc.py           (杂项工具)
    ├── image.py          (镜像操作)
    ├── ssh.py            (SSH 连接)
    ├── secret.py         (密钥管理)
    ├── xmlhook.py        (XML Hook)
    ├── rollback.py       (回滚装饰器)
    ├── defer.py          (延迟执行)
    ├── singleton.py      (单例模式)
    ├── portalocker.py    (文件锁)
    └── ... (共 74 个模块)
```

## linux.py — Linux 系统操作核心（3491 行）

### 装饰器

```python
# zstacklib/zstacklib/utils/linux.py
@retry(times=3, sleep_time=3)        # 自动重试
@ignoreerror                         # 忽略异常
@with_arch(todo_list=['x86_64'])     # 架构条件执行
@on_redhat_based(distro=...)         # RedHat 系发行版条件执行
@on_debian_based(distro=...)         # Debian 系发行版条件执行
```

### 网络管理

```python
# zstacklib/zstacklib/utils/linux.py
def create_bridge(bridge_name, interface, move_route=True):
    # brctl addbr → brctl stp off → ip link set up → 绑定物理网卡 → 迁移路由

def get_nic_name_by_mac(mac):     # MAC → 网卡名
def get_ip_by_nic_name(nicname):  # 网卡名 → IP
def get_nic_name_by_ip(ip):       # IP → 网卡名
```

### 存储管理

```python
# zstacklib/zstacklib/utils/linux.py
def mount(url, path, options=None, fstype=None):  # 挂载
def umount(path, is_exception=True):              # 卸载
def is_mounted(path=None, url=None):              # 检查挂载状态
def get_free_disk_size(dir_path):                 # 磁盘可用空间
def get_total_disk_size(dir_path):                # 磁盘总空间
```

### 进程管理

```python
# zstacklib/zstacklib/utils/linux.py
def find_vm_pid_by_uuid(uuid):
    # ps x | awk '/qemu[-].*{uuid}/{print $1; exit}'

def kill_process(pid, timeout=5, is_exception=True, is_graceful=True):
    # 先 SIGTERM → 等待 → 再 SIGKILL

def find_process_by_cmdline(cmdlines):
    # 遍历 /proc/{pid}/cmdline 匹配
```

### 内存管理

```python
# zstacklib/zstacklib/utils/linux.py
def get_free_memory():
    # 解析 /proc/meminfo 的 MemAvailable
```

### 文件操作

```python
# zstacklib/zstacklib/utils/linux.py
def wget(url, workdir, ...):           # 带进度回调的下载
def ssh(hostname, sshkey, cmd, ...):   # SSH 远程执行
def scp_download/scp_upload(...):      # SCP 文件传输
def mkdir(path, mode=0o755):          # 递归创建目录
```

## plugin.py — 插件框架

```python
# zstacklib/zstacklib/utils/plugin.py
class Plugin(object):
    """所有 Agent 插件的基类"""
    def start(self): pass
    def configure(self, config): pass
    def stop(self): pass

class PluginRegistry(object):
    def __init__(self, plugin_path):
        """扫描 plugin_path 目录下的所有 .py 文件"""
    def configure_plugins(self, config):
        """将配置注入所有插件"""
    def start_plugins(self):
        """调用所有插件的 start() 方法"""
```

## http.py — HTTP 服务器

```python
# zstacklib/zstacklib/utils/http.py
class HttpServer(object):
    def register_async_uri(self, path, handler, cmd=None):
        """注册异步路由"""
    def register_sync_uri(self, path, handler, cmd=None):
        """注册同步路由"""
    def start_in_thread(self):
        """在线程中启动"""
    def start(self):
        """阻塞式启动"""
```

底层基于 CherryPy 封装。

## jsonobject.py — JSON 序列化

```python
# zstacklib/zstacklib/utils/jsonobject.py
# 自动将 JSON 字符串反序列化为 Python 对象
# 支持嵌套对象、列表、类型转换
cmd = jsonobject.loads(req[http.REQUEST_BODY])  # JSON → Python 对象
rsp_json = jsonobject.dumps(rsp)                 # Python 对象 → JSON
```

## lock.py — 锁机制

```python
# zstacklib/zstacklib/utils/lock.py
@lock.lock('name')                    # 进程内互斥锁（基于 threading）
@lock.file_lock('/run/xtables.lock')  # 文件锁，防止多进程并发
```

## rollback.py — 回滚装饰器

```python
# zstacklib/zstacklib/utils/rollback.py
@rollback
def some_operation():
    # 如果函数抛出异常，自动执行回滚逻辑
    pass
```

## daemon.py — 守护进程

```python
# zstacklib/zstacklib/utils/daemon.py
class Daemon(object):
    def __init__(self, pidfile, py_process_name):
        """标准 Unix daemon：PID 文件、后台运行"""
    def run(self):
        """子类重写，启动 Agent"""
```

## 模块分类总结

| 类别 | 模块数 | 核心模块 |
|------|--------|----------|
| 系统基础 | 5 | linux.py, shell.py, bash.py, daemon.py |
| 网络 | 8 | ip.py, iptables.py, ovs.py, ipset.py |
| 存储 | 8 | ceph.py, qemu_img.py, iscsi.py, lvm.py |
| 虚拟化 | 7 | libvirt_singleton.py, qemu.py, qmp.py, pci.py |
| 序列化 | 3 | jsonobject.py, xmlobject.py, xmlhook.py |
| 并发/同步 | 4 | lock.py, thread.py, singleton.py, portalocker.py |
| 框架 | 5 | plugin.py, http.py, log.py, defer.py, rollback.py |
| 工具 | 6+ | sizeunit.py, uuidhelper.py, ssh.py, image.py |
