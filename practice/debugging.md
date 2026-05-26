# 调试技巧与陷阱

ZStack 代码量大、跨仓库、异步消息驱动，调试时容易踩坑。本文总结常用调试技巧和常见陷阱。

## 远程调试管理节点

### JDWP 调试模式

```bash
# 启动管理节点（调试模式，JDWP 端口 8787）
mvn -pl build -P debug exec:exec -Ddebug

# 挂起模式（等待调试器连接后才启动）
mvn -pl build -P debug-suspend exec:exec -Ddebug-suspend
```

在 IntelliJ IDEA 中配置 Remote JVM Debug：
- Host: 管理节点 IP
- Port: 8787
- Use module classpath: zstack

### 常用断点位置

| 场景 | 断点类 | 方法 |
|------|--------|------|
| API 入口 | `ApiMediatorImpl` | `handleApiMessage()` |
| 消息路由 | `CloudBusImpl2` | `routeMessage()` |
| FlowChain 执行 | `FlowChainBuilder` | `start()` |
| HTTP 发往 Agent | `RESTFacade` | `asyncJsonPost()` |
| Agent 回复处理 | `RESTFacade` | `handleResponse()` |
| 级联删除 | `CascadeFacadeImpl` | `cascadeDelete()` |
| 扩展点调用 | `PluginRegistryImpl` | `getExtensionList()` |

## 日志调试

### 管理节点日志

日志路径：`/var/log/zstack/management-server.log`

关键日志模式：

```
# API 调用
[ApiMediatorImpl] received api message[APICreateVmInstanceMsg]

# CloudBus 消息路由
[CloudBusImpl2] route message[APICreateVmInstanceMsg] to service[VmInstanceBase]

# FlowChain 步骤
[FlowChain] flow[VmAllocateHostFlow] starts
[FlowChain] flow[VmAllocateHostFlow] successfully

# HTTP 调用 Agent
[RESTFacade] asyncJsonPost to http://192.168.1.10:7070/vm/start

# 错误
[ERROR] ...
```

### Agent 日志

```bash
# kvmagent 日志
tail -f /var/log/zstack/zstack-kvmagent.log

# virtualrouter 日志
tail -f /var/log/zstack/zstack-virtualrouter.log
```

### 动态调整日志级别

通过 GlobalConfig 调整日志级别，无需重启：

```bash
# 通过 API 更新
APIUpdateGlobalConfigMsg msg = new APIUpdateGlobalConfigMsg();
msg.setCategory("log");
msg.setName("org.zstack.kvm");
msg.setValue("DEBUG");
```

## CloudBus 消息追踪

### 通过 correlationId 追踪

每条消息的 headers 中包含 `correlationId`，在日志中搜索：

```bash
grep "correlationId-xxx" /var/log/zstack/management-server.log
```

### 通过消息 ID 追踪

```bash
grep "msg-id-xxx" /var/log/zstack/management-server.log
```

### RabbitMQ 管理 UI

访问 `http://rabbitmq-host:15672`：
- 查看 Queues 页面，确认消息是否被消费
- 查看 Connections 页面，确认管理节点和 Dashboard 的连接状态
- 查看 Exchanges 页面，确认消息路由

## FlowChain 调试

### 断点 FlowChain

在 `FlowChainBuilder.newShareFlowChain()` 处打断点，可以追踪所有 FlowChain 的创建。

### 日志追踪

FlowChain 的每个步骤都有日志：

```
[FlowChain] flow[VmAllocateHostFlow] starts
[FlowChain] flow[VmAllocateHostFlow] successfully
[FlowChain] flow[VmAllocatePrimaryStorageFlow] starts
[FlowChain] flow[VmAllocatePrimaryStorageFlow] fail: out of space
[FlowChain] rollback flow[VmAllocateHostFlow]
```

### 常见问题：FlowChain 回滚不完整

FlowChain 的回滚是**逆序**执行的。如果某个 Flow 的 `rollback()` 方法有 bug，可能导致资源泄漏。

检查方法：在 `FlowChain.rollback()` 处打断点，确认每个 Flow 的回滚逻辑。

## 常见陷阱

### 陷阱 1：Sync Level 死锁

`AbstractService.getSyncLevel()` 默认返回 0（异步）。如果设置为 1（同步），且服务在处理消息时向自己发送消息，会导致死锁。

```java
// 危险！如果 syncLevel=1，这会死锁
public class MyService extends AbstractService {
    @Override
    public void handleMessage(Message msg) {
        // 向自己发送消息 → 死锁
        bus.send(new MyInternalMsg());
    }

    @Override
    public int getSyncLevel() {
        return 1;  // 同步级别 1 = 死锁风险
    }
}
```

**解决**：使用 `bus.send()` 异步发送，或使用 `ThreadFacade` 在新线程中处理。

### 陷阱 2：UUID 格式

ZStack 的 UUID 是 `varchar(32)`，去掉了连字符：

```java
// ZStack UUID 格式
"a1b2c3d4e5f67890a1b2c3d4e5f67890"  // 32 字符，无连字符

// 标准 UUID 格式
"a1b2c3d4-e5f6-7890-a1b2-c3d4e5f67890"  // 36 字符，有连字符
```

在 Python Agent 中同样：

```python
def uuid4():
    return str(uuid.uuid4()).replace('-', '')  # 去连字符
```

**注意**：如果用外部工具查询数据库，UUID 没有连字符，不要误以为是截断了。

### 陷阱 3：AspectJ 编译时织入

ZStack 使用 AspectJ 编译时织入（Compile-Time Weaving），以下注解在编译时被织入：

- `@AsyncSafe` — 方法在异步线程中执行
- `@ExceptionSafe` — 方法异常被静默吞掉
- `@MessageSafe` — 消息处理异常被捕获
- `@EncryptColumn` — 数据库字段自动加密

**陷阱**：在 IDE 中调试时，这些注解的行为可能不明显，因为织入发生在编译阶段。如果发现方法行为与源码不一致，检查是否有 AspectJ 注解。

### 陷阱 4：VO_ 类不是 JPA 实体

`VO_` 类是 QueryDSL 的 Q-type，不是 JPA 实体子类：

```java
// VmInstanceVO_ 是 QueryDSL 查询元数据，不是 VmInstanceVO 的子类
VmInstanceVO_ vm = VmInstanceVO_.this;
vm.name.eq("test");  // 用于构建查询条件
```

**注意**：不要尝试将 `VO_` 当作实体使用。

### 陷阱 5：软删除

ZStack 使用软删除，删除操作只是将 `state` 设为 `Destroyed` 或 `Deleted`：

```java
// 删除 VM 不是真删除
vm.setState(VmInstanceState.Destroyed);
dbf.update(vm);
```

查询时注意过滤已删除的资源：

```java
// 正确：过滤已删除的 VM
query.eq(VmInstanceVO_.state, VmInstanceState.Running);

// 错误：可能查到已删除的 VM
query.list();
```

### 陷阱 6：CloudBus 回调线程

CloudBus 的消息回调在 CloudBus 自己的线程池中执行，不是调用者的线程：

```java
bus.send(msg, new CloudBusCallBack() {
    @Override
    public void run(MessageReply reply) {
        // 这里的代码在 CloudBus 线程中执行
        // 不要做耗时操作！
    }
});
```

**注意**：回调中不要做耗时操作，会阻塞 CloudBus 线程池。需要耗时操作时，使用 `ThreadFacade` 提交到新线程。

### 陷阱 7：RESTFacade 超时

管理节点通过 RESTFacade 发送 HTTP 到 Agent，默认超时时间较长。如果 Agent 无响应，管理节点会等待很久。

检查方法：

```bash
# 查看 RESTFacade 超时配置
grep "RESTFacade" /var/log/zstack/management-server.log
```

### 陷阱 8：Spring XML 加载顺序

Spring XML 的加载顺序影响 Bean 的初始化顺序。如果 Bean A 依赖 Bean B，但 A 的 XML 先于 B 的 XML 被加载，会导致 `NoSuchBeanDefinitionException`。

**解决**：确保 `conf/springConfigXml/` 中的 XML 按正确顺序排列，或使用 `depends-on` 属性。

## 性能调试

### 慢查询

```bash
# 开启 MySQL 慢查询日志
SET GLOBAL slow_query_log = 'ON';
SET GLOBAL long_query_time = 1;  # 超过 1 秒的查询
```

### FlowChain 耗时

在 FlowChain 的 `done()` 回调中记录总耗时：

```java
long startTime = System.currentTimeMillis();
chain.then(flows).done(() -> {
    long elapsed = System.currentTimeMillis() - startTime;
    logger.debug("FlowChain completed in " + elapsed + "ms");
}).start();
```

### CloudBus 消息延迟

在 RabbitMQ 管理 UI 中查看队列的消息积压情况。如果 `zstack.message.api.portal` 队列有大量未消费消息，说明管理节点处理不过来。

## Dashboard 调试

### 前端调试

浏览器开发者工具 → Network 面板：
- 查看 `/api/async` 请求的 Receipt ID
- 查看 `/api/query` 轮询的响应状态

### 后端调试

```bash
# 查看 Dashboard 日志
tail -f /var/log/zstack/zstack-ui.log

# 查看 RabbitMQ 连接状态
# 在 Dashboard 日志中搜索 "connection to"
```

### 常见问题：Dashboard 无法连接

1. 确认管理节点已启动（Dashboard 依赖管理节点创建 RabbitMQ exchange）
2. 确认 `--rabbitmq` 参数正确
3. 查看日志中是否有 `cannot declare RabbitMQ exchange(P2P)` 错误

## Agent 调试

### 手动调用 Agent

```bash
# 直接调用 kvmagent API
curl -X POST http://192.168.1.10:7070/vm/start \
  -H "Content-Type: application/json" \
  -d '{"vmName":"test-vm",...}'
```

### 查看 Agent 端口

```bash
# kvmagent 默认端口 7070
ss -tlnp | grep 7070

# virtualrouter 默认端口 7272
ss -tlnp | grep 7272
```

### Agent 日志级别

在 Agent 配置文件中调整日志级别：

```bash
# 编辑 /usr/local/zstack/kvmagent/kvmagent.properties
log_level=DEBUG
```
