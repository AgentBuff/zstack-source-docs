# Cloud-Init 插件

> **重要发现**：CloudInit 插件在 ZStack 开源代码库中**不存在**。本节分析 ZStack 中与 Cloud-Init 相关的机制，以及如何通过现有框架实现类似功能。

## Cloud-Init 在 ZStack 中的位置

在整个 `zstack/` 代码库中搜索 `cloudinit`、`cloud-init`、`cloud_init` 均无结果。Cloud-Init 相关功能可能存在于企业版闭源仓库中。

## 替代机制：VM 用户数据

虽然没有独立的 Cloud-Init 插件，ZStack 通过以下机制支持 VM 初始化：

### 1. Console 密码注入

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMHost.java
// startVm() 中设置控制台密码
cmd.setConsolePassword(consolePassword);
// kvmagent 在 libvirt XML 中注入密码
```

### 2. SSH Key 注入

```java
// plugin/sshKeyPair/src/main/java/org/zstack/sshkeypair/SshKeyPairManagerImpl.java (591行)
// SSH Key Pair 管理器
// 在 VM 创建时注入公钥到 VM
```

### 3. XML Hook 注入

```java
// plugin/kvm/src/main/java/org/zstack/kvm/xmlhook/XmlHookManagerImpl.java (177行)
// 允许在 VM 启动前注入自定义 XML 片段到 libvirt 域定义
// 可用于挂载 config-drive、设置 metadata 等
```

### 4. KVM Addons 机制

```java
// plugin/kvm/src/main/java/org/zstack/kvm/KVMAddons.java
// KVMStartVmAddonExtensionPoint 允许其他插件在 VM 启动命令中注入额外配置
// 这是 Cloud-Init 集成的理想扩展点
```

## 如果要实现 Cloud-Init 插件

基于 ZStack 的插件框架，Cloud-Init 插件应实现以下扩展点：

### 扩展点设计

```java
// 1. 实现 KVMStartVmAddonExtensionPoint
//    在 StartVmCmd 中注入 cloud-init 配置
public class CloudInitKvmStartVmAddon implements KVMStartVmAddonExtensionPoint {
    @Override
    public void kvmStartVmAddon(KVMHost host, StartVmCmd cmd, VmInstanceSpec spec) {
        // 注入 user-data、meta-data 到 StartVmCmd
        // 方式1: config-drive ISO
        // 方式2: NoCloud 数据源
    }
}

// 2. 实现 VmInstanceExtensionPoint
//    在 VM 创建流程中处理 Cloud-Init 配置
public class CloudInitManagerImpl implements VmInstanceExtensionPoint, Component {
    // 处理 APIAddVmInstanceMsg 中的 cloud-init 参数
    // 保存 user-data / meta-data 到数据库
}

// 3. 定义 API 消息
@RestRequest
class APISetVmCloudInitMsg extends APIMessage {
    @APIParam(resourceType = VmInstanceVO.class)
    private String vmInstanceUuid;
    private String userData;      // base64 编码的 user-data
    private String metaData;      // base64 编码的 meta-data
}
```

### kvmagent 端实现

```python
# kvmagent/plugins/cloudinit_plugin.py（需新建）
# 1. 创建 config-drive ISO
#   - 使用 genisoimage 创建 ISO
#   - 包含 meta-data, user-data, network-config
# 2. 挂载 ISO 到 VM
#   - 在 libvirt XML 中添加 CDROM 设备
# 3. 支持 NoCloud 数据源
#   - 将配置写入本地目录
#   - 通过 virtio-serial 传递
```

### 数据模型

```sql
-- Cloud-Init 配置表
CREATE TABLE CloudInitVO (
    id bigint PRIMARY KEY,
    uuid varchar(32) NOT NULL,
    vmInstanceUuid varchar(32) NOT NULL,
    userData text,           -- base64 编码
    metaData text,           -- base64 编码
    networkConfig text,      -- base64 编码
    type varchar(32),        -- CONFIG_DRIVE / NO_CLOUD
    state varchar(32),
    createDate timestamp,
    lastOpDate timestamp
);
```

## 与其他 IaaS 平台的对比

| 平台 | Cloud-Init 集成方式 |
|------|---------------------|
| OpenStack | config-drive + metadata service（完整实现） |
| CloudStack | VR 提供 metadata service + password injection |
| ZStack（开源） | 仅 console password + SSH key + XML hook |
| ZStack（企业版） | 可能有完整 Cloud-Init 支持（闭源） |

## 总结

ZStack 开源版本没有独立的 Cloud-Init 插件，但提供了足够的扩展点（`KVMStartVmAddonExtensionPoint`、`XmlHookManager`、`SshKeyPairManager`）来实现 Cloud-Init 集成。如果需要 Cloud-Init 功能，可以基于这些扩展点开发自定义插件，或联系 ZStack 获取企业版。
