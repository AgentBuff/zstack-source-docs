# 08 - REST 与 API 框架

ZStack 的 REST 框架由两个职责明确分离的组件构成：**RESTFacade** 负责管理节点向 Agent 发起 HTTP 调用（出站），**RESTApiFacade** 负责异步 API 的状态持久化与结果查询。而 HTTP 请求的路由、`@RestRequest` 注解扫描、参数校验等入站处理则由 `RestServer`（位于 `rest` 模块）完成。配合 `serviceConfig` XML 的消息路由机制，整个 API 层从定义到处理形成了一条完整的声明式链路。

## @RestRequest 注解

> 源码位置：zstack/header/src/main/java/org/zstack/header/rest/RestRequest.java

`@RestRequest` 是 API 消息与 HTTP 接口的桥梁：

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

### 实际使用示例

> 源码位置：zstack/plugin/securityGroup/src/main/java/org/zstack/network/securitygroup/APICreateSecurityGroupMsg.java

```java
@TagResourceType(SecurityGroupVO.class)
@Action(category = SecurityGroupConstant.ACTION_CATEGORY)
@RestRequest(
    path = "/security-groups",
    method = HttpMethod.POST,
    responseClass = APICreateSecurityGroupEvent.class,
    parameterName = "params"
)
public class APICreateSecurityGroupMsg extends APICreateMessage implements APIAuditor {
    @APIParam(maxLength = 255)
    private String name;

    @APIParam(required = false, maxLength = 2048)
    private String description;

    @APIParam(required = false, validValues = {"4", "6"})
    private Integer ipVersion;

    @APIParam(required = false, maxLength = 1024, validValues = {"LinuxBridge", "OvnDpdk"})
    private String vSwitchType = "LinuxBridge";
    ...
}
```

这个声明意味着：
- HTTP `POST /security-groups` 映射到 `APICreateSecurityGroupMsg`
- 响应类型为 `APICreateSecurityGroupEvent`
- 请求体以 `params` 为 key 包装 JSON
- `name` 字段必填，最大 255 字符
- `description` 可选，最大 2048 字符
- `vSwitchType` 可选，只接受 `"LinuxBridge"` 或 `"OvnDpdk"`

## @APIParam 注解

> 源码位置：zstack/header/src/main/java/org/zstack/header/message/APIParam.java

```java
@Target({ElementType.FIELD, ElementType.METHOD})
@Retention(RetentionPolicy.RUNTIME)
public @interface APIParam {
    boolean required() default true;
    int maxLength() default 0;
    int minLength() default 0;
    String[] validValues() default {};
    long numberMaximum() default Long.MAX_VALUE;
    long numberMinimum() default Long.MIN_VALUE;
    String description() default "";
    boolean ignore() default false;
}
```

### 校验流程

`@APIParam` 的校验由 `ApiMessageInterceptor` 拦截器链在消息到达 Service 之前执行，而非在 HTTP 层。`RestServer` 在反序列化请求体时通过 `TypeVerifier` 做基本的类型校验：

```java
// RestServer.handleApi() 中的类型校验（简化）
for (Field f : api.apiClass.getDeclaredFields()) {
    String fieldName = f.getName();
    Object object = ((Map) parameter).get(fieldName);
    if (object == null) {
        continue;
    }
    String objectString = object.toString();
    String result = TypeVerifier.verify(f, objectString);
    if (result != null) {
        throw new RestException(HttpStatus.BAD_REQUEST.value(), result);
    }
}
```

## @AutoQuery 自动查询 API

ZStack 的查询 API 通过 `@AutoQuery` 注解实现自动生成。开发者只需定义查询消息类，框架自动生成对应的 SQL 查询：

```java
@AutoQuery
@RestRequest(
    path = "/security-groups",
    method = HttpMethod.GET,
    responseClass = APIQuerySecurityGroupEvent.class
)
public class APIQuerySecurityGroupMsg extends APIQueryMessage {
    @APIParam(required = false)
    private String name;
    ...
}
```

`@AutoQuery` 注解告诉框架，这个 API 需要自动生成查询逻辑，支持：
- 条件过滤（`name=xxx`）
- 分页（`limit=10&start=0`）
- 排序（`sort=+name` 或 `sort=-name`）
- 字段选择（`fields=name,uuid`）
- 关联查询（`join=vmNic`）

## serviceConfig XML —— 消息路由

> 源码位置：zstack/conf/serviceConfig/

API 消息通过 CloudBus 路由到具体的 Service 处理。路由规则定义在 `serviceConfig` XML 文件中：

> 源码位置：zstack/conf/serviceConfig/kvm.xml

```xml
<?xml version="1.0" encoding="UTF-8"?>
<service>
    <id>kvm.host</id>

    <message>
        <name>org.zstack.kvm.APIAddKvmHostMsg</name>
        <serviceId>kvm.host</serviceId>
    </message>

    <message>
        <name>org.zstack.kvm.APIReconnectKvmHostMsg</name>
        <serviceId>kvm.host</serviceId>
    </message>

    <message>
        <name>org.zstack.kvm.APIUpdateKvmHostMsg</name>
        <serviceId>kvm.host</serviceId>
    </message>

    <message>
        <name>org.zstack.kvm.KVMHostSyncHttpCallMsg</name>
        <serviceId>kvm.host</serviceId>
    </message>
</service>
```

每个 `<message>` 条目定义了：
- `name`：消息类的全限定名
- `serviceId`：处理该消息的 Service ID

### 路由机制

当 API 请求到达管理节点时：

1. `RestServer` 解析 HTTP 请求，根据 `@RestRequest` 的 `path` 找到对应的 `APIMessage` 类
2. 反序列化请求体为 `APIMessage` 对象
3. `RestServer` 将 `msg.setServiceId(ApiMediatorConstant.SERVICE_ID)` 设置为 API 中转服务
4. 通过 CloudBus 将消息发送到 API Mediator，再由 Mediator 根据 `serviceConfig` XML 路由到目标 Service
5. Service 处理消息后，通过 CloudBus 返回 `APIEvent`

## RESTFacade —— HTTP 客户端（出站调用）

> 源码位置：zstack/core/src/main/java/org/zstack/core/rest/RESTFacadeImpl.java

`RESTFacade` 是管理节点向 Agent（如 kvmagent）发起 HTTP 调用的客户端。它**不处理入站 HTTP 请求**，也不扫描 `@RestRequest` 注解。

### 接口定义

> 源码位置：zstack/header/src/main/java/org/zstack/header/rest/RESTFacade.java

```java
public interface RESTFacade {
    void asyncJsonPost(String url, Object body, Map<String, String> headers,
                       AsyncRESTCallback callback, TimeUnit unit, long timeout);
    void asyncJsonPost(String url, Object body, AsyncRESTCallback callback,
                       TimeUnit unit, long timeout);
    void asyncJsonPost(String url, String body, AsyncRESTCallback callback,
                       TimeUnit unit, long timeout);
    void asyncJsonPost(String url, String body, Map<String, String> headers,
                       AsyncRESTCallback callback, TimeUnit unit, long timeout);
    void asyncJsonPost(String url, Object body, Map<String, String> headers,
                       AsyncRESTCallback callback);
    void asyncJsonPost(String url, Object body, AsyncRESTCallback callback);
    void asyncJsonPost(String url, String body, AsyncRESTCallback callback);
    void asyncJsonDelete(String url, String body, Map<String, String> headers,
                         AsyncRESTCallback callback, TimeUnit unit, long timeout);
    void asyncJsonGet(String url, String body, Map<String, String> headers,
                      AsyncRESTCallback callback, TimeUnit unit, long timeout);
    void asyncJson(String url, String body, Map<String, String> headers,
                   HttpMethod method, AsyncRESTCallback callback,
                   TimeUnit unit, long timeout);

    <T> T syncJsonPost(String url, Object body, Class<T> returnClass);
    <T> T syncJsonPost(String url, Object body, Class<T> returnClass,
                       TimeUnit unit, long timeout);
    <T> T syncJsonPost(String url, String body, Class<T> returnClass);
    <T> T syncJsonPost(String url, String body, Map<String, String> headers,
                       Class<T> returnClass);
    <T> T syncJsonPost(String url, String body, Map<String, String> headers,
                       Class<T> returnClass, TimeUnit unit, long timeout);
    <T> T syncJsonDelete(String url, String body, Map<String, String> headers,
                         Class<T> returnClass);
    <T> T syncJsonDelete(String url, String body, Map<String, String> headers,
                         Class<T> returnClass, TimeUnit unit, long timeout);
    <T> T syncJsonGet(String url, String body, Map<String, String> headers,
                      Class<T> returnClass);
    <T> T syncJsonGet(String url, String body, Map<String, String> headers,
                      Class<T> returnClass, TimeUnit unit, long timeout);
    <T> T syncJsonPut(String url, String body, Map<String, String> headers,
                      Class<T> returnClass);
    <T> T syncJsonPut(String url, String body, Map<String, String> headers,
                      Class<T> returnClass, TimeUnit unit, long timeout);

    <T> RestHttp<T> http(Class<T> returnClass);
    ResponseEntity<String> syncRawJson(String url, HttpEntity<String> req,
                                       HttpMethod method, TimeUnit unit, long timeout);
    HttpHeaders syncHead(String url);
    HttpEntity<String> httpServletRequestToHttpEntity(HttpServletRequest req);
    RestTemplate getRESTTemplate();
    void echo(String url, Completion callback);
    void echo(String url, Completion callback, long interval, long timeout);
    Map<String, HttpCallStatistic> getStatistics();
    <T> void registerSyncHttpCallHandler(String path, Class<T> objectType,
                                         SyncHttpCallHandler<T> handler);
    String getBaseUrl();
    String getSendCommandUrl();
    String getCallbackUrl();
    String getHostName();
    int getPort();
    String makeUrl(String path);
    Runnable installBeforeAsyncJsonPostInterceptor(
        BeforeAsyncJsonPostInterceptor interceptor);
}
```

### 核心数据结构

```java
public class RESTFacadeImpl implements RESTFacade {
    @Autowired
    private ThreadFacade thdf;
    @Autowired
    private ApiTimeoutManager timeoutMgr;
    @Autowired
    private ValidationFacade vf;

    private String hostname;
    private int port = 8080;
    private String path;
    private String callbackUrl;
    private TimeoutRestTemplate template;
    private AsyncRestTemplate asyncRestTemplate;
    private String baseUrl;
    private String sendCommandUrl;
    private String callbackHostName;

    private final int notifiedFailureHttpTasksSize = 128;

    final private Map<String, HttpCallStatistic> statistics =
        new ConcurrentHashMap<String, HttpCallStatistic>();
    final private Map<String, HttpCallHandlerWrapper> httpCallhandlers =
        new ConcurrentHashMap<String, HttpCallHandlerWrapper>();
    private final List<BeforeAsyncJsonPostInterceptor> interceptors =
        new ArrayList<BeforeAsyncJsonPostInterceptor>();

    final private Map<String, AsyncHttpWrapper> wrappers =
        new ConcurrentHashMap<String, AsyncHttpWrapper>();
    final private Map<String, String> notifiedFailureHttpTasks =
        Collections.synchronizedMap(new LinkedHashMap<String, String>(
            notifiedFailureHttpTasksSize, 0.9f, true) {
            @Override
            protected boolean removeEldestEntry(Map.Entry eldest) {
                return this.size() > notifiedFailureHttpTasksSize;
            }
        });
}
```

关键字段说明：
- `template` / `asyncRestTemplate`：同步/异步 HTTP 客户端，基于 Spring `RestTemplate` / `AsyncRestTemplate`
- `callbackUrl`：Agent 回调管理节点的 URL（`http://host:port/zstack/callback`）
- `sendCommandUrl`：管理节点接收 Agent 命令的 URL（`http://host:port/zstack/commands`）
- `wrappers`：异步调用上下文，以 `taskUuid` 为 key，Agent 回调时据此找到对应的 `AsyncHttpWrapper`
- `httpCallhandlers`：同步 HTTP 命令处理器注册表，以 `commandPath` 为 key
- `statistics`：HTTP 调用统计（需开启 `PROFILER_HTTP_CALL`）
- `notifiedFailureHttpTasks`：最近 128 条因 `taskUuid` 找不到回调而失败的请求

### 初始化

```java
void init() {
    port = Platform.getManagementNodeServicePort();

    IptablesUtils.insertRuleToFilterTable(
        String.format("-A INPUT -p tcp -m state --state NEW -m tcp --dport %s -j ACCEPT", port));

    if ("AUTO".equals(hostname)) {
        callbackHostName = Platform.getManagementServerIp();
    } else {
        callbackHostName = hostname.trim();
    }

    String url;
    if ("".equals(path) || path == null) {
        url = String.format("http://%s:%s", callbackHostName, port);
    } else {
        url = String.format("http://%s:%s/%s", callbackHostName, port, path);
    }
    UriComponentsBuilder ub = UriComponentsBuilder.fromHttpUrl(url);
    ub.path(RESTConstant.CALLBACK_PATH);
    callbackUrl = ub.build().toUriString();

    ub = UriComponentsBuilder.fromHttpUrl(url);
    baseUrl = ub.build().toUriString();

    ub = UriComponentsBuilder.fromHttpUrl(url);
    ub.path(RESTConstant.COMMAND_CHANNEL_PATH);
    sendCommandUrl = ub.build().toUriString();

    template = RESTFacade.createRestTemplate(
        CoreGlobalProperty.REST_FACADE_READ_TIMEOUT,
        CoreGlobalProperty.REST_FACADE_CONNECT_TIMEOUT);
    asyncRestTemplate = createAsyncRestTemplate(
        CoreGlobalProperty.REST_FACADE_READ_TIMEOUT,
        CoreGlobalProperty.REST_FACADE_CONNECT_TIMEOUT,
        CoreGlobalProperty.REST_FACADE_MAX_PER_ROUTE,
        CoreGlobalProperty.REST_FACADE_MAX_TOTAL);
}
```

### 异步 HTTP 调用

`asyncJson()` 是所有异步调用的核心方法。它通过 `AsyncRestTemplate` 发起非阻塞 HTTP 请求，并注册超时回调和 Agent 回调：

```java
@Override
public void asyncJson(final String url, final String body, Map<String, String> headers,
                      HttpMethod method, final AsyncRESTCallback callback,
                      final TimeUnit unit, final long timeout) {
    synchronized (interceptors) {
        for (BeforeAsyncJsonPostInterceptor ic : interceptors) {
            ic.beforeAsyncJsonPost(url, body, unit, timeout);
        }
    }

    if (unit.toMillis(timeout) <= 1) {
        callback.fail(touterr("url: %s, current timeout: %s, api message timeout, skip post async call",
                url, unit.toMillis(timeout)));
        return;
    }

    final String taskUuid = Platform.getUuid();

    HttpHeaders requestHeaders = new HttpHeaders();
    requestHeaders.setContentLength(body.length());
    requestHeaders.set(RESTConstant.TASK_UUID, taskUuid);
    requestHeaders.set(RESTConstant.CALLBACK_URL, callbackUrl);
    requestHeaders.setContentType(MediaType.parseMediaType("application/json; charset=utf-8"));
    if (headers != null) {
        for (Map.Entry<String, String> e : headers.entrySet()) {
            requestHeaders.set(e.getKey(), e.getValue());
        }
    }

    HttpEntity<String> req = new HttpEntity<String>(body, requestHeaders);

    AsyncHttpWrapper wrapper = new AsyncHttpWrapper() {
        final AtomicBoolean called = new AtomicBoolean(false);
        final AsyncHttpWrapper self = this;
        final TimeoutTaskReceipt timeoutTaskReceipt = thdf.submitTimeoutTask(new Runnable() {
            @Override
            public void run() {
                self.fail(touterr("[Async Http Timeout] url: %s, timeout after %s[%s], command: %s",
                        url, timeout, unit.toString(), body));
            }
        }, unit, timeout);

        final ReturnValueCompletion<HttpEntity<String>> completion =
            new ReturnValueCompletion<HttpEntity<String>>(callback) {
            @Override
            @AsyncThread
            public void success(HttpEntity<String> responseEntity) {
                if (!called.compareAndSet(false, true)) { return; }
                wrappers.remove(taskUuid);
                timeoutTaskReceipt.cancel();
                if (callback instanceof JsonAsyncRESTCallback) {
                    JsonAsyncRESTCallback<Object> jcallback = (JsonAsyncRESTCallback) callback;
                    Object obj = JSONObjectUtil.toObject(responseEntity.getBody(), jcallback.getReturnClass());
                    ErrorCode err = vf.validateErrorByErrorCode(obj);
                    if (err != null) {
                        jcallback.fail(err);
                    } else {
                        jcallback.success(obj);
                    }
                } else {
                    callback.success(responseEntity);
                }
            }

            @Override
            @AsyncThread
            public void fail(ErrorCode err) {
                if (!called.compareAndSet(false, true)) { return; }
                wrappers.remove(taskUuid);
                if (!SysErrors.TIMEOUT.toString().equals(err.getCode())) {
                    timeoutTaskReceipt.cancel();
                }
                callback.fail(err);
            }
        };

        @Override
        public void fail(ErrorCode err) { completion.fail(err); }

        @Override
        public void success(HttpEntity<String> responseEntity) { completion.success(responseEntity); }
    };

    wrappers.put(taskUuid, wrapper);
    ListenableFuture<ResponseEntity<String>> f = asyncRestTemplate.exchange(url, method, req, String.class);
    f.addCallback(rsp -> {}, e -> wrapper.fail(err(SysErrors.HTTP_ERROR, e.getLocalizedMessage())));
}
```

异步调用流程：
1. 生成 `taskUuid`，构建 HTTP 请求头（含 `TASK_UUID` 和 `CALLBACK_URL`）
2. 创建 `AsyncHttpWrapper`，内含超时任务和 `ReturnValueCompletion`
3. 将 wrapper 存入 `wrappers` Map
4. 通过 `AsyncRestTemplate` 发起非阻塞请求
5. Agent 处理完毕后回调 `callbackUrl`，`notifyCallback()` 方法根据 `taskUuid` 找到 wrapper 完成回调
6. 若超时，超时任务触发 `wrapper.fail()`

### Agent 回调处理

```java
void notifyCallback(HttpServletRequest req, HttpServletResponse rsp) {
    String taskUuid = req.getHeader(RESTConstant.TASK_UUID);
    try {
        HttpEntity<String> entity = this.httpServletRequestToHttpEntity(req);
        if (taskUuid == null) {
            rsp.sendError(HttpStatus.SC_BAD_REQUEST, "No 'taskUuid' found in the header");
            return;
        }

        AsyncHttpWrapper wrapper = wrappers.get(taskUuid);
        if (wrapper == null) {
            rsp.sendError(HttpStatus.SC_NOT_FOUND,
                String.format("No callback found for taskUuid[%s]", taskUuid));
            notifiedFailureHttpTasks.put(taskUuid, entity.getBody());
            return;
        }

        rsp.setStatus(HttpStatus.SC_OK);
        wrapper.success(entity);
    } catch (IOException e) {
        logger.warn(e.getMessage(), e);
    } catch (Throwable t) {
        try {
            rsp.sendError(HttpStatus.SC_INTERNAL_SERVER_ERROR, t.getMessage());
        } catch (IOException e) {
            logger.warn(e.getMessage(), e);
        }
    }
}
```

### 同步 HTTP 调用

```java
@Override
public <T> T syncJsonPost(String url, String body, Map<String, String> headers,
                          Class<T> returnClass, TimeUnit unit, long timeout) {
    return syncJson(url, body, headers, HttpMethod.POST, returnClass, unit, timeout);
}

protected <T> T syncJson(String url, String body, Map<String, String> headers,
                         HttpMethod method, Class<T> returnClass,
                         TimeUnit unit, long timeout) {
    body = body == null ? "" : body;

    HttpHeaders requestHeaders = new HttpHeaders();
    if (headers != null) {
        requestHeaders.setAll(headers);
    }
    requestHeaders.setContentType(MediaType.APPLICATION_JSON);
    requestHeaders.setContentLength(body.length());
    HttpEntity<String> req = new HttpEntity<String>(body, requestHeaders);
    ResponseEntity<String> rsp = syncRawJson(url, req, method, unit, timeout);

    if (rsp.getBody() != null && returnClass != Void.class) {
        return JSONObjectUtil.toObject(rsp.getBody(), returnClass);
    } else {
        return null;
    }
}
```

同步调用内置 `Retry` 机制，在非单元测试环境下对 `ResourceAccessException` 和 `HttpStatusCodeException` 自动重试。

### echo —— 等待 Agent 就绪

```java
@Override
public void echo(final String url, final Completion completion,
                 final long interval, long timeout) {
    long expired = System.currentTimeMillis() + timeout;
    long finalTimeout = timeout;
    thdf.submitCancelablePeriodicTask(new CancelablePeriodicTask(completion) {
        @Override
        public boolean run() {
            try {
                syncJsonPost(url, "", Void.class, TimeUnit.SECONDS, 2);
                completion.success();
                return true;
            } catch (Throwable t) {
                long now = System.currentTimeMillis();
                if (now > expired) {
                    completion.fail(operr("unable to echo %s in %sms", url, finalTimeout));
                    return true;
                }
            }
            return false;
        }

        @Override
        public TimeUnit getTimeUnit() { return TimeUnit.MILLISECONDS; }

        @Override
        public long getInterval() { return interval; }

        @Override
        public String getName() { return "RESTFacade echo"; }
    });
}
```

`echo()` 以周期性任务反复向 Agent 发送 POST 请求，直到成功或超时。管理节点在连接 Agent 时使用此方法等待 Agent 就绪。

### TimeoutRestTemplate

ZStack 自定义了 `TimeoutRestTemplate`，支持连接超时和读取超时：

```java
static TimeoutRestTemplate createRestTemplate(int readTimeout, int connectTimeout) {
    HttpComponentsClientHttpRequestFactory factory = new TimeoutHttpComponentsClientHttpRequestFactory();
    factory.setReadTimeout(readTimeout);
    factory.setConnectTimeout(connectTimeout);
    factory.setConnectionRequestTimeout(connectTimeout * 2);

    SSLContext sslContext = DefaultSSLVerifier.getSSLContext(DefaultSSLVerifier.trustAllCerts);
    if (sslContext != null) {
        factory.setHttpClient(HttpClients.custom()
                .setSSLHostnameVerifier(new NoopHostnameVerifier())
                .setSSLContext(sslContext)
                .build());
    }

    TimeoutRestTemplate template = new TimeoutRestTemplate(factory);
    setMessageConverter(template.getMessageConverters());
    return template;
}
```

## RESTApiFacade —— 异步 API 状态管理

> 源码位置：zstack/core/src/main/java/org/zstack/core/rest/RESTApiFacadeImpl.java

`RESTApiFacade` 负责**异步 API 调用的状态持久化与结果查询**。它将 `APIMessage` 持久化到 `RestAPIVO` 表，监听 `APIEvent` 更新结果，并提供查询接口。这是旧版 REST API 的异步查询机制，新版由 `RestServer` 中的 `AsyncRestApiStore` 替代。

### 接口定义

> 源码位置：zstack/header/src/main/java/org/zstack/header/rest/RESTApiFacade.java

```java
public interface RESTApiFacade {
    RestAPIResponse send(APIMessage msg);
    RestAPIResponse call(APIMessage msg);
    RestAPIResponse getResult(String uuid);
}
```

### 核心实现

```java
public class RESTApiFacadeImpl extends AbstractService
        implements RESTApiFacade, CloudBusEventListener, Component {

    private EntityManagerFactory entityManagerFactory;
    private Set<String> basePkgNames;
    private List<String> processingRequests =
        Collections.synchronizedList(new ArrayList<String>(100));
    private Future<Void> restAPIVOCleanTask = null;

    @Autowired
    private ResourceDestinationMaker destMaker;
    @Autowired
    private CloudBus bus;
    @Autowired
    private ThreadFacade thdf;

    @Override
    public RestAPIResponse send(APIMessage msg) {
        assert !(msg instanceof APIListMessage) && !(msg instanceof APISearchMessage);
        RestAPIVO vo = persist(msg);
        processingRequests.add(vo.getUuid());
        RestAPIResponse rsp = new RestAPIResponse();
        rsp.setCreatedDate(vo.getCreateDate());
        rsp.setState(vo.getState().toString());
        rsp.setUuid(vo.getUuid());
        msg.setServiceId(ApiMediatorConstant.SERVICE_ID);
        bus.send(msg);
        return rsp;
    }

    @Override
    public RestAPIResponse call(APIMessage msg) {
        RestAPIResponse rsp = new RestAPIResponse();
        rsp.setCreatedDate(new Date());
        msg.setServiceId(ApiMediatorConstant.SERVICE_ID);
        MessageReply reply = bus.call(msg);
        rsp.setFinishedDate(new Date());
        rsp.setState(RestAPIState.Done.toString());
        rsp.setResult(RESTApiDecoder.dump(reply));
        return rsp;
    }

    @Override
    public RestAPIResponse getResult(String uuid) {
        RestAPIVO vo = find(uuid);
        if (vo == null) { return null; }
        RestAPIResponse rsp = new RestAPIResponse();
        rsp.setCreatedDate(vo.getCreateDate());
        rsp.setFinishedDate(vo.getLastOpDate());
        rsp.setResult(vo.getResult());
        rsp.setState(vo.getState().toString());
        rsp.setUuid(vo.getUuid());
        return rsp;
    }
}
```

关键流程：
- `send()`：异步调用。将 `APIMessage` 持久化为 `RestAPIVO`（状态为 `Processing`），通过 CloudBus 发送消息，立即返回 `uuid` 供后续查询
- `call()`：同步调用。通过 `bus.call()` 阻塞等待结果，直接返回
- `getResult()`：根据 `uuid` 查询 `RestAPIVO` 获取异步调用的结果
- `handleEvent()`：监听 `APIEvent`，当收到事件时更新 `RestAPIVO` 的状态和结果

### RESTApiDecoder —— 消息序列化

> 源码位置：zstack/core/src/main/java/org/zstack/core/rest/RESTApiDecoder.java

`RESTApiDecoder` 负责将 `Message` 对象与 JSON 互转，使用自定义的 Gson 编解码器，以消息类全限定名为 key 包装 JSON：

```java
public class RESTApiDecoder {
    public static Message loads(String jsonStr) {
        Message msg = self.gsonDecoder.fromJson(jsonStr, Message.class);
        return msg;
    }

    public static String dump(Message msg) {
        return self.gsonEncoder.toJson(msg, Message.class);
    }
}
```

序列化格式示例：`{"org.zstack.kvm.APIAddKvmHostEvent": {...}}`

## RestServer —— HTTP 请求路由与处理

> 源码位置：zstack/rest/src/main/java/org/zstack/rest/RestServer.java

`RestServer` 是 ZStack 新版 REST API 的核心，负责**入站 HTTP 请求的路由和处理**。它实现 `Component` 和 `CloudBusEventListener` 接口，在 `start()` 时扫描所有 `@RestRequest` 注解，构建路径到 API 类的映射。

### 扫描 @RestRequest 注解

```java
private void build() {
    Reflections reflections = Platform.getReflections();
    Set<Class<?>> classes = reflections.getTypesAnnotatedWith(RestRequest.class)
            .stream().filter(it -> it.isAnnotationPresent(RestRequest.class))
            .collect(Collectors.toSet());

    for (Class clz : classes) {
        RestRequest at = (RestRequest) clz.getAnnotation(RestRequest.class);
        Api api = new Api(clz, at);

        List<String> paths = new ArrayList<>();
        if (!"null".equals(api.path)) {
            paths.add(api.path);
        }
        paths.addAll(api.optionalPaths);

        for (String path : paths) {
            String normalizedPath = normalizePath(path);
            api = new Api(clz, at);
            api.path = path;

            if (!apis.containsKey(normalizedPath)) {
                apis.put(normalizedPath, api);
            } else {
                Object c = apis.get(normalizedPath);
                List lst;
                if (c instanceof Api) {
                    lst = new ArrayList();
                    lst.add(c);
                    apis.put(normalizedPath, lst);
                } else {
                    lst = (List) c;
                }
                lst.add(api);
            }
        }

        responseAnnotationByClass.put(api.apiResponseClass,
            new RestResponseWrapper(api.responseAnnotation, api.apiResponseClass));
    }
}
```

`build()` 方法将所有 `@RestRequest` 注解的类解析为 `Api` 对象，存入 `apis` Map。同一路径可能对应多个 API（如 POST 创建 + GET 查询 + DELETE 删除），此时以 `Collection<Api>` 存储。

### HTTP 请求处理

```java
void handle(HttpServletRequest req, HttpServletResponse rsp) throws IOException, ... {
    RequestInfo info = new RequestInfo(req);

    if (rateLimiter.isRateLimitExceeded(info.clientIp)) {
        sendResponse(HttpStatus.TOO_MANY_REQUESTS.value(), "Rate limit exceeded", rsp);
        return;
    }

    requestInfo.set(info);
    String path = getDecodedUrl(req);
    HttpEntity<String> entity = toHttpEntity(req);

    if (matcher.match(ASYNC_JOB_PATH_PATTERN, path)) {
        handleJobQuery(req, rsp);
        return;
    }

    Object api = apis.get(getMatchPath(path));
    if (api == null) {
        sendResponse(HttpStatus.NOT_FOUND.value(),
            String.format("no api mapping to %s", path), rsp);
        return;
    }

    try {
        if (api instanceof Api) {
            handleUniqueApi((Api) api, entity, req, rsp);
        } else {
            handleNonUniqueApi((Collection) api, entity, req, rsp);
        }
    } catch (RestException e) {
        sendResponse(e.statusCode, e.error, rsp);
    }
}
```

### 消息发送

```java
private void sendMessage(APIMessage msg, Api api, HttpServletResponse rsp) throws ... {
    if (msg instanceof APISyncCallMessage) {
        MessageReply reply = bus.call(msg);
        sendReplyResponse(reply, api, rsp);
    } else {
        RequestData d = new RequestData();
        d.apiMessage = msg;
        d.requestInfo = requestInfo.get();
        List<String> webHook = requestInfo.get().headers.get(RestConstants.HEADER_WEBHOOK);
        if (webHook != null && !webHook.isEmpty()) {
            d.webHook = webHook.get(0);
        }

        asyncStore.save(d);
        UriComponentsBuilder ub = UriComponentsBuilder.fromHttpUrl(restf.getBaseUrl());
        ub.path(RestConstants.API_VERSION);
        ub.path(RestConstants.ASYNC_JOB_PATH);
        ub.path("/" + msg.getId());

        ApiResponse response = new ApiResponse();
        response.setLocation(ub.build().toUriString());
        response.setApiTimeout(timeoutMgr.getMessageTimeout(msg));

        bus.send(msg);

        sendResponse(HttpStatus.ACCEPTED.value(), response, rsp);
    }
}
```

同步 API（`APISyncCallMessage`）通过 `bus.call()` 阻塞等待结果；异步 API 通过 `bus.send()` 发送消息，将请求信息存入 `AsyncRestApiStore`，返回 HTTP 202（Accepted）和轮询 URL。

## API 消息类型体系

ZStack 的 API 消息形成了一个完整的类型层次：

```
Message
├── APIMessage                    // 所有 API 消息的基类
│   ├── APISyncCallMessage        // 同步调用 API（等待返回）
│   │   └── APIReply              // 同步调用响应
│   ├── APISearchMessage          // 搜索 API
│   │   └── APISearchReply        // 搜索响应
│   └── (其他异步 API)             // 异步 API，通过 APIEvent 返回
├── NeedReplyMessage              // 需要回复的消息
│   └── MessageReply              // 回复消息
└── Event
    └── APIEvent                  // API 异步事件响应
```

### 同步 vs 异步 API

```java
// 同步 API：调用后阻塞等待结果
APIReply reply = (APIReply) bus.call(new APISyncCallMessage());

// 异步 API：调用后立即返回，通过 APIEvent 接收结果
bus.send(apiMsg, (APIEvent evt) -> {
    // 处理异步结果
});
```

大多数 ZStack API 是异步的。同步 API 主要用于查询类操作（如 `APIQueryXxxMsg`）。

## API 拦截器

ZStack 提供了 API 拦截器机制，在消息到达 Service 之前进行预处理：

### ApiMessageInterceptor

> 源码位置：zstack/header/src/main/java/org/zstack/header/apimediator/ApiMessageInterceptor.java

```java
public interface ApiMessageInterceptor {
    APIMessage intercept(APIMessage msg) throws ApiMessageInterceptionException;

    default int getPriority() {
        return 0;
    }
}
```

### GlobalApiMessageInterceptor

> 源码位置：zstack/header/src/main/java/org/zstack/header/apimediator/GlobalApiMessageInterceptor.java

```java
public interface GlobalApiMessageInterceptor extends ApiMessageInterceptor {
    enum InterceptorPosition {
        SYSTEM, FRONT, DEFAULT, END
    }

    List<Class> getMessageClassToIntercept();

    default InterceptorPosition getPosition() {
        return InterceptorPosition.FRONT;
    }
}
```

`GlobalApiMessageInterceptor` 扩展了 `ApiMessageInterceptor`，增加了拦截位置（`SYSTEM` → `FRONT` → `DEFAULT` → `END`）和关注的消息类型列表。

### 典型拦截器：KVMApiInterceptor

> 源码位置：zstack/plugin/kvm/src/main/java/org/zstack/kvm/KVMApiInterceptor.java

```java
public class KVMApiInterceptor implements ApiMessageInterceptor {
    @Override
    public APIMessage intercept(APIMessage msg) throws ApiMessageInterceptionException {
        if (msg instanceof APIAddKvmHostMsg) {
            validateAddKvmHost((APIAddKvmHostMsg) msg);
        } else if (msg instanceof APIReconnectKvmHostMsg) {
            validateReconnectKvmHost((APIReconnectKvmHostMsg) msg);
        }
        return msg;
    }

    private void validateAddKvmHost(APIAddKvmHostMsg msg) {
        if (msg.getHostIp() == null) {
            throw new ApiMessageInterceptionException(
                argerr("hostIp cannot be null"));
        }
    }
}
```

## Spring XML 配置

> 源码位置：zstack/conf/springConfigXml/RESTFacade.xml

```xml
<bean id="RESTFacade" class="org.zstack.core.rest.RESTFacadeImpl">
    <property name="hostname" value="${RESTFacade.hostname:AUTO}" />
    <property name="port" value="${RESTFacade.port:8080}" />
    <property name="path" value="${RESTFacade.path:zstack}" />
</bean>

<bean id="RESTApiFacade" class="org.zstack.core.rest.RESTApiFacadeImpl">
    <property name="entityManagerFactory" ref="RESTApiEntityManagerFactory" />
    <zstack:plugin>
        <zstack:extension interface="org.zstack.header.Component" />
        <zstack:extension interface="org.zstack.header.Service" />
    </zstack:plugin>
</bean>
```

注意：
- `RESTFacade` bean **没有** `<zstack:plugin>` 扩展，它不实现 `Component` 接口，仅通过 Spring `init-method` 初始化
- `RESTApiFacade` bean 有 `<zstack:plugin>` 扩展，注册了 `Component` 和 `Service` 接口
- `RESTApiFacade` 还配置了独立的 JPA `EntityManagerFactory` 和数据源（`RESTApiDataSource`），用于持久化 `RestAPIVO`

## 设计总结

| 设计决策 | 实现方式 | 优势 |
|---------|---------|------|
| 出站/入站分离 | `RESTFacade`（客户端）vs `RestServer`（服务端） | 职责清晰，避免混淆 |
| 注解驱动 API | `@RestRequest` + `@APIParam` | 声明式，减少样板代码 |
| 异步回调机制 | `taskUuid` + `callbackUrl` + `wrappers` Map | Agent 异步处理完成后可靠回调 |
| XML 消息路由 | `serviceConfig` 目录下 62 个 XML | 解耦消息定义与路由配置 |
| 同步/异步分离 | `APISyncCallMessage` vs `APIEvent` | 查询类同步，操作类异步 |
| 拦截器链 | `ApiMessageInterceptor` + `GlobalApiMessageInterceptor` | 可扩展的请求预处理 |
| 自动查询 | `@AutoQuery` 注解 | 常见查询 API 零代码生成 |
| API 状态持久化 | `RESTApiFacade` + `RestAPIVO` | 异步 API 结果可轮询查询 |
