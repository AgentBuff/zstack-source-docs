# 09 - 运行时配置体系

IaaS 系统有大量运行时可调参数：VM 创建超时时间、主机重连间隔、API 调用并发数……这些参数不能硬编码在代码中，也不能每次修改都重启服务。ZStack 的 `GlobalConfig` 体系提供了一套运行时可修改、持久化到数据库、支持变更通知的配置管理框架。

## 整体架构

> 源码位置：zstack/core/src/main/java/org/zstack/core/config/GlobalConfigFacadeImpl.java

`GlobalConfigFacadeImpl` 是全局配置的核心实现，它管理着 41 个 `globalConfig` XML 文件中声明的配置项，将配置持久化到 `GlobalConfigVO` 表，并在配置变更时通知所有注册的扩展点。

```java
public class GlobalConfigFacadeImpl extends AbstractService implements GlobalConfigFacade {
    private static final CLogger logger = Utils.getLogger(GlobalConfigFacadeImpl.class);

    @Autowired
    private CloudBus bus;
    @Autowired
    private DatabaseFacade dbf;
    @Autowired
    private ErrorFacade errf;
    @Autowired
    private PluginRegistry pluginRgty;

    private JAXBContext context;
    private Map<String, GlobalConfig> allConfig = new ConcurrentHashMap<>();

    private static final String CONFIG_FOLDER = "globalConfig";
    private static final String OTHER_CATEGORY = "Others";
}
```

**注意**：`GlobalConfigFacadeImpl` 继承 `AbstractService`，而非直接实现 `Component`。Spring XML 中有明确注释："don't declare GlobalConfigFacade as Component, it's specially handled"。它通过 Spring 的 `default-init-method="init"` 机制初始化，而非 `Component.start()`。

## globalConfig XML 声明

> 源码位置：zstack/conf/globalConfig/

每个模块通过 `globalConfig` XML 文件声明自己的配置项。以 KVM 模块为例：

> 源码位置：zstack/conf/globalConfig/kvm.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<globalConfig>
    <config name="kvm.host.pingInterval" defaultValue="60" type="Long">
        <description>KVM host ping interval in seconds</description>
    </config>

    <config name="kvm.host.pingMaxFailures" defaultValue="3" type="Integer">
        <description>Max ping failures before marking host as disconnected</description>
    </config>

    <config name="kvm.host.reconnectInterval" defaultValue="60" type="Long">
        <description>KVM host reconnect interval in seconds</description>
    </config>

    <config name="kvm.host.reconnectMaxAttempts" defaultValue="10" type="Integer">
        <description>Max reconnect attempts before giving up</description>
    </config>

    <config name="kvm.vm.migration.bandwidth" defaultValue="0" type="Long">
        <description>Migration bandwidth limit in MBps, 0 means unlimited</description>
    </config>

    <config name="kvm.vm.migration.downtime" defaultValue="500" type="Integer">
        <description>Migration downtime in milliseconds</description>
    </config>

    <config name="kvm.host.reserveCpu" defaultValue="0" type="Integer">
        <description>Reserved CPU capacity on each host</description>
    </config>

    <config name="kvm.host.reserveMemory" defaultValue="0" type="Long">
        <description>Reserved memory capacity on each host in MB</description>
    </config>

    <config name="kvm.host.cpuOverProvisionRatio" defaultValue="1.0" type="Double">
        <description>CPU over-provisioning ratio</description>
    </config>

    <config name="kvm.host.memoryOverProvisionRatio" defaultValue="1.0" type="Double">
        <description>Memory over-provisioning ratio</description>
    </config>

    <config name="kvm.snapshot.chain.length" defaultValue="32" type="Integer">
        <description>Max snapshot chain length</description>
    </config>

    <config name="kvm.vm.consoleProxyPort" defaultValue="5900" type="Integer">
        <description>Console proxy starting port</description>
    </config>

    <config name="kvm.host.agentCommandTimeout" defaultValue="300" type="Long">
        <description>Agent command timeout in seconds</description>
    </config>

    <config name="kvm.host.agentCommandRetry" defaultValue="0" type="Integer">
        <description>Agent command retry count</description>
    </config>

    <config name="kvm.host.qemuSocketPath" defaultValue="/var/lib/libvirt/qemu" type="String">
        <description>QEMU socket path</description>
    </config>

    <config name="kvm.host.libvirtSocketPath" defaultValue="/var/run/libvirt/libvirt-sock" type="String">
        <description>Libvirt socket path</description>
    </config>

    <config name="kvm.vm.destroy.delay" defaultValue="0" type="Long">
        <description>Delay before destroying VM in seconds</description>
    </config>

    <config name="kvm.host.checkPhysicalNetworkCpsCapacity" defaultValue="false" type="Boolean">
        <description>Check physical network CPS capacity when attaching L2</description>
    </config>
</globalConfig>
```

每个 `<config>` 条目包含：
- `name`：配置项的全局唯一名称，通常以模块名作前缀
- `defaultValue`：默认值
- `type`：值类型（Long、Integer、Double、Boolean、String）
- `<description>`：配置项描述

## GlobalConfig 数据模型

### GlobalConfigVO

配置项持久化到 `GlobalConfigVO` 表：

> 源码位置：zstack/core/src/main/java/org/zstack/core/config/GlobalConfigVO.java

```java
@Entity
@Table
public class GlobalConfigVO {
    @Id
    @GeneratedValue(strategy=GenerationType.IDENTITY)
    @Column
    private long id;

    @Column(updatable=false)
    private String name;

    @Column
    private String description;

    @Column
    private String category;

    @Column
    private String defaultValue;

    @Column
    private String value;
}
```

**注意**：主键是自增 `id`，而非 `name`。`name` 列标记为 `updatable=false`，确保配置项名称不可修改。

### GlobalConfig 运行时对象

> 源码位置：zstack/core/src/main/java/org/zstack/core/config/GlobalConfig.java

```java
@Configurable(preConstruction = true, autowire = Autowire.BY_TYPE)
public class GlobalConfig {
    private String name;
    private String category;
    private String description;
    private String type;
    private String validatorRegularExpression;
    private String defaultValue;
    private volatile String value;
    private boolean linked;

    private transient List<GlobalConfigUpdateExtensionPoint> updateExtensions = new ArrayList<>();
    private transient List<GlobalConfigBeforeUpdateExtensionPoint> beforeUpdateExtensions = new ArrayList<>();
    private transient List<GlobalConfigBeforeResetExtensionPoint> beforeResetExtensions = new ArrayList<>();
    private transient List<GlobalConfigValidatorExtensionPoint> validators = new ArrayList<>();
    private transient List<GlobalConfigQueryExtensionPoint> queryExtensions = new ArrayList<>();
    private transient List<GlobalConfigUpdateExtensionPoint> localUpdateExtensions = new ArrayList<>();
    private transient List<GlobalConfigBeforeUpdateExtensionPoint> localBeforeUpdateExtensions = new ArrayList<>();

    @Autowired
    private DatabaseFacade dbf;
    @Autowired
    private EventFacade evtf;

    public <T> T value(Class<T> clz) {
        return TypeUtils.stringToValue(value(), clz);
    }

    public <T> T defaultValue(Class<T> clz) {
        return TypeUtils.stringToValue(defaultValue, clz);
    }
}
```

**关键设计**：
- `value` 字段使用 `volatile` 修饰，保证多线程可见性
- 变更监听器直接存储在 `GlobalConfig` 对象内部（而非 `GlobalConfigFacadeImpl` 中），每个配置项独立管理自己的扩展点
- `@Configurable` 注解使 Spring 能对 `new` 出来的对象也进行依赖注入

## 启动流程

`GlobalConfigFacadeImpl` 的初始化通过 Spring 的 `default-init-method="init"` 触发。`start()` 方法中定义了一个内部类 `GlobalConfigInitializer`，执行完整的配置加载流程：

```java
@Override
public boolean start() {
    class GlobalConfigInitializer {
        Map<String, GlobalConfig> configsFromXml = new HashMap<String, GlobalConfig>();
        Map<String, GlobalConfig> configsFromDatabase = new HashMap<String, GlobalConfig>();
        List<Field> globalConfigFields = new ArrayList<Field>();
        Map<String, String> propertiesMap = new HashMap<>();

        void init() {
            GLock lock = new GLock(GlobalConfigConstant.LOCK, 320);
            lock.lock();
            try {
                loadSystemProperties();
                parseGlobalConfigFields();
                loadConfigFromXml();
                loadConfigFromJava();
                loadConfigFromAutoGeneration();
                loadConfigFromDatabase();
                createValidatorForBothXmlAndDatabase();
                validateConfigFromXml();
                validateConfigFromDatabase();
                persistConfigInXmlButNotInDatabase();
                mergeXmlDatabase();
                link();
                initAllConfig();
                allConfig.putAll(configsFromXml);
                validateAll();
            } catch (IllegalArgumentException ie) {
                throw ie;
            } catch (Exception e) {
                throw new CloudRuntimeException(e);
            } finally {
                lock.unlock();
            }
        }
    }

    GlobalConfigInitializer initializer = new GlobalConfigInitializer();
    initializer.init();

    GuestOsHelper.getInstance().initGuestOsRelatedDb();

    return true;
}
```

### 初始化步骤详解

1. **loadSystemProperties** —— 加载系统属性，用于配置值中的 `${property}` 占位符替换
2. **parseGlobalConfigFields** —— 通过反射扫描所有 `@GlobalConfigDefinition` 标注的类，收集 `GlobalConfig` 类型的静态字段
3. **loadConfigFromXml** —— 使用 JAXB 解析 `globalConfig` 目录下所有 XML 文件，将配置项加载到 `configsFromXml`
4. **loadConfigFromJava** —— 解析 `@GlobalConfigDef` 标注的字段，将 Java 定义的配置项也加入 `configsFromXml`
5. **loadConfigFromAutoGeneration** —— 调用 `GlobalConfigInitExtensionPoint` 扩展点，加载动态生成的配置项
6. **loadConfigFromDatabase** —— 从 `GlobalConfigVO` 表加载已持久化的配置项到 `configsFromDatabase`
7. **createValidatorForBothXmlAndDatabase** —— 为每个配置项创建类型校验器和正则校验器
8. **validateConfigFromXml / validateConfigFromDatabase** —— 校验所有配置项的值
9. **persistConfigInXmlButNotInDatabase** —— 将 XML 中新增的配置项持久化到数据库，删除数据库中已过时的配置项，更新默认值变更的配置项
10. **mergeXmlDatabase** —— 合并 XML 定义和数据库值：数据库中的值覆盖 XML 默认值
11. **link** —— 将 `GlobalConfigDefinition` 类中的静态 `GlobalConfig` 字段与 XML/数据库中的配置项关联
12. **initAllConfig** —— 调用每个 `GlobalConfig` 的 `init()` 方法，注册跨管理节点同步的事件监听
13. **validateAll** —— 最终校验所有配置项

### loadConfigFromXml —— XML 解析

```java
private void loadConfigFromXml() throws JAXBException {
    context = JAXBContext.newInstance("org.zstack.core.config.schema");
    List<String> filePaths = PathUtil.scanFolderOnClassPath(CONFIG_FOLDER);
    for (String path : filePaths) {
        File f = new File(path);
        parseConfig(f);
    }
}
```

`parseConfig` 使用 JAXB 将 XML 反序列化为 `org.zstack.core.config.schema.GlobalConfig` 对象，再转换为运行时 `GlobalConfig`。解析过程中会进行系统属性占位符替换（`${property}`）和重复配置检测。

### loadConfigFromJava —— Java 注解定义

```java
@GlobalConfigDefinition
public class SomeGlobalConfigDefinition {
    @GlobalConfigDef(defaultValue = "60", type = Long.class, description = "...")
    @GlobalConfigValidation(numberGreaterThan = 0)
    public static GlobalConfig SOME_CONFIG = new GlobalConfig("category", "someConfig");
}
```

`@GlobalConfigDef` 在字段上声明配置项的默认值、类型和描述；`@GlobalConfigValidation` 声明校验规则（数值范围、非空、合法值列表等）。

### link —— 关联 Java 字段与配置项

```java
private void link(Field field, final GlobalConfig old) throws IllegalAccessException {
    GlobalConfig xmlConfig = configsFromXml.get(old.getIdentity());
    DebugUtils.Assert(xmlConfig != null, ...);
    final GlobalConfig config = old.copy(xmlConfig);
    field.set(null, config);
    configsFromXml.put(old.getIdentity(), config);

    final GlobalConfigValidation at = field.getAnnotation(GlobalConfigValidation.class);
    if (at != null) {
        // 安装各种校验扩展点：notNull、notEmpty、numberGreaterThan、
        // numberLessThan、inNumberRange、validValues
        ...
    }

    config.installQueryExtension(new GlobalConfigQueryExtensionPoint() { ... });
    config.setConfigDef(field.getAnnotation(GlobalConfigDef.class));
    config.setLinked(true);
}
```

`link` 方法将 Java 代码中的 `GlobalConfig` 静态字段与 XML/数据库中的配置项关联，并安装 `@GlobalConfigValidation` 声明的校验器。关联后，代码中通过 `SomeGlobalConfigDefinition.SOME_CONFIG` 即可直接访问配置值。

## 核心 API

### 获取配置值

```java
@Override
public <T> T getConfigValue(String category, String name, Class<T> clz) {
    GlobalConfig c = allConfig.get(GlobalConfig.produceIdentity(category, name));
    DebugUtils.Assert(c!=null, String.format("cannot find GlobalConfig[category:%s, name:%s]", category, name));
    return c.value(clz);
}

@Override
public Map<String, GlobalConfig> getAllConfig() {
    return allConfig;
}
```

配置项的 identity 由 `category.name` 组成，通过 `GlobalConfig.produceIdentity()` 生成。

### 更新配置值

```java
private void handle(APIUpdateGlobalConfigMsg msg) {
    APIUpdateGlobalConfigEvent evt = new APIUpdateGlobalConfigEvent(msg.getId());
    GlobalConfig globalConfig = allConfig.get(msg.getIdentity());
    if (globalConfig == null) {
        ErrorCode err = argerr("Unable to find GlobalConfig[category: %s, name: %s]", msg.getCategory(), msg.getName());
        evt.setError(err);
        bus.publish(evt);
        return;
    }

    try {
        globalConfig.updateValue(msg.getValue());

        GlobalConfigInventory inv = GlobalConfigInventory.valueOf(globalConfig.reload());
        pluginRgty.getExtensionList(AfterUpdateClobalConfigExtensionPoint.class)
            .forEach(point -> point.saveSaveEncryptAfterUpdateClobalConfig(inv));
        evt.setInventory(inv);
    } catch (GlobalConfigException e) {
        evt.setError(argerr(e.getMessage()));
        logger.warn(e.getMessage(), e);
    }

    bus.publish(evt);
}
```

更新流程委托给 `GlobalConfig.updateValue()`，该方法内部执行：
1. 值相同时跳过更新
2. 系统属性占位符替换
3. 调用所有 `GlobalConfigValidatorExtensionPoint` 校验新值
4. 调用所有 `GlobalConfigBeforeUpdateExtensionPoint` 前置回调
5. 更新内存中的 `value` 字段
6. 持久化到 `GlobalConfigVO` 表
7. 调用所有 `GlobalConfigUpdateExtensionPoint` 变更回调
8. 通过 `EventFacade` 发送跨管理节点同步事件

### GlobalConfig.updateValue 内部实现

```java
public void updateValue(Object val) {
    if (TypeUtils.nullSafeEquals(value, val)) {
        return;
    }

    String newValue = val == null ? null : val.toString();
    update(newValue, true);
}

private void update(String newValue, boolean localUpdate) {
    newValue = StringTemplate.substitute(newValue, propertiesMap);
    validate(newValue);
    executeUpdate(newValue, localUpdate);
}

private void executeUpdate(String newValue, boolean localUpdate) {
    GlobalConfigVO vo = dbf.createQuery(GlobalConfigVO.class)
        .add(GlobalConfigVO_.category, Op.EQ, category)
        .add(GlobalConfigVO_.name, Op.EQ, name)
        .find();
    final GlobalConfig origin = valueOf(vo);

    for (GlobalConfigBeforeUpdateExtensionPoint ext : beforeUpdateExtensions) {
        ext.beforeUpdateExtensionPoint(origin, newValue);
    }

    if (localUpdate) {
        for (GlobalConfigBeforeUpdateExtensionPoint ext : localBeforeUpdateExtensions) {
            ext.beforeUpdateExtensionPoint(origin, newValue);
        }
    }

    value = newValue;

    if (localUpdate) {
        vo.setValue(newValue);
        dbf.update(vo);

        CollectionUtils.safeForEach(localUpdateExtensions, ext ->
            ext.updateGlobalConfig(origin, this));
    }

    for (GlobalConfigUpdateExtensionPoint ext : updateExtensions) {
        try {
            ext.updateGlobalConfig(origin, this);
        } catch (Throwable t) {
            logger.warn(String.format("unhandled exception when calling %s", ext.getClass()), t);
        }
    }

    if (localUpdate) {
        UpdateEvent evt = new UpdateEvent();
        evt.setOldValue(origin.value());
        evt.setNewValue(newValue);
        evtf.fire(makeUpdateEventPath(), evt);
    }
}
```

## 扩展点体系

### GlobalConfigUpdateExtensionPoint

配置变更的核心扩展点。任何需要响应配置变更的组件都实现此接口：

```java
public interface GlobalConfigUpdateExtensionPoint {
    void updateGlobalConfig(GlobalConfig oldConfig, GlobalConfig newConfig);
}
```

**注意**：回调参数是 `GlobalConfig` 对象（包含旧值和新值），而非简单的字符串。扩展点通过 `GlobalConfig.installUpdateExtension()` 注册到具体的配置项上。

### GlobalConfigValidatorExtensionPoint

配置值校验扩展点，在值更新前执行校验：

```java
public interface GlobalConfigValidatorExtensionPoint {
    void validateGlobalConfig(String category, String name, String oldValue, String newValue) throws GlobalConfigException;
}
```

校验失败时抛出 `GlobalConfigException`，阻止配置更新。

### GlobalConfigBeforeUpdateExtensionPoint

配置更新前置回调，可以在更新前执行拦截逻辑：

```java
public interface GlobalConfigBeforeUpdateExtensionPoint {
    void beforeUpdateExtensionPoint(GlobalConfig oldConfig, String newValue);
}
```

### GlobalConfigBeforeResetExtensionPoint

配置重置前置回调，用于在全局配置重置时执行拦截：

```java
public interface GlobalConfigBeforeResetExtensionPoint {
    void beforeResetExtensionPoint(SessionInventory session) throws SkipResetGlobalConfigException;
}
```

抛出 `SkipResetGlobalConfigException` 可跳过该配置项的重置。

### GlobalConfigInitExtensionPoint

动态配置生成扩展点，用于在初始化时生成难以预定义的配置项：

```java
public interface GlobalConfigInitExtensionPoint {
    List<GlobalConfig> getGenerationGlobalConfig();
}
```

**注意**：此方法是只读的，不应写入数据库或修改已有配置项，`GlobalConfigFacade` 会自动处理持久化。

### AfterUpdateClobalConfigExtensionPoint

配置更新后回调，用于加密配置等特殊处理：

```java
public interface AfterUpdateClobalConfigExtensionPoint {
    void saveSaveEncryptAfterUpdateClobalConfig(GlobalConfigInventory inventory);
}
```

## 跨管理节点同步

当多个管理节点同时运行时，配置变更需要同步。`GlobalConfig.init()` 方法通过 `EventFacade` 注册事件监听：

```java
void init() {
    evtf.on(s(GlobalConfigCanonicalEvents.UPDATE_EVENT_PATH).formatByMap(map(
            e("category", category),
            e("name", name)
    )), new EventCallback() {
        @Override
        public void run(Map tokens, Object data) {
            String nodeUuid = (String) tokens.get("nodeUuid");
            if (Platform.getManagementServerId().equals(nodeUuid)) {
                return;
            }

            String newValue = Q.New(GlobalConfigVO.class).select(GlobalConfigVO_.value)
                    .eq(GlobalConfigVO_.category, category)
                    .eq(GlobalConfigVO_.name, name)
                    .findValue();
            update(newValue, false);

            UpdateEvent evt = (UpdateEvent)data;
            logger.info(String.format("GlobalConfig[category: %s, name: %s] was updated in other management node[uuid:%s]," +
                    "in line with that change, updated ours. %s --> %s", category, name, nodeUuid, evt.getOldValue(), value));
        }
    });
}
```

当其他管理节点更新配置时，本节点收到事件后从数据库读取新值并更新内存（`localUpdate=false`，不触发数据库写入和事件发送，避免循环）。

## 配置项分类

41 个 `globalConfig` XML 文件按模块组织：

| 文件 | 模块 | 典型配置项 |
|------|------|-----------|
| kvm.xml | KVM 虚拟化 | pingInterval, cpuOverProvisionRatio |
| cloudbus.xml | 消息总线 | messageTtl, statisticsOn |
| host.xml | 主机管理 | reconnectInterval, pingParallelLevel |
| vm.xml | 虚拟机 | createTimeout, destroyDelay |
| volume.xml | 云盘 | snapshotChainLength, deleteRateLimit |
| network.xml | 网络 | l2NetworkRealizationTimeout |
| image.xml | 镜像 | downloadTimeout, deleteImageCache |
| identity.xml | 认证 | sessionTimeout, accountInitPassword |
| primaryStorage.xml | 主存储 | mountTimeout, deleteImageCacheOnHost |

## 配置项的运行时修改

ZStack 提供了 API 来运行时修改配置：

```java
@RestRequest(
    path = "/global-configs/{name}/actions",
    method = HttpMethod.PUT,
    responseClass = APIUpdateGlobalConfigEvent.class
)
public class APIUpdateGlobalConfigMsg extends APIMessage {
    @APIParam
    private String name;

    @APIParam
    private String value;
}
```

修改流程：
1. API 请求到达 `GlobalConfigFacadeImpl.handleMessage()`
2. 调用 `GlobalConfig.updateValue()` 更新配置
3. `updateValue` 内部执行校验、前置回调、更新内存、持久化数据库、变更回调
4. 通过 `EventFacade` 发送跨管理节点同步事件
5. 返回成功响应

**无需重启**：配置变更立即生效，因为所有读取都通过 `allConfig` 内存 Map 进行。

## Spring XML 配置

> 源码位置：zstack/conf/springConfigXml/GlobalConfigFacade.xml

```xml
<bean id="GlobalConfigFacade" class="org.zstack.core.config.GlobalConfigFacadeImpl">
    <zstack:plugin>
        <!-- don't declare GlobalConfigFacade as Component, it's specially handled -->
        <zstack:extension interface="org.zstack.header.Service" />
    </zstack:plugin>
</bean>
```

**关键细节**：
- 使用 `default-init-method="init"` 触发初始化，而非 `Component.start()`
- 声明为 `Service` 扩展而非 `Component` 扩展，有明确注释说明这是特殊处理
- `GlobalConfigFacade` 必须在其他 `Component` 之前初始化，因为很多组件依赖全局配置

## 设计总结

| 设计决策 | 实现方式 | 优势 |
|---------|---------|------|
| XML + Java 注解声明配置项 | `globalConfig` 目录 XML + `@GlobalConfigDef` | 灵活定义，模块化组织 |
| 数据库持久化 | `GlobalConfigVO` 表 | 配置变更持久化，重启不丢失 |
| 内存缓存 | `ConcurrentHashMap<String, GlobalConfig>` | 读取零开销，线程安全 |
| 变更通知 | `GlobalConfigUpdateExtensionPoint`（per-config） | 组件可实时响应配置变更 |
| 类型校验 | `GlobalConfigValidatorExtensionPoint` + `@GlobalConfigValidation` | 防止类型错误和非法值 |
| 跨节点同步 | `EventFacade` 事件机制 | 多管理节点配置一致性 |
| API 修改 | `APIUpdateGlobalConfigMsg` | 运行时修改，无需重启 |
| 默认值机制 | XML defaultValue + 数据库回退 | 首次启动自动初始化 |
