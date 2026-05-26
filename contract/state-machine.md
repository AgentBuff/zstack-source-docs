# 14 - 状态机与事务表

在 IaaS 系统中，资源的状态管理是核心难题。一台云主机可能处于 Running、Stopped、Migrating 等十几种状态，状态之间的转换必须严格受控——你不能停止一台已经停止的 VM，也不能迁移一台正在销毁的 VM。ZStack 采用了一种优雅的解决方案：**在每个状态枚举中内嵌事务表（Transaction Table）**，以声明式的方式定义所有合法的状态转换。

## 问题：为什么需要显式状态机？

如果没有显式的状态机，代码中会散布大量 `if-else` 判断：

```java
// 反模式：隐式状态检查
if (vm.getState() == VmInstanceState.Running) {
    if (event == VmInstanceStateEvent.stopping) {
        vm.setState(VmInstanceState.Stopping);
    } else if (event == VmInstanceStateEvent.rebooting) {
        vm.setState(VmInstanceState.Rebooting);
    } else {
        throw new OperationFailureException("illegal state transition");
    }
} else if (vm.getState() == VmInstanceState.Stopped) {
    // ... 更多分支
}
```

这种代码的问题显而易见：状态转换逻辑分散在各处，难以审查、容易遗漏、无法全局视图。ZStack 的解决方案是将所有合法转换集中声明在枚举类中。

## VmInstanceState：最复杂的状态机

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceState.java

### 状态定义

```java
@PythonClass
public enum VmInstanceState {
    Created(null),
    Starting(VmInstanceStateEvent.starting),
    Running(VmInstanceStateEvent.running),
    Stopping(VmInstanceStateEvent.stopping),
    Stopped(VmInstanceStateEvent.stopped),
    Rebooting(VmInstanceStateEvent.rebooting),
    Destroying(VmInstanceStateEvent.destroying),
    Destroyed(VmInstanceStateEvent.destroyed),
    Migrating(VmInstanceStateEvent.migrating),
    Expunging(VmInstanceStateEvent.expunging),
    Pausing(VmInstanceStateEvent.pausing),
    Paused(VmInstanceStateEvent.paused),
    Resuming(VmInstanceStateEvent.resuming),
    VolumeMigrating(VmInstanceStateEvent.volumeMigrating),
    VolumeRecovering(VmInstanceStateEvent.volumeRecovering),
    Error(null),
    NoState(VmInstanceStateEvent.noState),
    Unknown(VmInstanceStateEvent.unknown),
    Crashed(VmInstanceStateEvent.crashed);
}
```

18 个状态，可以分为以下几类：

| 类别 | 状态 | 说明 |
|------|------|------|
| 稳态 | `Created`, `Running`, `Stopped`, `Paused`, `Destroyed`, `Error`, `NoState`, `Unknown`, `Crashed` | 资源停留的状态 |
| 过渡态 | `Starting`, `Stopping`, `Rebooting`, `Destroying`, `Migrating`, `Pausing`, `Resuming`, `VolumeMigrating`, `VolumeRecovering`, `Expunging` | 操作进行中的临时状态 |

### 中间态与离线态

VmInstanceState 显式定义了两个静态集合：

```java
public static List<VmInstanceState> intermediateStates = new ArrayList<>();
public static Set<VmInstanceState> offlineStates = new HashSet<>();

static {
    intermediateStates.add(Starting);
    intermediateStates.add(Stopping);
    intermediateStates.add(Rebooting);
    intermediateStates.add(Destroying);
    intermediateStates.add(Migrating);
    intermediateStates.add(Pausing);
    intermediateStates.add(Resuming);
    intermediateStates.add(VolumeMigrating);
    intermediateStates.add(VolumeRecovering);

    offlineStates.add(Created);
    offlineStates.add(Stopped);
    offlineStates.add(Destroyed);
    offlineStates.add(VolumeMigrating);
    offlineStates.add(Crashed);
}
```

- **intermediateStates**：中间态列表。处于这些状态的 VM 不应接受新的操作请求（如不能对正在 Starting 的 VM 发起 Stop）。
- **offlineStates**：离线态集合。处于这些状态的 VM 没有在物理机上运行，不需要与 agent 通信。

### Transaction 内部类

事务表的核心数据结构：

```java
private static class Transaction {
    VmInstanceStateEvent event;
    VmInstanceState nextState;

    private Transaction(VmInstanceStateEvent event, VmInstanceState nextState) {
        this.event = event;
        this.nextState = nextState;
    }
}
```

每个 Transaction 就是一条规则：**当事件 `event` 发生时，从当前状态转换到 `nextState`**。

### 事务表声明

事务表通过 `transactions()` 方法声明，在 `static` 块中集中定义：

```java
static {
    Created.transactions(
        new Transaction(VmInstanceStateEvent.starting, VmInstanceState.Starting),
        new Transaction(VmInstanceStateEvent.destroying, VmInstanceState.Destroying),
        new Transaction(VmInstanceStateEvent.destroyed, VmInstanceState.Destroyed)
    );
    Starting.transactions(
        new Transaction(VmInstanceStateEvent.running, VmInstanceState.Running),
        new Transaction(VmInstanceStateEvent.stopped, VmInstanceState.Stopped),
        new Transaction(VmInstanceStateEvent.paused, VmInstanceState.Paused),
        new Transaction(VmInstanceStateEvent.destroying, VmInstanceState.Destroying),
        new Transaction(VmInstanceStateEvent.unknown, VmInstanceState.Unknown)
    );
    Running.transactions(
        new Transaction(VmInstanceStateEvent.running, VmInstanceState.Running),
        new Transaction(VmInstanceStateEvent.destroying, VmInstanceState.Destroying),
        new Transaction(VmInstanceStateEvent.stopping, VmInstanceState.Stopping),
        new Transaction(VmInstanceStateEvent.stopped, VmInstanceState.Stopped),
        new Transaction(VmInstanceStateEvent.rebooting, VmInstanceState.Rebooting),
        new Transaction(VmInstanceStateEvent.migrating, VmInstanceState.Migrating),
        new Transaction(VmInstanceStateEvent.volumeMigrating, VmInstanceState.Migrating),
        new Transaction(VmInstanceStateEvent.volumeRecovering, VmInstanceState.VolumeRecovering),
        new Transaction(VmInstanceStateEvent.pausing, VmInstanceState.Pausing),
        new Transaction(VmInstanceStateEvent.paused, VmInstanceState.Paused),
        new Transaction(VmInstanceStateEvent.crashed, VmInstanceState.Crashed),
        new Transaction(VmInstanceStateEvent.noState, VmInstanceState.NoState),
        new Transaction(VmInstanceStateEvent.unknown, VmInstanceState.Unknown)
    );
    Stopped.transactions(
        new Transaction(VmInstanceStateEvent.starting, VmInstanceState.Starting),
        new Transaction(VmInstanceStateEvent.stopped, VmInstanceState.Stopped),
        new Transaction(VmInstanceStateEvent.running, VmInstanceState.Running),
        new Transaction(VmInstanceStateEvent.paused, VmInstanceState.Paused),
        new Transaction(VmInstanceStateEvent.destroying, VmInstanceState.Destroying),
        new Transaction(VmInstanceStateEvent.volumeMigrating, VmInstanceState.VolumeMigrating),
        new Transaction(VmInstanceStateEvent.volumeRecovering, VmInstanceState.VolumeRecovering),
        new Transaction(VmInstanceStateEvent.noState, VmInstanceState.NoState),
        new Transaction(VmInstanceStateEvent.unknown, VmInstanceState.Unknown)
    );
    // ... 更多状态的转换表
}
```

### 状态转换图（核心路径）

以下是 VM 生命周期中最核心的状态转换路径：

```
Created ──starting──→ Starting ──running──→ Running
                       │                     │
                       └──stopped──→ Stopped ←──stopping──┘
                                        │
                    starting ──────────→│
                                        │
                    destroying ────────→ Destroying ──destroyed──→ Destroyed
```

更完整的转换矩阵：

| 当前状态 \ 事件 | starting | running | stopping | stopped | rebooting | destroying | destroyed | migrating | pausing | paused | resuming | crashed | unknown |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **Created** | Starting | - | - | - | - | Destroying | Destroyed | - | - | - | - | - | - |
| **Starting** | - | Running | - | Stopped | - | Destroying | - | - | - | Paused | - | - | Unknown |
| **Running** | - | Running | Stopping | Stopped | Rebooting | Destroying | - | Migrating | Pausing | Paused | - | Crashed | Unknown |
| **Stopped** | Starting | Running | - | Stopped | - | Destroying | - | - | - | Paused | - | - | Unknown |
| **Paused** | - | Running | Stopping | Stopped | - | Destroying | - | Migrating | - | - | Resuming | - | Unknown |

> 注：上表为简化子集，仅展示主要生命周期状态（Created、Starting、Running、Stopped、Paused）的转换。`VmInstanceState` 实际定义 18 个状态，其余状态包括：Stopping、Migrating、Pausing、Resuming、VolumeMigrating、VolumeRecovering、Rebooting、Unknown、Destroying、Destroyed、Crashed、NoState、Expunging、Error。

### nextState()：运行时状态校验

```java
private Map<VmInstanceStateEvent, Transaction> transactionMap = new HashMap<>();

private void transactions(Transaction... transactions) {
    for (Transaction tran : transactions) {
        transactionMap.put(tran.event, tran);
    }
}

public VmInstanceState nextState(VmInstanceStateEvent event) {
    Transaction tran = transactionMap.get(event);
    if (tran == null) {
        throw new CloudRuntimeException(String.format(
            "cannot find next state for current state[%s] on transaction event[%s]",
            this, event));
    }
    return tran.nextState;
}
```

运行时使用非常简单：

```java
VmInstanceState current = vm.getState();           // 例如 Running
VmInstanceStateEvent event = VmInstanceStateEvent.stopping;
VmInstanceState next = current.nextState(event);    // Stopping
vm.setState(next);
```

如果尝试非法转换（如 `Destroyed.nextState(starting)`），`transactionMap.get(event)` 返回 `null`，立即抛出 `CloudRuntimeException`。**非法转换在框架层面被彻底杜绝**。

## VmInstanceStateEvent：事件枚举

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceStateEvent.java

```java
public enum VmInstanceStateEvent {
    /* 用户操作触发的事件 */
    starting,
    stopping,
    migrating,
    migrated,
    destroying,
    rebooting,
    destroyed,
    expunging,
    pausing,
    resuming,
    volumeMigrating,
    volumeMigrated,
    volumeRecovering,
    volumeRecovered,

    /* 内部逻辑触发的事件 */
    unknown,

    /* 操作结果或全量同步上报的事件 */
    running,
    stopped,
    paused,
    crashed,
    noState,
}
```

事件分为三类：

1. **用户操作事件**：`starting`、`stopping`、`migrating`、`destroying` 等，由用户 API 调用触发
2. **内部逻辑事件**：`unknown`，由系统内部异常处理触发
3. **结果/上报事件**：`running`、`stopped`、`paused`、`crashed`、`noState`，由操作完成或 agent 全量同步上报

## HostState：更简洁的状态机

> 源码位置：zstack/header/src/main/java/org/zstack/header/host/HostState.java

```java
public enum HostState {
    Enabled,
    Disabled,
    PreMaintenance,
    Maintenance;

    static {
        Enabled.transactions(
            new Transaction(HostStateEvent.disable, HostState.Disabled),
            new Transaction(HostStateEvent.enable, HostState.Enabled),
            new Transaction(HostStateEvent.preMaintain, HostState.PreMaintenance)
        );
        Disabled.transactions(
            new Transaction(HostStateEvent.disable, HostState.Disabled),
            new Transaction(HostStateEvent.enable, HostState.Enabled),
            new Transaction(HostStateEvent.preMaintain, HostState.PreMaintenance)
        );
        PreMaintenance.transactions(
            new Transaction(HostStateEvent.disable, HostState.Disabled),
            new Transaction(HostStateEvent.enable, HostState.Enabled),
            new Transaction(HostStateEvent.maintain, HostState.Maintenance),
            new Transaction(HostStateEvent.preMaintain, HostState.PreMaintenance)
        );
        Maintenance.transactions(
            new Transaction(HostStateEvent.disable, HostState.Disabled),
            new Transaction(HostStateEvent.enable, HostState.Enabled)
        );
    }
}
```

Host 的状态机只有 4 个状态、4 个事件，但同样遵循 Transaction 模式：

```
Enabled ←──enable──→ Disabled
   │                    │
   └──preMaintain──→ PreMaintenance ──maintain──→ Maintenance
                       ↑                          │
                       └──preMaintain──────────────┘ (不可直接)
                       
Maintenance ──enable──→ Enabled
Maintenance ──disable──→ Disabled
```

> 源码位置：zstack/header/src/main/java/org/zstack/header/host/HostStateEvent.java

```java
public enum HostStateEvent {
    enable,
    disable,
    preMaintain,
    maintain,
}
```

HostState 还提供了一个额外的方法 `getTargetStateDrivenEvent()`：

```java
public HostStateEvent getTargetStateDrivenEvent(HostState targetState) {
    return transactionMap.values().stream()
        .filter(it -> it.nextState == targetState)
        .findFirst()
        .map(it -> it.event)
        .orElse(null);
}
```

这个方法用于反向查找：给定目标状态，找到触发该转换的事件。例如 `Enabled.getTargetStateDrivenEvent(Disabled)` 返回 `HostStateEvent.disable`。

## Transaction 模式的设计优势

### 1. 集中声明，全局视图

所有合法转换集中在一个 `static` 块中，一目了然。审查者可以快速确认"从 Running 状态是否允许直接转到 Destroyed"——只需看 `Running.transactions()` 中是否有 `destroyed` 事件。

### 2. 运行时强校验

`nextState()` 方法在非法转换时立即抛出 `CloudRuntimeException`，将 bug 暴露在开发阶段而非生产环境。

### 3. 自文档化

事务表本身就是最准确的状态机文档。任何文字文档都可能过时，但代码中的 Transaction 声明永远与实现一致。

### 4. 零侵入集成

业务代码只需调用 `currentState.nextState(event)`，无需关心状态机的内部实现。新增状态或转换只需修改枚举的 `static` 块。

### 5. 可扩展

新增状态只需在枚举中添加新值并在 `static` 块中声明其事务表，不影响已有代码。

## 其他资源的状态机

ZStack 中几乎所有有状态资源都采用 Transaction 模式：

| 资源 | 状态枚举 | 事件枚举 | 状态数 |
|------|----------|----------|--------|
| 云主机 | `VmInstanceState` | `VmInstanceStateEvent` | 18 |
| 物理机 | `HostState` | `HostStateEvent` | 4 |
| 云盘 | `VolumeState` | `VolumeStateEvent` | — |
| 主存储 | `PrimaryStorageState` | `PrimaryStorageStateEvent` | — |
| 镜像 | `ImageState` | `ImageStateEvent` | — |
| 网络 | `NetworkState` | `NetworkStateEvent` | — |

所有状态枚举都遵循相同的模式：枚举值 + 内嵌 Transaction 类 + `transactionMap` + `nextState()` 方法 + `static` 块声明事务表。

## 与 FlowChain 的协作

状态机定义了"什么转换是合法的"，而 FlowChain 定义了"如何执行这个转换"。两者协作的模式是：

1. FlowChain 的某个 Flow 在执行前调用 `currentState.nextState(event)` 获取下一个状态
2. 如果转换合法，Flow 继续执行，成功后更新数据库中的状态
3. 如果转换非法，`nextState()` 抛出异常，FlowChain 的 rollback 机制自动回滚

这种"状态机守门 + FlowChain 执行"的模式，确保了资源状态转换的原子性和一致性。
