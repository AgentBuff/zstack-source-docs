# 15 - 扩展点全景图

ZStack 的插件体系建立在扩展点（Extension Point）机制之上。扩展点是一个 Java 接口，定义在 `header/` 模块中，由 `plugin/` 或 `compute/` 等实现模块提供具体实现。通过 `PluginRegistryImpl` 的 `getExtensionList(Class<T>)` 方法，任何服务都可以在运行时获取某个扩展点的所有实现，并按优先级依次调用。

## 扩展点统计

在 `header/` 模块中，共有 **207 个扩展点接口**，覆盖了 IaaS 平台的方方面面。

## 扩展点分类

### 一、资源生命周期扩展点（~50 个）

这是数量最多的一类扩展点，围绕每个 IaaS 资源的生命周期操作（创建、启动、停止、销毁、迁移等）提供钩子。

#### VM 生命周期

| 扩展点 | 职责 | 典型实现 |
|--------|------|----------|
| `VmInstanceCreateExtensionPoint` | VM 创建前拦截 | 安全组预配置 |
| `VmInstanceStartExtensionPoint` | VM 启动四阶段钩子 | 虚拟路由器配置、安全组规则下发 |
| `VmInstanceStopExtensionPoint` | VM 停止钩子 | 资源回收、日志记录 |
| `VmInstanceRebootExtensionPoint` | VM 重启钩子 | 配置刷新 |
| `VmInstanceDestroyExtensionPoint` | VM 销毁钩子 | 资源清理、级联释放 |
| `VmInstanceMigrateExtensionPoint` | VM 迁移钩子 | 存储检查、网络重配置 |
| `VmInstanceResumeExtensionPoint` | VM 恢复钩子 | HA 状态更新 |
| `VmStateChangedExtensionPoint` | VM 状态变更通知 | 监控告警、计费触发 |
| `VmHaExtensionPoint` | VM 高可用钩子 | HA 策略执行 |
| `VmAbnormalLifeCycleExtensionPoint` | VM 异常生命周期处理 | 自动恢复流程 |

#### Host 生命周期

| 扩展点 | 职责 | 典型实现 |
|--------|------|----------|
| `HostAddExtensionPoint` | 主机添加前后 | 连接测试、能力检测 |
| `HostDeleteExtensionPoint` | 主机删除前后 | VM 迁移、资源释放 |
| `HostConnectionReestablishExtensionPoint` | 连接重建通知 | 状态同步、配置刷新 |
| `HostMaintenanceExtensionPoint` | 维护模式检查 | VM 迁移策略 |

#### Volume 生命周期

| 扩展点 | 职责 |
|--------|------|
| `VmAttachVolumeExtensionPoint` | 云盘挂载前后 |
| `VmDetachVolumeExtensionPoint` | 云盘卸载前后 |

### 二、四阶段钩子模式

ZStack 的资源操作扩展点普遍遵循**四阶段钩子模式**：`pre → before → after → failed`。以 `VmInstanceStartExtensionPoint` 为例：

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceStartExtensionPoint.java

```java
public interface VmInstanceStartExtensionPoint {
    String preStartVm(VmInstanceInventory inv);
    void beforeStartVm(VmInstanceInventory inv);
    void afterStartVm(VmInstanceInventory inv);
    void failedToStartVm(VmInstanceInventory inv, ErrorCode reason);
}
```

四个阶段的语义和执行逻辑：

| 阶段 | 方法 | 返回值 | 语义 | 失败影响 |
|------|------|--------|------|----------|
| **pre** | `preStartVm` | String（跳过原因） | **否决权**：返回非 null 则阻止操作 | 整个操作中止 |
| **before** | `beforeStartVm` | void | **准备阶段**：执行准备工作 | 异常导致操作失败 |
| **after** | `afterStartVm` | void | **完成通知**：操作成功后的回调 | 不影响操作结果 |
| **failed** | `failedToStartVm` | void | **失败通知**：操作失败后的清理 | 仅用于清理，不影响回滚 |

执行流程：

```
1. 遍历所有扩展点的 preStartVm()
   → 任一返回非 null → 操作中止，返回错误
2. 遍历所有扩展点的 beforeStartVm()
   → 任一抛出异常 → 操作失败
3. 执行实际启动逻辑
   → 成功 → 遍历所有扩展点的 afterStartVm()
   → 失败 → 遍历所有扩展点的 failedToStartVm()
```

### 三、异步扩展点

某些扩展点需要执行异步操作（如网络配置、存储检查），因此提供了带 `Completion` 回调的重载方法：

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceMigrateExtensionPoint.java

```java
public interface VmInstanceMigrateExtensionPoint {
    default void preMigrateVm(VmInstanceInventory inv, String destHostUuid) {};

    default void preMigrateVm(VmInstanceInventory inv, String destHostUuid, 
                              Completion completion) {
        preMigrateVm(inv, destHostUuid);
        completion.success();
    }

    void beforeMigrateVm(VmInstanceInventory inv, String destHostUuid);

    default void postMigrateVm(VmInstanceInventory inv, String destHostUuid) {}
    default void postMigrateVm(VmInstanceInventory inv, String destHostUuid, 
                               Completion completion) {
        postMigrateVm(inv, destHostUuid);
        completion.success();
    }

    default void afterMigrateVm(VmInstanceInventory inv, String srcHostUuid) {}
    default void afterMigrateVm(VmInstanceInventory inv, String srcHostUuid, 
                                NoErrorCompletion completion) {
        afterMigrateVm(inv, srcHostUuid);
        completion.done();
    }

    default void failedToMigrateVm(VmInstanceInventory inv, String destHostUuid, 
                                   ErrorCode reason) {};
    default void failedToMigrateVm(VmInstanceInventory inv, String destHostUuid, 
                                   ErrorCode reason, NoErrorCompletion completion) {
        failedToMigrateVm(inv, destHostUuid, reason);
        completion.done();
    }
}
```

设计要点：

1. **同步版本为默认方法**：不带 `Completion` 的版本有默认实现（空操作），旧代码无需修改
2. **异步版本调用同步版本**：带 `Completion` 的版本默认调用同步版本后立即 `completion.success()`
3. **实现者选择覆盖**：需要异步操作的实现覆盖带 `Completion` 的版本；不需要的覆盖同步版本即可

`Completion` 和 `NoErrorCompletion` 的区别：

| 回调接口 | 方法 | 用途 |
|----------|------|------|
| `Completion` | `success()` / `fail(ErrorCode)` | 可报告成功或失败 |
| `NoErrorCompletion` | `done()` | 仅通知完成，不报告失败 |

### 四、网络扩展点（~30 个）

| 扩展点 | 职责 |
|--------|------|
| `NetworkServiceExtensionPoint` | 网络服务（DHCP/DNS/SNAT等）扩展 |
| `L3NetworkCreateExtensionPoint` | L3 网络创建钩子 |
| `IpRangeExtensionPoint` | IP 范围管理扩展 |
| `PortForwardingExtensionPoint` | 端口转发规则扩展 |
| `EipExtensionPoint` | 弹性 IP 扩展 |
| `VirtualRouterExtensionPoint` | 虚拟路由器生命周期 |
| `SecurityGroupExtensionPoint` | 安全组规则扩展 |
| `VpcNetworkExtensionPoint` | VPC 网络扩展 |

### 五、存储扩展点（~25 个）

| 扩展点 | 职责 |
|--------|------|
| `PrimaryStorageExtensionPoint` | 主存储生命周期 |
| `BackupStorageExtensionPoint` | 备份存储生命周期 |
| `VolumeCreateExtensionPoint` | 云盘创建钩子 |
| `VolumeDeleteExtensionPoint` | 云盘删除钩子 |
| `ImageDownloadExtensionPoint` | 镜像下载钩子 |
| `CephPrimaryStorageExtensionPoint` | Ceph 主存储扩展 |
| `LocalPrimaryStorageExtensionPoint` | 本地存储扩展 |

### 六、身份与安全扩展点（~20 个）

| 扩展点 | 职责 |
|--------|------|
| `AccountExtensionPoint` | 账户生命周期 |
| `IdentityExtensionPoint` | 身份管理扩展 |
| `QuotaExtensionPoint` | 配额检查扩展 |
| `PolicyExtensionPoint` | 策略管理扩展 |
| `ResourceOwnerPreExtensionPoint` | 资源归属前置检查 |
| `AdminOnlyApiExtensionPoint` | 管理员 API 限制 |

### 七、框架扩展点（~30 个）

| 扩展点 | 职责 |
|--------|------|
| `Component` | 组件生命周期（start/stop） |
| `Service` | CloudBus 消息处理服务 |
| `ApiMessageValidator` | API 消息自定义校验器 |
| `CloudBusCallExtensionPoint` | CloudBus 调用拦截 |
| `QueryExtensionPoint` | 查询扩展 |
| `CascadeDeleteExtensionPoint` | 级联删除扩展 |
| `ManagementNodeChangeListener` | 管理节点状态变更通知 |
| `AfterCreateDbSnapshotExtensionPoint` | 数据库快照后处理 |
| `GlobalConfigExtensionPoint` | 全局配置变更通知 |

### 八、其他扩展点（~39 个）

包括监控、告警、日志、定时任务、标签系统等方面的扩展点。

## 特殊扩展点模式

### VmAbnormalLifeCycleExtensionPoint：Flow 工厂

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmAbnormalLifeCycleExtensionPoint.java

```java
public interface VmAbnormalLifeCycleExtensionPoint {
    Flow createVmAbnormalLifeCycleHandlingFlow(VmAbnormalLifeCycleStruct struct);
}
```

这个扩展点不遵循四阶段模式，而是返回一个 `Flow` 对象。当 VM 进入异常状态时，框架收集所有扩展点返回的 Flow，组装成 FlowChain 执行。这是一种**策略模式 + 工厂模式**的结合。

### VmStateChangedExtensionPoint：观察者模式

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmStateChangedExtensionPoint.java

```java
public interface VmStateChangedExtensionPoint {
    void vmStateChanged(VmInstanceInventory vm, VmInstanceState oldState, VmInstanceState newState);
}
```

纯观察者，不参与操作流程，仅在状态变更后收到通知。适用于监控、计费、日志等旁路逻辑。

### HostConnectionReestablishExtensionPoint：带类型过滤

> 源码位置：zstack/header/src/main/java/org/zstack/header/host/HostConnectionReestablishExtensionPoint.java

```java
public interface HostConnectionReestablishExtensionPoint {
    void connectionReestablished(HostInventory inv) throws HostException;
    HypervisorType getHypervisorTypeForReestablishExtensionPoint();
}
```

这个扩展点要求实现者声明自己关注的 Hypervisor 类型（KVM、VMware 等），框架只在该类型的 Host 重连时调用对应的扩展点实现。

## 运行时扩展点查找

`PluginRegistryImpl` 提供了扩展点的运行时查找能力：

```java
// 获取某个扩展点的所有实现，按 @Ordered 注解排序
<T> List<T> getExtensionList(Class<T> extensionPoint);

// 获取某个扩展点的单个实现
<T> T getExtension(Class<T> extensionPoint);
```

业务代码中的典型用法：

```java
List<VmInstanceStartExtensionPoint> exts = 
    pluginRgistry.getExtensionList(VmInstanceStartExtensionPoint.class);

for (VmInstanceStartExtensionPoint ext : exts) {
    String ret = ext.preStartVm(inv);
    if (ret != null) {
        throw new OperationFailureException(operr("extension %s refused to start vm", ext));
    }
}
```

## 扩展点注册机制

扩展点的注册通过 Spring XML 配置完成。每个实现类在 `conf/springConfigXml/` 下的某个 XML 文件中声明为 Spring Bean：

```xml
<bean id="SecurityGroupManager" 
      class="org.zstack.securitygroup.SecurityGroupManagerImpl" />
```

`PluginRegistryImpl` 在启动时扫描 Spring 容器中所有 Bean，检查它们实现了哪些扩展点接口，自动注册到内部的扩展点 Map 中。

## 扩展点优先级

当多个扩展点实现需要按特定顺序执行时，使用 `@Ordered` 注解：

```java
@Ordered(0)  // 数字越小优先级越高
public class SomeExtension implements VmInstanceStartExtensionPoint { ... }
```

`getExtensionList()` 返回的列表已按 `@Ordered` 值排序。

## 设计哲学总结

1. **接口即契约**：扩展点定义在 `header/` 模块，只有接口没有实现，确保契约与实现的彻底分离
2. **四阶段钩子**：`pre → before → after → failed` 模式统一了所有资源操作的扩展方式，降低了学习成本
3. **同步/异步双轨**：通过 `default` 方法和 `Completion` 回调，优雅地兼容同步和异步两种实现方式
4. **观察者与拦截器并存**：`VmStateChangedExtensionPoint` 等纯观察者不影响主流程，`pre*` 方法则拥有否决权
5. **Spring 驱动的注册**：利用 Spring 容器作为扩展点的注册中心，零配置、自动发现
6. **207 个扩展点**：覆盖了 IaaS 平台的每一个角落，使得 ZStack 可以在不修改核心代码的情况下扩展几乎任何行为
