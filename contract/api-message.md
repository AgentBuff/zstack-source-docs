# 13 - API 消息体系

ZStack 的所有外部交互都通过 API 消息完成。从用户发起 HTTP 请求，到管理节点内部服务间通信，再到最终返回响应，整个链路以消息为载体贯穿始终。这套消息体系不是简单的 DTO，而是一个拥有继承层次、声明式校验、自动路由和代码生成能力的完整框架。

## 消息继承体系

### 根：Message 与 NeedReplyMessage

所有消息的根基是 `Message` 类，它携带消息 ID、服务 ID 等元数据。`NeedReplyMessage` 在此基础上增加了超时机制和 SystemTag 支持：

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/NeedReplyMessage.java

```java
public abstract class NeedReplyMessage extends Message {
    @APINoSee
    protected long timeout = -1;
    @APINoSee
    protected long messageDeadline = -1;
    protected List<String> systemTags;
    protected List<String> userTags;
}
```

`timeout` 字段控制消息的生命周期——超过此时间的回复将被丢弃。`systemTags` 是 ZStack 的一个核心设计模式，允许在不修改消息定义的情况下传递附加参数。

### APIMessage：所有 API 消息的基类

`APIMessage` 是所有对外 API 消息的基类，它扩展了 `NeedReplyMessage` 并实现了 `ConfigurableTimeoutMessage` 接口：

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIMessage.java

```java
public abstract class APIMessage extends NeedReplyMessage 
    implements ConfigurableTimeoutMessage {
    @NoJsonSchema
    @APINoSee
    private SessionInventory session;
    @APINoSee
    private String clientIp;
    @APINoSee
    private String clientBrowser;
}
```

三个关键字段：

| 字段 | 作用 |
|------|------|
| `session` | 当前用户的会话信息，用于身份认证和权限校验 |
| `clientIp` | 请求来源 IP，用于审计日志 |
| `clientBrowser` | 客户端浏览器信息 |

`APIMessage` 还包含一个极其重要的静态机制——**参数自动收集**：

```java
@NoJsonSchema
@APINoSee
@GsonTransient
public static Map<Class, Collection<FieldParam>> apiParams = new HashMap<>();

@NoJsonSchema
@APINoSee
@GsonTransient
public static Set<Class> apiMessageClasses = BeanUtils.reflections
    .getSubTypesOf(APIMessage.class)
    .stream()
    .filter(c -> !Modifier.isStatic(c.getModifiers()) 
        && c.isAnnotationPresent(RestRequest.class))
    .collect(Collectors.toSet());
```

在类加载时，`APIMessage` 通过反射扫描所有带有 `@RestRequest` 注解的子类，收集每个字段的 `@APIParam` 注解信息，存入 `apiParams` 静态 Map。这为后续的参数校验和 API 文档生成提供了数据基础。

### APIMessage.validate()：声明式校验引擎

`APIMessage` 提供了 `validate()` 方法，基于收集到的 `@APIParam` 注解自动校验所有字段：

```java
public void validate(Collection<ApiMessageValidator> validators) throws IllegalAccessException {
    Collection<FieldParam> params = apiParams.get(this.getClass());
    for (FieldParam fp : params) {
        Field f = fp.field;
        final APIParam at = fp.param;
        f.setAccessible(true);
        Object value = f.get(this);
        // 自动 trim 字符串
        if (value instanceof String && !at.noTrim()) {
            value = ((String) value).trim();
            f.set(this, value);
        }
        // 依次调用校验器
        for (ApiMessageValidator validator : validators) {
            validator.validate(this, f, value, at);
        }
    }
}
```

校验失败时抛出 `InvalidApiMessageException`，携带格式化的错误信息。

## 消息分类继承

### APICreateMessage

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APICreateMessage.java

```java
public class APICreateMessage extends APIMessage {
    private String resourceUuid;
    @APIParam(required = false, checkAccount = true, resourceType = TagPatternVO.class)
    private List<String> tagUuids;
    
    public void addSystemTag(String tag) { ... }
}
```

`APICreateMessage` 为所有"创建资源"的 API 添加了两个通用字段：

- **`resourceUuid`**：允许调用方指定资源的 UUID。ZStack 的 UUID 是 32 位无连字符格式（标准 UUID v4 去掉连字符），如 `5d94103e19254d8696c0f05489c259ab`。如果指定的 UUID 与已有资源冲突，将返回内部错误。
- **`tagUuids`**：创建时直接关联标签。

### APIDeleteMessage

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIDeleteMessage.java

```java
public abstract class APIDeleteMessage extends APIMessage {
    private String deleteMode = DeletionMode.Permissive.toString();

    public static enum DeletionMode {
        Enforcing,
        Permissive,
    }
}
```

删除模式是 ZStack 的一个重要安全设计：

| 模式 | 行为 |
|------|------|
| **Permissive**（默认） | 允许扩展点检查，任何扩展拒绝删除则返回错误 |
| **Enforcing** | 强制删除，跳过删除检查，忽略所有删除错误 |

### APISyncCallMessage 与 APIQueryMessage

同步调用消息标记了"需要同步等待回复"的语义。`APIQueryMessage` 是所有查询 API 的基类：

> 源码位置：zstack/header/src/main/java/org/zstack/header/query/APIQueryMessage.java

```java
public abstract class APIQueryMessage extends APISyncCallMessage {
    @APIParam
    private List<QueryCondition> conditions;
    private Integer limit = 1000;
    private Integer start;
    private boolean count;
    private String groupBy;
    private boolean replyWithCount;
    private String filterName;
    private String sortBy;
    @APIParam(required = false, validValues = {"asc", "desc"})
    private String sortDirection = "asc";
    private List<String> fields;
}
```

查询消息提供了完整的分页、过滤、排序和字段选择能力：

| 字段 | 作用 |
|------|------|
| `conditions` | 查询条件列表，支持 `=`, `!=`, `>`, `<`, `in`, `not in`, `like` 等操作符 |
| `limit` | 每页数量，默认 1000 |
| `start` | 分页偏移量 |
| `count` | 仅返回计数 |
| `groupBy` | 分组字段 |
| `sortBy` | 排序字段 |
| `sortDirection` | 排序方向：`asc` 或 `desc` |
| `fields` | 仅返回指定字段 |

## @RestRequest：声明式 REST 路由

每个 API 消息类通过 `@RestRequest` 注解声明其 HTTP 映射：

> 源码位置：zstack/header/src/main/java/org/zstack/header/rest/RestRequest.java

```java
@Target({ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface RestRequest {
    String path();
    String[] optionalPaths() default {};
    HttpMethod method();
    boolean isAction() default false;
    String parameterName() default RESTConstant.DEFAULT_PARAMETER_NAME;
    String[] mappingFields() default {};
    Class responseClass();
    String category() default "";
    String morphTransform() default "";
}
```

| 属性 | 说明 |
|------|------|
| `path` | HTTP 路径，如 `/vm-instances` |
| `optionalPaths` | 额外可选路径 |
| `method` | HTTP 方法（GET/POST/PUT/DELETE） |
| `isAction` | 是否为 Action 类型（非 CRUD 操作） |
| `parameterName` | 请求体中的参数名，默认为消息类名 |
| `responseClass` | 响应事件类 |
| `category` | API 分类 |
| `mappingFields` | 字段映射 |

### 完整示例：APICreateVmInstanceMsg

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/APICreateVmInstanceMsg.java

```java
@TagResourceType(VmInstanceVO.class)
@Action(category = VmInstanceConstant.ACTION_CATEGORY)
@RestRequest(
    path = "/vm-instances",
    method = HttpMethod.POST,
    responseClass = APICreateVmInstanceEvent.class,
    parameterName = "params"
)
@DefaultTimeout(timeunit = TimeUnit.HOURS, value = 12)
public class APICreateVmInstanceMsg extends APICreateMessage 
    implements APIAuditor, NewVmInstanceMessage2 {
    
    @APIParam(maxLength = 255)
    private String name;

    @APIParam(resourceType = InstanceOfferingVO.class, checkAccount = true, required = false)
    private String instanceOfferingUuid;

    @APIParam(resourceType = ImageVO.class, checkAccount = true, required = false, emptyString = false)
    private String imageUuid;

    @APIParam(resourceType = L3NetworkVO.class, checkAccount = true, required = false)
    private List<String> l3NetworkUuids;

    @APIParam(validValues = {"UserVm", "ApplianceVm"}, required = false)
    private String type;

    @APIParam(required = false, validValues = {"InstantStart", "JustCreate", "CreateStopped"})
    private String strategy = VmCreationStrategy.InstantStart.toString();

    @APIParam(required = false, maxLength = 32, 
        validValues = {"x86_64", "aarch64", "mips64el", "loongarch64"})
    private String architecture;
    // ... 更多字段
}
```

这个例子展示了 `@RestRequest` 和 `@APIParam` 的完整配合：

1. `@RestRequest` 声明：POST `/vm-instances`，响应类为 `APICreateVmInstanceEvent`
2. `@DefaultTimeout` 设置 12 小时超时（创建 VM 可能很慢）
3. `@APIParam` 对每个字段声明校验规则
4. 继承 `APICreateMessage`，自动获得 `resourceUuid` 和 `systemTags`

## @APIParam：声明式参数校验

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIParam.java

```java
@Target(java.lang.annotation.ElementType.FIELD)
@Retention(java.lang.annotation.RetentionPolicy.RUNTIME)
public @interface APIParam {
    boolean operationTarget() default false;
    boolean required() default true;
    String[] validValues() default {};
    String validRegexValues() default "";
    Class resourceType() default Object.class;
    int maxLength() default Integer.MIN_VALUE;
    int minLength() default 0;
    boolean nonempty() default false;
    boolean nullElements() default false;
    boolean emptyString() default true;
    long[] numberRange() default {};
    double[] floatNumberRange() default {};
    String[] numberRangeUnit() default {};
    boolean checkAccount() default false;
    boolean noOwnerCheck() default false;
    boolean noTrim() default false;
    boolean successIfResourceNotExisting() default false;
}
```

校验能力一览：

| 属性 | 作用 | 示例 |
|------|------|------|
| `required` | 是否必填（默认 true） | `required = false` |
| `validValues` | 枚举值白名单 | `validValues = {"UserVm", "ApplianceVm"}` |
| `validRegexValues` | 正则校验 | `validRegexValues = VmInstanceConstant.USER_VM_REGEX_PASSWORD` |
| `resourceType` | 引用的资源类型，用于资源存在性校验 | `resourceType = InstanceOfferingVO.class` |
| `maxLength` / `minLength` | 字符串长度范围 | `maxLength = 255` |
| `numberRange` | 数值范围 | `numberRange = {0, Long.MAX_VALUE}` |
| `checkAccount` | 是否校验资源归属当前账户 | `checkAccount = true` |
| `emptyString` | 是否允许空字符串（默认允许） | `emptyString = false` |
| `nonempty` | 集合不允许为空 | `nonempty = true` |
| `noTrim` | 不自动 trim 字符串 | `noTrim = true` |

`resourceType` + `checkAccount` 的组合特别强大——框架会自动检查引用的资源是否存在，以及是否属于当前登录账户，无需在业务代码中手动校验。

## @AutoQuery：自动查询 API 生成

> 源码位置：zstack/header/src/main/java/org/zstack/header/query/AutoQuery.java

```java
@Target({ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface AutoQuery {
    Class replyClass();
    Class inventoryClass();
}
```

`@AutoQuery` 注解标记在查询消息类上，声明其回复类和 Inventory 类。配合 `@ExpandedQueries` 注解在 Inventory 类上声明的扩展查询字段，ZStack 的 QueryFacade 可以自动生成完整的查询能力，包括：

- 基于 VO 表字段的精确/模糊查询
- 基于 `@ExpandedQueries` 的跨表关联查询
- 自动分页、排序、字段选择

## 响应体系：APIEvent 与 APIReply

### APIEvent：异步操作响应

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIEvent.java

```java
public class APIEvent extends Event implements APIResponse {
    @APINoSee
    protected final String apiId;
    protected boolean success;
    @NeedJsonSchema
    protected ErrorCode error;

    public APIEvent(String apiId) {
        this.apiId = apiId;
        this.success = true;
    }

    public void setError(ErrorCode errorCode) {
        this.success = false;
        this.error = errorCode;
    }
}
```

`APIEvent` 的核心设计：

- **`apiId`**：关联请求消息的 ID，实现请求-响应的配对
- **`success`**：操作是否成功，客户端必须首先检查此字段
- **`error`**：失败时的错误详情，包含错误码和详细描述

### APIReply：同步调用响应

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIReply.java

```java
public class APIReply extends MessageReply implements APIResponse {
}
```

`APIReply` 是同步调用的轻量级响应，用于不需要返回 Inventory 数据的简单操作。

### 具体事件示例：APICreateVmInstanceEvent

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/APICreateVmInstanceEvent.java

```java
@RestResponse(allTo = "inventory")
public class APICreateVmInstanceEvent extends APIEvent {
    private VmInstanceInventory inventory;

    public APICreateVmInstanceEvent(String apiId) {
        super(apiId);
    }
}
```

`@RestResponse(allTo = "inventory")` 声明将所有字段映射到 `inventory` 键下。响应的 JSON 结构为：

```json
{
    "org.zstack.header.vm.APICreateVmInstanceEvent": {
        "inventory": { ... },
        "success": true
    }
}
```

## serviceConfig：消息路由配置

API 消息如何路由到正确的服务？答案在 `conf/serviceConfig/` 目录下的 XML 配置文件中。

> 源码位置：zstack/conf/serviceConfig/vmInstance.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<service xmlns="http://zstack.org/schema/zstack">
    <id>vmInstance</id>
    <interceptor>VmInstanceApiInterceptor</interceptor>

    <message>
        <name>org.zstack.header.vm.APICreateVmInstanceMsg</name>
    </message>
    <message>
        <name>org.zstack.header.vm.APIStopVmInstanceMsg</name>
    </message>
    <message>
        <name>org.zstack.header.vm.APIStartVmInstanceMsg</name>
    </message>
    <message>
        <name>org.zstack.header.vm.APIQueryVmInstanceMsg</name>
        <serviceId>query</serviceId>
    </message>
    <message>
        <name>org.zstack.header.vm.APIGetVmTaskMsg</name>
        <serviceId>core</serviceId>
    </message>
</service>
```

关键设计：

1. **`<id>vmInstance</id>`**：定义服务 ID，所有未指定 `<serviceId>` 的消息默认路由到此服务
2. **`<interceptor>`**：声明 API 拦截器，在消息到达服务前进行预处理（参数校验、权限检查等）
3. **`<serviceId>query</serviceId>`**：查询消息路由到专门的 query 服务，由 QueryFacade 统一处理
4. **`<serviceId>core</serviceId>`**：某些消息路由到 core 服务

路由规则总结：

| 消息类型 | 默认路由 | 特殊路由 |
|----------|----------|----------|
| 创建/删除/更新类 | 服务自身（如 `vmInstance`） | — |
| 查询类（APIQuery*Msg） | — | `query` 服务 |
| 内部辅助类 | — | `core` 服务 |

## 消息流转全景

一个完整的 API 调用流程如下：

```
HTTP Request
    ↓
REST Facade（根据 @RestRequest 解析）
    ↓
APIMessage.validate()（根据 @APIParam 校验）
    ↓
ApiInterceptor（serviceConfig 中声明的拦截器）
    ↓
CloudBus.send()（根据 serviceConfig 路由到目标服务）
    ↓
目标 Service.handleMessage()
    ↓
APIEvent / APIReply（通过 CloudBus 回传）
    ↓
REST Facade → HTTP Response
```

## 设计哲学总结

ZStack 的 API 消息体系体现了几个核心设计原则：

1. **声明式优于命令式**：`@RestRequest`、`@APIParam`、`@AutoQuery` 等注解让开发者只需声明"是什么"，框架自动处理"怎么做"
2. **契约与实现分离**：所有消息定义在 `header/` 模块，路由配置在 `conf/` 中，实现代码在 `compute/` 等模块——三者完全解耦
3. **统一的消息模型**：无论是同步还是异步、创建还是查询，都遵循相同的消息继承体系，降低了认知负担
4. **可扩展的校验框架**：`ApiMessageValidator` 接口允许添加自定义校验逻辑，而不修改框架代码
5. **配置驱动的路由**：serviceConfig XML 让消息路由可配置、可审计，而非硬编码在代码中
