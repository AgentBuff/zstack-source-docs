# 21 - 身份与权限

ZStack 的身份与权限模块（identity）负责账户管理、会话管理、权限控制和 RBAC（基于角色的访问控制）。该模块位于 `zstack/identity/` 目录下，是整个平台的安全基础。

## 模块结构

```
zstack/identity/src/main/java/org/zstack/identity/
├── AccountManagerImpl.java      # 账户管理器（核心）
├── AccountBase.java             # 账户实例
├── Session.java                 # 会话管理
├── AuthorizationManager.java    # 授权拦截器
├── rbac/                        # RBAC 子模块
│   ├── RBACManagerImpl.java     # RBAC 管理器
│   ├── PolicyUtils.java         # 策略工具类
│   └── ...                      # 其他 RBAC 相关类
└── ...                          # 其他身份相关类
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/

## 核心类一览

| 类名 | 行数 | 职责 |
|------|------|------|
| AccountManagerImpl | 1793 | 账户/用户/用户组/策略管理，API 拦截验证 |
| AccountBase | 860 | 账户实例，处理账户级操作消息 |
| Session | 429 | 会话管理，Token 缓存与超时 |
| AuthorizationManager | 160 | 全局 API 授权拦截器 |
| RBACManagerImpl | 261 | 角色管理，预定义角色，权限检查 |

## AccountManagerImpl

### 类定义与接口

AccountManagerImpl 是身份模块的核心，实现了大量接口：

```java
public class AccountManagerImpl extends AbstractService implements AccountManager,
        SoftDeleteEntityExtensionPoint,
        HardDeleteEntityExtensionPoint,
        ApiMessageInterceptor,           // API 消息拦截器
        RestAuthenticationBackend,       // REST 认证后端
        PrepareDbInitialValueExtensionPoint {
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java

关键职责：
- **ApiMessageInterceptor**：拦截所有 API 消息，进行参数验证和权限检查
- **RestAuthenticationBackend**：处理 REST API 的 Session 认证
- **SoftDeleteEntityExtensionPoint / HardDeleteEntityExtensionPoint**：实体软删除和硬删除扩展
- **PrepareDbInitialValueExtensionPoint**：数据库初始值准备

### 账户模型

ZStack 的身份模型采用三层结构：

```
Account（账户）
├── User（用户）—— 可登录的实体
├── UserGroup（用户组）—— 用户的分组
└── Policy（策略）—— 权限策略
    └── PolicyStatement（策略声明）
        ├── effect: Allow / Deny
        └── actions: API 名称模式匹配
```

账户类型：

```java
public enum AccountType {
    SystemAdmin,   // 系统管理员
    Normal,        // 普通账户
    ThirdParty     // 第三方账户
}
```

系统内置管理员账户 UUID 为 `AccountConstant.INITIAL_SYSTEM_ADMIN_UUID`。

### API 消息拦截

AccountManagerImpl 实现了 `ApiMessageInterceptor` 接口，其 `intercept()` 方法在所有 API 消息处理前被调用：

```java
@Override
public APIMessage intercept(APIMessage msg) throws ApiMessageInterceptionException {
    if (msg instanceof APIUpdateAccountMsg) {
        validate((APIUpdateAccountMsg) msg);
    } else if (msg instanceof APICreatePolicyMsg) {
        validate((APICreatePolicyMsg) msg);
    } else if (msg instanceof APIAddUserToGroupMsg) {
        validate((APIAddUserToGroupMsg) msg);
    } else if (msg instanceof APIAttachPolicyToUserGroupMsg) {
        validate((APIAttachPolicyToUserGroupMsg) msg);
    } else if (msg instanceof APIAttachPolicyToUserMsg) {
        validate((APIAttachPolicyToUserMsg) msg);
    } else if (msg instanceof APIShareResourceMsg) {
        validate((APIShareResourceMsg) msg);
    } else if (msg instanceof APIRevokeResourceSharingMsg) {
        validate((APIRevokeResourceSharingMsg) msg);
    } else if (msg instanceof APIDeleteAccountMsg) {
        validate((APIDeleteAccountMsg) msg);
    } else if (msg instanceof APICreateAccountMsg) {
        validate((APICreateAccountMsg) msg);
    } else if (msg instanceof APICreateUserMsg) {
        validate((APICreateUserMsg) msg);
    } else if (msg instanceof APILogInByUserMsg) {
        validate((APILogInByUserMsg) msg);
    } else if (msg instanceof APIUpdateQuotaMsg) {
        validate((APIUpdateQuotaMsg) msg);
    }
    // ... 更多验证

    setServiceId(msg);  // 设置消息路由目标
    return msg;
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1454

验证逻辑示例 — 删除账户：

```java
private void validate(APIDeleteAccountMsg msg) {
    if (new QuotaUtil().isAdminAccount(msg.getUuid())) {
        if (msg.getAccountUuid().equals(msg.getSession().getAccountUuid())) {
            throw new ApiMessageInterceptionException(argerr("account cannot delete itself"));
        }
        if (msg.getAccountUuid().equals(AccountConstant.INITIAL_SYSTEM_ADMIN_UUID)) {
            throw new ApiMessageInterceptionException(argerr("cannot delete builtin admin account."));
        }
    }
    if (!new QuotaUtil().isAdminAccount(msg.getSession().getAccountUuid())) {
        throw new ApiMessageInterceptionException(argerr("Only admin can delete account."));
    }
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1540

验证逻辑示例 — 创建策略：

```java
private void validate(APICreatePolicyMsg msg) {
    boolean sessionAccessToAdminActions = new CheckIfSessionCanOperationAdminPermission().check(msg.getSession());

    for (PolicyStatement s : msg.getStatements()) {
        if (s.getEffect() == null) {
            throw new ApiMessageInterceptionException(argerr("a statement must have effect field"));
        }
        if (s.getActions() == null || s.getActions().isEmpty()) {
            throw new ApiMessageInterceptionException(argerr("a statement must have a non-empty action field"));
        }

        if (sessionAccessToAdminActions) {
            continue;  // 管理员可以创建任何策略
        }

        // 普通账户不能创建包含 admin-only action 的策略
        s.getActions().forEach(as -> {
            if (PolicyUtils.isAdminOnlyAction(as)) {
                throw new OperationFailureException(err(IdentityErrors.PERMISSION_DENIED,
                        "normal accounts can't create admin-only action polices[%s]", as));
            }
        });
    }
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1666

### REST 认证

AccountManagerImpl 实现了 `RestAuthenticationBackend`，处理 REST API 的 Session 认证：

```java
@Override
public RestAuthenticationType getAuthenticationType() {
    return ACCOUNT_REST_AUTHENTICATION_TYPE;
}

@Override
public SessionInventory doAuth(RestAuthenticationParams params) {
    SessionVO vo = Q.New(SessionVO.class).eq(SessionVO_.uuid, params.authKey).find();
    if (vo != null) {
        return SessionInventory.valueOf(vo);
    }

    // 无效 session 错误将在 ApiMessageProcessorImpl 中抛出
    SessionInventory session = new SessionInventory();
    session.setUuid(params.authKey);
    return session;
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1782

### 消息路由

`setServiceId()` 方法为所有实现了 `AccountMessage` 接口的 API 消息设置路由目标：

```java
private void setServiceId(APIMessage msg) {
    if (msg instanceof AccountMessage) {
        AccountMessage amsg = (AccountMessage) msg;
        bus.makeTargetServiceIdByResourceUuid(msg, AccountConstant.SERVICE_ID, amsg.getAccountUuid());
    }
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1765

## AccountBase

AccountBase 是账户实例，处理账户级别的操作消息。它使用 `@Configurable` 注解支持 Spring 依赖注入：

```java
@Configurable(preConstruction = true, autowire = Autowire.BY_TYPE, dependencyCheck = true)
public class AccountBase extends AbstractAccount {
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountBase.java

### 账户删除

账户删除使用 CascadeFacade 进行级联删除，然后清理关联资源：

```java
private void deleteAccount(Completion completion) {
    final String issuer = AccountVO.class.getSimpleName();
    final List<AccountInventory> ctx = list(AccountInventory.valueOf(self));
    List<String> resourceUuids = Q.New(AccountResourceRefVO.class)
                                    .select(AccountResourceRefVO_.resourceUuid)
                                    .eq(AccountResourceRefVO_.ownerAccountUuid, self.getUuid())
                                    .listValues();

    final FlowChain chain = FlowChainBuilder.newShareFlowChain();
    chain.setName(String.format("delete-account-%s", self.getUuid()));
    chain.then(new ShareFlow() {
        @Override
        public void setup() {
            flow(new NoRollbackFlow() {
                String __name__ = "delete";

                @Override
                public void run(final FlowTrigger trigger, Map data) {
                    casf.asyncCascade(CascadeConstant.DELETION_DELETE_CODE, issuer, ctx, new Completion(trigger) {
                        @Override
                        public void success() {
                            trigger.next();
                        }

                        @Override
                        public void fail(ErrorCode errorCode) {
                            trigger.fail(errorCode);
                        }
                    });
                }
            });

            done(new FlowDoneHandler(completion) {
                @Override
                public void handle(Map data) {
                    dbf.remove(self);
                    acntMgr.adminAdoptAllOrphanedResource(resourceUuids, self.getUuid());

                    AccountDeletedData evtData = new AccountDeletedData();
                    evtData.setAccountUuid(self.getUuid());
                    evtData.setInventory(AccountInventory.valueOf(self));
                    evtf.fire(IdentityCanonicalEvents.ACCOUNT_DELETED_PATH, evtData);

                    completion.success();
                }
            });
        }
    }).start();
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountBase.java:162

删除流程：
1. 通过 CascadeFacade 级联删除账户下的所有资源
2. 删除账户 VO 记录
3. 管理员收养所有孤儿资源（`adminAdoptAllOrphanedResource`）
4. 触发 `ACCOUNT_DELETED` 事件

### 关联资源清理

`deleteRelatedResources()` 方法在级联删除的回调中被调用，清理账户下的用户、用户组、策略等：

```java
private void deleteRelatedResources() {
    new SQLBatch() {
        @Override
        protected void scripts() {
            sql(QuotaVO.class)
                    .eq(QuotaVO_.identityType, AccountVO.class.getSimpleName())
                    .eq(QuotaVO_.identityUuid, self.getUuid())
                    .delete();

            sql(UserVO.class)
                    .eq(UserVO_.accountUuid, self.getUuid())
                    .delete();

            sql(UserGroupVO.class)
                    .eq(UserGroupVO_.accountUuid, self.getUuid())
                    .delete();

            sql(PolicyVO.class)
                    .eq(PolicyVO_.accountUuid, self.getUuid())
                    .delete();

            sql("delete from SharedResourceVO s where s.ownerAccountUuid = :uuid or s.receiverAccountUuid = :uuid")
                    .param("uuid", self.getUuid())
                    .execute();

            // 删除角色和角色策略声明
            List<String> resourceUuids = q(AccountResourceRefVO.class)
                    .select(AccountResourceRefVO_.resourceUuid)
                    .eq(AccountResourceRefVO_.accountUuid, self.getUuid())
                    .eq(AccountResourceRefVO_.resourceType, RoleVO.class.getSimpleName())
                    .listValues();

            if (!resourceUuids.isEmpty()) {
                sql(RolePolicyStatementVO.class)
                        .in(RolePolicyStatementVO_.roleUuid, resourceUuids)
                        .delete();

                sql(RoleVO.class)
                        .in(RoleVO_.uuid, resourceUuids)
                        .delete();
            }
        }
    }.execute();
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountBase.java:240

## Session

### 类定义

Session 是一个 Component（不是 Manager），负责会话的创建、查询和超时管理：

```java
public class Session implements Component {
    private static final CLogger logger = Utils.getLogger(Session.class);
    private static final Map<String, SessionInventory> sessions = new ConcurrentHashMap<>();
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/Session.java

关键设计：
- 使用 `ConcurrentHashMap` 作为内存缓存，避免每次查数据库
- Session 数据同时存储在内存和数据库（SessionVO）中
- 支持定期清理过期会话

### 会话创建

```java
public static SessionInventory login(String accountUuid, String userUuid) {
    return new SQLBatchWithReturn<SessionInventory>() {
        @Override
        protected SessionInventory scripts() {
            SessionInventory session = new SessionInventory();
            session.setUuid(Platform.getUuid());
            session.setAccountUuid(accountUuid);
            session.setUserUuid(userUuid);

            SessionVO vo = new SessionVO();
            vo.setUuid(session.getUuid());
            vo.setAccountUuid(accountUuid);
            vo.setUserUuid(userUuid);
            long expiredTime = getCurrentSqlDate().getTime()
                + TimeUnit.SECONDS.toMillis(IdentityGlobalConfig.SESSION_TIMEOUT.value(Long.class));
            vo.setExpiredDate(new Timestamp(expiredTime));
            persist(vo);

            sessions.put(session.getUuid(), session);
            return session;
        }
    }.execute();
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/Session.java:53

会话创建流程：
1. 生成 UUID 作为 Session ID
2. 创建 SessionInventory 和 SessionVO
3. 计算过期时间（内联计算，使用 `IdentityGlobalConfig.SESSION_TIMEOUT`）
4. 持久化到数据库
5. 放入内存缓存

### 会话查询

```java
public static SessionInventory getSession(String sessionUuid) {
    SessionInventory session = sessions.get(sessionUuid);
    if (session != null) {
        return session;
    }

    // 内存未命中，查数据库
    SessionVO vo = dbf.findByUuid(sessionUuid, SessionVO.class);
    if (vo == null) {
        return null;
    }

    session = SessionInventory.valueOf(vo);
    sessions.put(sessionUuid, session);
    return session;
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/Session.java

查询策略：先查内存缓存，未命中再查数据库，查到后回填缓存。

### 会话超时

会话超时时间通过 GlobalConfig 配置，在 `login()` 方法中内联计算：

```java
long expiredTime = getCurrentSqlDate().getTime()
    + TimeUnit.SECONDS.toMillis(IdentityGlobalConfig.SESSION_TIMEOUT.value(Long.class));
vo.setExpiredDate(new Timestamp(expiredTime));
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/Session.java:93

在 AccountManagerImpl 的 `Auth` 内部类中，每次 API 调用都会检查会话是否过期：

```java
private void sessionCheck() {
    if (msg.getSession() == null) {
        throw new ApiMessageInterceptionException(err(IdentityErrors.INVALID_SESSION,
                "session of message[%s] is null", msg.getMessageName()));
    }

    if (msg.getSession().getUuid() == null) {
        throw new ApiMessageInterceptionException(err(IdentityErrors.INVALID_SESSION,
                "session uuid is null"));
    }

    SessionInventory session = Session.getSession(msg.getSession().getUuid());
    if (session == null) {
        throw new ApiMessageInterceptionException(err(IdentityErrors.INVALID_SESSION,
                "Session expired"));
    }

    Timestamp curr = getCurrentSqlDate();
    if (curr.after(session.getExpiredDate())) {
        logger.debug(String.format("session expired[%s < %s] for account[uuid:%s]", curr,
                session.getExpiredDate(), session.getAccountUuid()));
        logOutSession(session.getUuid());
        throw new ApiMessageInterceptionException(err(IdentityErrors.INVALID_SESSION, "Session expired"));
    }

    this.session = session;
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1424

### 会话清理

Session 组件启动时会注册定期清理任务，删除过期的 SessionVO 记录：

```java
@Override
public boolean start() {
    // 注册定期清理任务
    thdf.submitPeriodicTask(new PeriodicTask() {
        @Override
        public TimeUnit getTimeUnit() {
            return TimeUnit.SECONDS;
        }

        @Override
        public long getInterval() {
            return IdentityGlobalConfig.SESSION_CLEANUP_INTERVAL.value(Long.class);
        }

        @Override
        public String getName() {
            return "session-cleanup-task";
        }

        @Override
        public void run() {
            // 删除过期的 SessionVO
            // ...
        }
    });
    return true;
}
```

## AuthorizationManager

### 全局 API 拦截

AuthorizationManager 是一个 `GlobalApiMessageInterceptor`，拦截所有 API 消息进行授权检查：

```java
public class AuthorizationManager implements GlobalApiMessageInterceptor, Component, ZQLQueryExtensionPoint {
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AuthorizationManager.java

核心方法：

```java
@Override
public List<Class> getMessageClassToIntercept() {
    return null;  // 拦截所有 APIMessage
}

@Override
public InterceptorPosition getPosition() {
    return InterceptorPosition.FRONT;  // 在所有其他拦截器之前执行
}

@Override
public APIMessage intercept(APIMessage msg) throws ApiMessageInterceptionException {
    // 1. 检查 Session
    // 2. 查找 AuthorizationBackend
    // 3. 调用 backend.authorize()
    // ...
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AuthorizationManager.java

AuthorizationManager 的拦截位置是 `FRONT`，意味着它在所有其他拦截器（包括 AccountManagerImpl 的参数验证）之前执行，确保授权检查最先进行。

### 授权流程

AuthorizationManager 的授权流程：

1. **Session 检查**：验证 Session 是否有效
2. **查找 Backend**：根据消息类型查找对应的 `AuthorizationBackend`
3. **执行授权**：调用 `backend.authorize()` 进行权限检查

AuthorizationBackend 是一个扩展接口，不同模块可以实现自己的授权逻辑。

## RBAC 模型

### 数据模型

ZStack 的 RBAC 模型基于 Role（角色）：

```
Account
├── Role（角色）
│   ├── RolePolicyStatementVO（角色策略声明）
│   └── RolePolicyRefVO（角色-策略引用）
├── User → Role（用户-角色绑定）
└── UserGroup → Role（用户组-角色绑定）
```

角色类型：

```java
public enum RoleType {
    System,              // 系统角色
    Customized,          // 自定义角色
    Predefined,          // 预定义角色
    CreatedBySystem,     // 系统创建
    PredefinedBySystem   // 系统预定义
}
```

### RBACManagerImpl

RBACManagerImpl 负责角色管理和权限检查：

```java
public class RBACManagerImpl extends AbstractService implements RBACManager,
        Component, IdentityResourceGenerateExtensionPoint {
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/rbac/RBACManagerImpl.java:34

#### 预定义角色

RBACManagerImpl 实现了 `IdentityResourceGenerateExtensionPoint`，在系统初始化时创建预定义角色：

```java
@Override
public void prepareResources() {
    new SQLBatch() {
        @Override
        protected void scripts() {
            RBAC.roles.stream().filter(RBAC.Role::isPredefine).forEach(role -> {
                if (!q(SystemRoleVO.class).eq(SystemRoleVO_.uuid, role.getUuid()).isExists()) {
                    SystemRoleVO rvo = new SystemRoleVO();
                    rvo.setUuid(role.getUuid());
                    rvo.setName(String.format("predefined: %s", role.getName()));
                    rvo.setSystemRoleType(role.isAdminOnly() ? SystemRoleType.Admin : SystemRoleType.Normal);
                    rvo.setType(RoleType.Predefined);
                    rvo.setAccountUuid(AccountConstant.INITIAL_SYSTEM_ADMIN_UUID);
                    persist(rvo);

                    // 共享角色给所有账户
                    SharedResourceVO sh = new SharedResourceVO();
                    sh.setOwnerAccountUuid(rvo.getAccountUuid());
                    sh.setResourceType(RoleVO.class.getSimpleName());
                    sh.setResourceUuid(rvo.getUuid());
                    sh.setToPublic(true);
                    persist(sh);

                    // 创建策略声明
                    role.toStatements().forEach(s -> {
                        RolePolicyStatementVO rp = new RolePolicyStatementVO();
                        rp.setRoleUuid(rvo.getUuid());
                        rp.setUuid(Platform.getUuid());
                        rp.setStatement(JSONObjectUtil.toJsonString(s));
                        persist(rp);
                    });
                } else {
                    // 更新已有角色的策略声明
                    role.toStatements().forEach(s -> {
                        String statementString = JSONObjectUtil.toJsonString(s);
                        if (q(RolePolicyStatementVO.class)
                                .eq(RolePolicyStatementVO_.roleUuid, role.getUuid())
                                .eq(RolePolicyStatementVO_.statement, statementString).isExists()) {
                            return;
                        }
                        String uuid = q(RolePolicyStatementVO.class).select(RolePolicyStatementVO_.uuid)
                                .eq(RolePolicyStatementVO_.roleUuid, role.getUuid()).findValue();
                        sql(RolePolicyStatementVO.class).eq(RolePolicyStatementVO_.uuid, uuid)
                                .set(RolePolicyStatementVO_.statement, statementString).update();
                    });
                }
            });
        }
    }.execute();
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/rbac/RBACManagerImpl.java:205

关键点：
- 预定义角色通过 `RBAC.roles` 静态集合定义
- 角色创建后通过 `SharedResourceVO` 设为公开（`toPublic=true`），所有账户可用
- 已有角色的策略声明会被更新（支持升级时策略变更）

#### 创建自定义角色

```java
private void handle(APICreateRoleMsg msg) {
    APICreateRoleEvent evt = new APICreateRoleEvent(msg.getId());

    new SQLBatch() {
        @Override
        protected void scripts() {
            RoleVO vo = new RoleVO();
            vo.setUuid(msg.getResourceUuid() == null ? Platform.getUuid() : msg.getResourceUuid());
            vo.setName(msg.getName());
            vo.setDescription(msg.getDescription());
            vo.setType(RoleType.Customized);
            vo.setIdentity(msg.getIdentity());
            vo.setAccountUuid(msg.getSession().getAccountUuid());

            if (msg.getIdentity() == null) {
                persist(vo);
            } else {
                RoleIdentityFactory factory = roleIdentityFactoryMap.get(msg.getIdentity());
                if (factory == null) {
                    persist(vo);
                } else {
                    vo = factory.createRole(vo, msg.getSession());
                }
            }

            String roleUuid = vo.getUuid();
            if (msg.getStatements() != null) {
                msg.getStatements().forEach(s -> {
                    RolePolicyStatementVO pvo = new RolePolicyStatementVO();
                    pvo.setRoleUuid(roleUuid);
                    pvo.setUuid(Platform.getUuid());
                    pvo.setStatement(JSONObjectUtil.toJsonString(s));
                    persist(pvo);
                });
            }

            if (msg.getPolicyUuids() != null) {
                msg.getPolicyUuids().forEach(puuid -> {
                    RolePolicyRefVO ref = new RolePolicyRefVO();
                    ref.setPolicyUuid(puuid);
                    ref.setRoleUuid(roleUuid);
                    persist(ref);
                });
            }

            vo = reload(vo);
            evt.setInventory(RoleInventory.valueOf(vo));
        }
    }.execute();

    bus.publish(evt);
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/rbac/RBACManagerImpl.java:140

#### 权限检查

`APICheckResourcePermissionMsg` 的处理展示了权限检查的核心逻辑：

```java
private void handle(APICheckResourcePermissionMsg msg) {
    APICheckResourcePermissionReply reply = new APICheckResourcePermissionReply();

    // 获取与目标资源类型相关的权限定义
    List<RBAC.Permission> permissions = RBAC.permissions.stream()
            .filter(p -> p.getTargetResources().stream()
                    .anyMatch(resource -> resource.getSimpleName().equals(msg.getResourceType())))
            .collect(Collectors.toList());

    // 获取当前会话的策略
    List<PolicyInventory> policies = RBACManager.getPoliciesByAPI(msg);
    Map<PolicyInventory, List<PolicyStatement>> denyStatements = RBACManager.collectDenyStatements(policies);
    Map<PolicyInventory, List<PolicyStatement>> allowStatements = RBACManager.collectAllowedStatements(policies);

    // 遍历所有 API，检查哪些被允许
    List<String> apis = new ArrayList<>();
    APIMessage.apiMessageClasses.forEach(apiClz -> {
        boolean deny = denyStatements.values().stream().anyMatch(
                states -> states.stream().anyMatch(
                        s -> s.getActions().stream().anyMatch(
                                action -> matcher.match(PolicyUtils.apiNamePatternFromAction(action), apiClz.getName()))));
        boolean allow = allowStatements.values().stream().anyMatch(
                states -> states.stream().anyMatch(
                        s -> s.getActions().stream().anyMatch(
                                action -> matcher.match(PolicyUtils.apiNamePatternFromAction(action), apiClz.getName()))));
        boolean matched = permissions.stream().anyMatch(
                p -> p.getNormalAPIs().stream().anyMatch(
                        api -> matcher.match(api, apiClz.getName())));

        if (allow && !deny && matched) {
            apis.add(apiClz.getSimpleName());
        }
    });

    reply.setApis(apis);
    bus.reply(msg, reply);
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/rbac/RBACManagerImpl.java:115

权限判断规则：**Allow 且非 Deny 且匹配 Permission 定义** → 允许。

### PolicyMatcher

PolicyMatcher 是策略匹配的核心，支持通配符模式匹配：

```java
public class PolicyMatcher {
    // 支持的模式：
    // "org.zstack.compute.vm.*" — 匹配 compute.vm 包下所有 API
    // "org.zstack.compute.**" — 匹配 compute 包及子包下所有 API
    // "org.zstack.compute.vm.APIStartVmInstanceMsg" — 精确匹配
}
```

> 源码位置：zstack/header/src/main/java/org/zstack/header/identity/rbac/PolicyMatcher.java

### PolicyUtils

PolicyUtils 提供策略相关的工具方法：

```java
public class PolicyUtils {
    public static boolean isAdminOnlyAction(String action) {
        // 检查 action 是否为管理员专用
    }

    public static String apiNamePatternFromAction(String action) {
        // 将 action 模式转换为 API 类名匹配模式
    }
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/rbac/PolicyUtils.java

## Auth 内部类

AccountManagerImpl 内部定义了 `Auth` 类，负责完整的授权检查流程。虽然当前代码中 `intercept()` 方法注释掉了 `new Auth().validate(msg)` 调用（授权已移至 AuthorizationManager），但 Auth 类的逻辑仍然值得理解：

```java
private class Auth {
    SessionInventory session;

    private void validate(APIMessage msg) {
        sessionCheck();           // 1. Session 有效性检查
        adminOnlyCheck();         // 2. 管理员专用 API 检查
        accountOnlyCheck();       // 3. 账户专用 API 检查
        accountFieldCheck();      // 4. 资源归属检查
        accountControlCheck();    // 5. 账户控制检查
        userPolicyCheck();        // 6. 用户策略检查
        groupPolicyCheck();       // 7. 用户组策略检查
        // 默认拒绝
    }
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java

### 策略检查流程

用户策略检查从数据库加载用户关联的所有策略，然后逐个匹配：

```java
@Transactional(readOnly = true)
private List<PolicyInventory> getUserPolicies() {
    String sql = "select p from PolicyVO p, UserPolicyRefVO ref where ref.userUuid = :uuid and ref.policyUuid = p.uuid";
    TypedQuery<PolicyVO> q = dbf.getEntityManager().createQuery(sql, PolicyVO.class);
    q.setParameter("uuid", session.getUserUuid());
    return PolicyInventory.valueOf(q.getResultList());
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1416

## 资源共享

ZStack 支持资源共享机制，通过 `SharedResourceVO` 实现：

- **公开共享**（`toPublic=true`）：所有账户可访问
- **指定共享**（`receiverAccountUuid`）：特定账户可访问

资源共享在 RBAC 中的体现：预定义角色通过 `SharedResourceVO` 设为公开，所有账户都可以使用这些角色。

## Quota 管理

AccountManagerImpl 还负责配额（Quota）管理。配额用于限制账户可以创建的资源数量：

```java
private void validate(APIUpdateQuotaMsg msg) {
    QuotaVO quota = Q.New(QuotaVO.class)
            .eq(QuotaVO_.identityUuid, msg.getIdentityUuid())
            .eq(QuotaVO_.name, msg.getName())
            .find();
    if (quota == null) {
        throw new OperationFailureException(argerr("cannot find Quota[name: %s] for the account[uuid: %s]", msg.getName(), msg.getIdentityUuid()));
    }

    List<QuotaUpdateChecker> checkers = quotaChangeCheckers.stream()
            .filter(checker -> checker.type().contains(quota.getIdentityType()))
            .collect(Collectors.toList());

    for (QuotaUpdateChecker checker : checkers) {
        ErrorCode errorCode = checker.check(quota, msg.getValue());
        if (errorCode != null) {
            throw new ApiMessageInterceptionException(
                    operr(errorCode, "cannot update Quota[name: %s] for the account[uuid: %s]", msg.getName(), msg.getIdentityUuid()));
        }
    }

    msg.setQuotaVO(quota);
}
```

> 源码位置：zstack/identity/src/main/java/org/zstack/identity/AccountManagerImpl.java:1736

配额更新时，会调用所有注册的 `QuotaUpdateChecker` 进行校验，确保新配额值不会违反现有资源的使用情况。

## 关键扩展点

| 扩展点 | 用途 |
|--------|------|
| AuthorizationBackend | 自定义授权逻辑 |
| RoleIdentityFactory | 创建特定身份类型的角色 |
| NewPredefinedRoleExtensionPoint | 新预定义角色扩展 |
| QuotaUpdateChecker | 配额更新校验 |
| PasswordUpdateExtensionPoint | 密码更新回调 |
| BeforeUpdateAccountExtensionPoint | 账户更新前回调 |
| BeforeDeleteAccountExtensionPoint | 账户删除前回调 |

## 总结

ZStack 身份与权限模块的设计要点：

- **三层身份模型**：Account → User/UserGroup → Policy/Role，层次清晰
- **双重拦截**：AccountManagerImpl 负责参数验证，AuthorizationManager 负责授权检查，职责分离
- **Session 管理**：内存缓存 + 数据库双写，定期清理过期会话
- **RBAC 模型**：基于 Role 的访问控制，支持预定义角色和自定义角色
- **策略匹配**：PolicyMatcher 支持通配符模式，灵活匹配 API 名称
- **资源共享**：通过 SharedResourceVO 实现跨账户资源共享
- **配额管理**：通过 QuotaUpdateChecker 扩展点支持灵活的配额校验
- **级联删除**：账户删除使用 CascadeFacade 级联删除所有关联资源
