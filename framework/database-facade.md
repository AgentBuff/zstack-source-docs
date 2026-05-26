# 06 - 数据库访问层

ZStack 的数据库访问层由 `DatabaseFacadeImpl` 统一封装，它在 JPA/Hibernate 之上提供了一套面向 IaaS 场景的 ORM 抽象。软删除（基于 `@EO` 注解）、UUID varchar(32)、JPA Criteria API 查询封装、批量操作优化——这些设计决策都深深烙印在 DatabaseFacade 的实现中。理解这一层，是读懂 ZStack 所有资源管理逻辑的前提。

## 整体架构

> 源码位置：zstack/core/src/main/java/org/zstack/core/db/DatabaseFacadeImpl.java

`DatabaseFacadeImpl` 实现了 `DatabaseFacade` 接口和 `Component` 接口，是整个数据访问层的入口。它通过 `@PersistenceUnit` 和 `@PersistenceContext` 注入 JPA `EntityManagerFactory` 和 `EntityManager`，并维护一套自定义的 `EntityInfo` 元数据系统。

```java
public class DatabaseFacadeImpl implements DatabaseFacade, Component {
    private static final CLogger logger = CLoggerImpl.getLogger(DatabaseFacadeImpl.class);

    @PersistenceUnit(unitName = "zstack.jpa")
    private EntityManagerFactory entityManagerFactory;
    @PersistenceContext(unitName = "zstack.jpa")
    private EntityManager entityManager;

    @Autowired
    private PluginRegistry pluginRgty;

    private DataSource dataSource = null;
    private DataSource extraDataSource = null;
    private Map<Class, EntityInfo> entityInfoMap = new HashMap<Class, EntityInfo>();
    private Map<Class, List<SoftDeleteEntityExtensionPoint>> softDeleteExtensions = new HashMap<Class, List<SoftDeleteEntityExtensionPoint>>();
    private Map<Class, List<SoftDeleteEntityByEOExtensionPoint>> softDeleteByEOExtensions = new HashMap<Class, List<SoftDeleteEntityByEOExtensionPoint>>();
    private Map<Class, List<HardDeleteEntityExtensionPoint>> hardDeleteExtensions = new HashMap<Class, List<HardDeleteEntityExtensionPoint>>();
    ...
}
```

核心数据结构是 `EntityInfo`，它为每个 JPA 实体类缓存了元数据：

```java
class EntityInfo {
    Field voPrimaryKeyField;
    boolean compositePrimaryKey = false;
    Field eoPrimaryKeyField;
    Field eoSoftDeleteColumn;
    Class eoClass;
    Class voClass;
    Map<EntityEvent, EntityLifeCycleCallback> listeners = new HashMap<EntityEvent, EntityLifeCycleCallback>();

    EntityInfo(Class voClazz) {
        voClass = voClazz;

        if (voClazz.isAnnotationPresent(IdClass.class)) {
            compositePrimaryKey = true;
        }

        voPrimaryKeyField = FieldUtils.getAnnotatedField(Id.class, voClass);
        DebugUtils.Assert(voPrimaryKeyField != null, String.format("%s has no primary key", voClass));
        voPrimaryKeyField.setAccessible(true);

        EO at = (EO) voClazz.getAnnotation(EO.class);
        if (at != null) {
            eoClass = at.EOClazz();
            DebugUtils.Assert(eoClass != null, String.format("cannot find EO entity specified by VO entity[%s]", voClazz.getName()));
            eoPrimaryKeyField = FieldUtils.getAnnotatedField(Id.class, eoClass);
            DebugUtils.Assert(eoPrimaryKeyField != null, String.format("cannot find primary key field(@Id annotated) in EO entity[%s]", eoClass.getName()));
            eoPrimaryKeyField.setAccessible(true);
            eoSoftDeleteColumn = FieldUtils.getField(at.softDeletedColumn(), eoClass);
            DebugUtils.Assert(eoSoftDeleteColumn != null, String.format("cannot find soft delete column[%s] in EO entity[%s]", at.softDeletedColumn(), eoClass.getName()));
            eoSoftDeleteColumn.setAccessible(true);
        }

        buildInheritanceDeletionExtension();
        buildSoftDeletionCascade();
    }
    ...
}
```

**关键设计**：`EntityInfo` 的构造函数接收的是 **VO 类**（而非 EO 类），然后通过 VO 类上的 `@EO` 注解找到对应的 EO 类和软删除列。`eoSoftDeleteColumn` 是一个 `Field` 对象，通过 `@EO` 注解的 `softDeletedColumn` 属性在 EO 类中定位。

## 启动流程

`DatabaseFacadeImpl.start()` 方法完成了所有初始化工作：

```java
@Override
public boolean start() {
    populateExtensions();
    return true;
}
```

`init()` 方法（由 Spring XML 的 `default-init-method="init"` 触发）完成实体元数据收集：

```java
void init() {
    buildEntityInfo();
    getDbVersionOnInit();
}
```

### buildEntityInfo —— 实体元数据收集

这是最关键的初始化步骤。它扫描所有带 `@Entity` 注解的类，构建 `EntityInfo`：

```java
private void buildEntityInfo() {
    BeanUtils.reflections.getTypesAnnotatedWith(Entity.class).forEach(clz-> {
        entityInfoMap.put(clz, new EntityInfo(clz));
    });
}
```

注意：`EntityInfo` 的构造函数内部完成了所有元数据解析工作，包括检测 `@EO` 注解、定位软删除列、构建级联删除扩展等。

### populateExtensions —— 扩展点注册

```java
private void populateExtensions() {
    for (SoftDeleteEntityExtensionPoint ext : pluginRgty.getExtensionList(SoftDeleteEntityExtensionPoint.class)) {
        if (ext.getEntityClassForSoftDeleteEntityExtension() == null) {
            softDeleteForAllExtensions.add(ext);
            continue;
        }

        for (Class eclazz : ext.getEntityClassForSoftDeleteEntityExtension()) {
            List<SoftDeleteEntityExtensionPoint> exts = softDeleteExtensions.get(eclazz);
            if (exts == null) {
                exts = new ArrayList<SoftDeleteEntityExtensionPoint>();
                softDeleteExtensions.put(eclazz, exts);
            }
            exts.add(ext);
        }
    }

    for (SoftDeleteEntityByEOExtensionPoint ext : pluginRgty.getExtensionList(SoftDeleteEntityByEOExtensionPoint.class)) {
        for (Class eoClass : ext.getEOClassForSoftDeleteEntityExtension()) {
            List<SoftDeleteEntityByEOExtensionPoint> exts = softDeleteByEOExtensions.get(eoClass);
            if (exts == null) {
                exts = new ArrayList<SoftDeleteEntityByEOExtensionPoint>();
                softDeleteByEOExtensions.put(eoClass, exts);
            }
            exts.add(ext);
        }
    }

    for (HardDeleteEntityExtensionPoint ext : pluginRgty.getExtensionList(HardDeleteEntityExtensionPoint.class)) {
        if (ext.getEntityClassForHardDeleteEntityExtension() == null) {
            hardDeleteForAllExtensions.add(ext);
            continue;
        }

        for (Class clazz : ext.getEntityClassForHardDeleteEntityExtension()) {
            List<HardDeleteEntityExtensionPoint> exts = hardDeleteExtensions.get(clazz);
            if (exts == null) {
                exts = new ArrayList<HardDeleteEntityExtensionPoint>();
                hardDeleteExtensions.put(clazz, exts);
            }
            exts.add(ext);
        }
    }
}
```

## 软删除机制

ZStack 的资源删除几乎全部采用软删除——在数据库中标记记录为已删除，而非物理删除。这是 IaaS 系统的常见需求：审计、回滚、资源追踪都要求保留历史数据。

### @EO 注解 —— 软删除的声明方式

> 源码位置：zstack/header/src/main/java/org/zstack/header/vo/EO.java

ZStack **没有** `@SoftDelete` 注解。软删除是通过 `@EO` 注解在 VO 类上声明的：

```java
@Target({ElementType.TYPE})
@Retention(RetentionPolicy.RUNTIME)
public @interface EO {
    Class<?> EOClazz();

    String softDeletedColumn() default "deleted";

    boolean needView() default true;
}
```

`@EO` 注解有三个属性：
- **`EOClazz()`**：指定对应的 EO 实体类（必须）
- **`softDeletedColumn()`**：指定 EO 类中软删除列的字段名，默认为 `"deleted"`
- **`needView()`**：是否需要生成数据库视图，默认为 `true`

在 VO 类中，通过 `@EO` 注解声明软删除：

```java
@Entity
@EO(EOClazz = VmInstanceEO.class, softDeletedColumn = "deleted")
public class VmInstanceVO extends VmInstanceAO {
    @Id
    @Column(name = "uuid", length = 32)
    private String uuid;
    ...
}
```

对应的 EO 类中包含软删除列：

```java
@Entity
@Table(name = "VmInstanceEO")
public class VmInstanceEO extends VmInstanceAO {
    @Id
    @Column(name = "uuid", length = 32)
    private String uuid;

    @Column(name = "deleted", updatable = false)
    private String deleted;
    ...
}
```

> **注意**：EO 类中的 `deleted` 字段类型为 `String`（存储时间戳），而非 `Integer`。软删除时写入的是当前时间的字符串表示，而非简单的 0/1 标记。

### 软删除的执行逻辑

`EntityInfo.remove()` 方法根据是否存在 `@EO` 注解决定删除策略：

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
void remove(Object entity) {
    if (!hasEO()) {
        hardDelete(entity);
    } else {
        softDelete(entity);
    }
}
```

`softDelete()` 方法的实际实现——将 EO 表中的软删除列设置为当前时间戳：

```java
private void softDelete(Object entity) {
    try {
        Object idval = getEOPrimaryKeyValue(entity);
        if (idval == null) {
            return;
        }

        Object eo = getEntityManager().find(eoClass, idval);
        eoSoftDeleteColumn.set(eo, new Timestamp(new Date().getTime()).toString());
        getEntityManager().merge(eo);
        fireSoftDeleteExtension(Arrays.asList(idval), voClass);
        fireSoftDeleteExtensionByEOClass(Arrays.asList(idval), eoClass);
    } catch (CloudRuntimeException ce) {
        throw ce;
    } catch (Exception e) {
        throw new CloudRuntimeException(e);
    }
}
```

批量软删除使用 JPQL 批量更新：

```java
private void softDelete(Collection ids) {
    String sql = String.format("update %s eo set eo.%s = (:date) where eo.%s in (:ids)",
            eoClass.getSimpleName(), eoSoftDeleteColumn.getName(), eoPrimaryKeyField.getName());
    Query q = getEntityManager().createQuery(sql);
    q.setParameter("ids", ids);
    q.setParameter("date", new Timestamp(new Date().getTime()).toString());
    q.executeUpdate();

    fireSoftDeleteExtension(ids, voClass);
    fireSoftDeleteExtensionByEOClass(ids, eoClass);
}
```

### 软删除级联

ZStack 通过 `@SoftDeletionCascades` 和 `@SoftDeletionCascade` 注解声明软删除级联关系：

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface SoftDeletionCascade {
    Class parent();
    String joinColumn();
}

@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface SoftDeletionCascades {
    SoftDeletionCascade[] value();
}
```

在 `EntityInfo` 构造函数中，`buildSoftDeletionCascade()` 方法解析这些注解，自动注册 `SoftDeleteEntityExtensionPoint`，在父实体软删除时级联删除子实体记录：

```java
private void buildSoftDeletionCascade() {
    SoftDeletionCascades ats = (SoftDeletionCascades) voClass.getAnnotation(SoftDeletionCascades.class);
    if (ats == null) {
        return;
    }

    for (final SoftDeletionCascade at : ats.value()) {
        final Class parent = at.parent();
        ...
        if (!parent.isAnnotationPresent(EO.class)) {
            continue;
        }

        List<SoftDeleteEntityExtensionPoint> exts = softDeleteExtensions.get(parent);
        if (exts == null) {
            exts = new ArrayList<SoftDeleteEntityExtensionPoint>();
            softDeleteExtensions.put(parent, exts);
        }

        exts.add(new SoftDeleteEntityExtensionPoint() {
            @Override
            public List<Class> getEntityClassForSoftDeleteEntityExtension() {
                return Arrays.asList(parent);
            }

            @Override
            @Transactional
            public void postSoftDelete(Collection entityIds, Class entityClass) {
                String sql = String.format("delete from %s me where me.%s in (:ids)", voClass.getSimpleName(), at.joinColumn());
                Query q = getEntityManager().createQuery(sql);
                q.setParameter("ids", entityIds);
                q.executeUpdate();
            }
        });
    }
}
```

### EO 清理

软删除的记录可以通过 `eoCleanup()` 方法物理删除：

```java
@Override
@DeadlockAutoRestart
public void eoCleanup(Class VOClazz) {
    EntityInfo info = getEntityInfo(VOClazz);
    if (!info.hasEO()) {
        logger.warn(String.format("Class[%s] doesn't has EO.", VOClazz));
        return;
    }

    _eoCleanup(VOClazz);
}
```

`_eoCleanup()` 查找所有软删除列非空的记录，然后执行物理删除：

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
private void _eoCleanup(Class VOClazz) {
    EntityInfo info = getEntityInfo(VOClazz);

    String deleted = info.eoSoftDeleteColumn.getName();
    String sql = String.format("select eo.%s from %s eo where eo.%s is not null", info.voPrimaryKeyField.getName(),
            info.eoClass.getSimpleName(), deleted);
    Query q = getEntityManager().createQuery(sql);
    List ids = q.getResultList();
    if (ids.isEmpty()) {
        return;
    }

    info.hardDelete(ids);
}
```

## UUID varchar(32) 设计

ZStack 的一个重要设计决策是 UUID 使用 `varchar(32)` 而非标准的 `varchar(36)`。Java 标准 UUID 格式为 `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx`（36 字符含连字符），ZStack 在存储时去掉了连字符：

```java
// Platform.getUuid() 的实现
public static String getUuid() {
    return UUID.randomUUID().toString().replace("-", "");
}
```

这个设计贯穿整个代码库：

- 所有 VO 的主键字段类型为 `varchar(32)`
- `makeTargetServiceIdByResourceUuid()` 使用 UUID 做一致性哈希
- 外键关联也基于 32 字符 UUID

**设计考量**：节省存储空间（每行节省 4 字节），提升索引效率。代价是可读性降低，调试时需要手动补回连字符。

## 核心 API

> 源码位置：zstack/core/src/main/java/org/zstack/core/db/DatabaseFacade.java

### persist —— 持久化实体

```java
@Override
public <T> T persist(T entity) {
    return persist(entity, false);
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
private <T> T doPersist(T entity, boolean isRefresh) {
    this.entityForTranscationCallback(Operation.PERSIST, entity.getClass());
    getEntityManager().persist(entity);

    if (isRefresh) {
        getEntityManager().flush();
        getEntityManager().refresh(entity);
    }
    return entity;
}

@DeadlockAutoRestart
private <T> T persist(T entity, boolean isRefresh) {
    return doPersist(entity, isRefresh);
}

@Override
public <T> T persistAndRefresh(T entity) {
    return persist(entity, true);
}
```

`persist()` 内部调用 `doPersist()`，后者在 `REQUIRES_NEW` 事务中执行。`persistAndRefresh()` 在持久化后立即 flush 并 refresh 实体，确保获取数据库生成的字段值。`@DeadlockAutoRestart` 注解在遇到数据库死锁时自动重试。

### findByUuid —— 按主键查询

这是 ZStack 中最常用的查询方法：

```java
@Override
@Transactional(readOnly = true, propagation = Propagation.REQUIRES_NEW)
public <T> T findByUuid(String uuid, Class<T> entityClass) {
    return this.getEntityManager().find(entityClass, uuid);
}
```

注意：`findByUuid` 直接使用 JPA 的 `EntityManager.find()` 按主键查询，在 `REQUIRES_NEW` 只读事务中执行。它**不会**在 Java 层面检查软删除标记——如果查询的是 VO 类，由于 VO 表中已删除的记录已被物理删除（只保留在 EO 表中），所以自然查不到；如果查询的是 EO 类，则可能返回已软删除的记录。

### update —— 更新实体

```java
@Override
public <T> void update(T entity) {
    getEntityInfo(entity.getClass()).update(entity);
}
```

实际更新逻辑在 `EntityInfo.update()` 中：

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
private Object update(Object e, boolean refresh) {
    try {
        e = getEntityManager().merge(e);
        if (refresh) {
            getEntityManager().flush();
            getEntityManager().refresh(e);
        }
        return e;
    } catch (DataIntegrityViolationException | ConstraintViolationException exception) {
        updateEO(e, exception);
    }

    return e;
}

@DeadlockAutoRestart
void update(Object e) {
    update(e, false);
}

@DeadlockAutoRestart
Object updateAndRefresh(Object e) {
    return update(e, true);
}
```

`update()` 的一个精妙之处在于 `updateEO()` 方法：当更新 VO 实体时遇到主键冲突（通常是关联的父实体已被软删除），它会自动将更新操作转移到 EO 表中执行，避免因级联删除的异步性导致的数据不一致。

### remove —— 删除实体（软删除优先）

```java
@Override
@DeadlockAutoRestart
public void remove(Object entity) {
    getEntityInfo(entity.getClass()).remove(entity);
}

@Override
@DeadlockAutoRestart
public void removeByPrimaryKey(Object primaryKey, Class<?> entityClass) {
    getEntityInfo(entityClass).removeByPrimaryKey(primaryKey);
}

@Override
@DeadlockAutoRestart
public void removeByPrimaryKeys(Collection priKeys, Class entityClazz) {
    if (priKeys.isEmpty()) {
        return;
    }
    getEntityInfo(entityClazz).removeByPrimaryKeys(priKeys);
}
```

`EntityInfo` 中的删除逻辑根据 `hasEO()` 判断执行软删除还是硬删除：

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
void remove(Object entity) {
    if (!hasEO()) {
        hardDelete(entity);
    } else {
        softDelete(entity);
    }
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
void removeByPrimaryKey(Object id) {
    if (hasEO()) {
        softDelete(list(id));
    } else {
        hardDelete(list(id));
    }
}

@Transactional(propagation = Propagation.REQUIRES_NEW)
void removeByPrimaryKeys(Collection ids) {
    if (hasEO()) {
        softDelete(ids);
    } else {
        hardDelete(ids);
    }
}
```

硬删除的实现：

```java
private void hardDelete(Object entity) {
    entity = getEntityManager().merge(entity);
    getEntityManager().remove(entity);
    Object idval = getVOPrimaryKeyValue(entity);
    fireHardDeleteExtension(list(idval));
}

private void hardDelete(Collection ids) {
    String tblName = hasEO() ? eoClass.getSimpleName() : voClass.getSimpleName();
    String sql = String.format("delete from %s eo where eo.%s in (:ids)", tblName, voPrimaryKeyField.getName());
    Query q = getEntityManager().createQuery(sql);
    q.setParameter("ids", ids);
    q.executeUpdate();
    logger.debug(String.format("hard delete %s records from %s", ids.size(), tblName));

    fireHardDeleteExtension(ids);
}
```

## Q 类 —— 流式查询 API

> 源码位置：zstack/core/src/main/java/org/zstack/core/db/Q.java

ZStack 封装了 `Q` 类提供流式查询接口。`Q` 类内部委托给 `SimpleQueryImpl`，使用 JPA Criteria API 而非 QueryDSL：

```java
public class Q {
    private SimpleQueryImpl q;

    @SuppressWarnings("unchecked")
    private Q(Class clz) {
        q = new SimpleQueryImpl(clz);
    }

    public static Q New(Class clz) {
        return new Q(clz);
    }

    public Q eq(SingularAttribute attr, Object val) {
        q.add(attr, SimpleQuery.Op.EQ, val);
        return this;
    }

    public Q notEq(SingularAttribute attr, Object val) {
        q.add(attr, SimpleQuery.Op.NOT_EQ, val);
        return this;
    }

    public Q in(SingularAttribute attr, Collection val) {
        DebugUtils.Assert(CollectionUtils.isNotEmpty(val), "Op.IN value cannot be null or empty");
        q.add(attr, SimpleQuery.Op.IN, val);
        return this;
    }

    public Q notIn(SingularAttribute attr, Collection val) {
        q.add(attr, SimpleQuery.Op.NOT_IN, val);
        return this;
    }

    public Q like(SingularAttribute attr, Object val) {
        q.add(attr, SimpleQuery.Op.LIKE, val);
        return this;
    }

    public Q gt(SingularAttribute attr, Object val) {
        q.add(attr, SimpleQuery.Op.GT, val);
        return this;
    }

    public Q lt(SingularAttribute attr, Object val) {
        q.add(attr, SimpleQuery.Op.LT, val);
        return this;
    }

    public Q isNull(SingularAttribute attr) {
        q.add(attr, SimpleQuery.Op.NULL);
        return this;
    }

    public Q notNull(SingularAttribute attr) {
        q.add(attr, SimpleQuery.Op.NOT_NULL);
        return this;
    }

    public Q select(SingularAttribute... attrs) {
        q.select(attrs);
        return this;
    }

    public Q orderByAsc(SingularAttribute<?, ?> attr) {
        q.orderBy(attr, SimpleQuery.Od.ASC);
        return this;
    }

    public Q orderByDesc(SingularAttribute<?, ?> attr) {
        q.orderBy(attr, SimpleQuery.Od.DESC);
        return this;
    }

    public Q groupBy(SingularAttribute attr) {
        q.groupBy(attr);
        return this;
    }

    public Q limit(int limit) {
        q.setLimit(limit);
        return this;
    }

    public Q start(int start) {
        q.setStart(start);
        return this;
    }

    @Transactional(readOnly = true)
    public boolean isExists() {
        return q._count() > 0;
    }

    @Transactional(readOnly = true)
    public Long count() {
        return q._count();
    }

    @Transactional(readOnly = true)
    public <T> T find() {
        return (T) q._find();
    }

    @Transactional(readOnly = true)
    public <T> List<T> list() {
        List<T> res = q._list();
        if (res != null)
            return res;
        return Collections.emptyList();
    }

    @Transactional(readOnly = true)
    public <K> K findValue() {
        return (K) q._findValue();
    }

    @Transactional(readOnly = true)
    public <K> List<K> listValues() {
        List<K> res = q._listValue();
        if (res != null)
            return res;
        return Collections.emptyList();
    }

    @Transactional(readOnly = true)
    public Tuple findTuple() {
        return q._findTuple();
    }

    @Transactional(readOnly = true)
    public List<Tuple> listTuple() {
        List<Tuple> res = q._listTuple();
        if (res != null)
            return res;
        return Collections.emptyList();
    }
    ...
}
```

### 使用示例

```java
// 简单查询：按主键查找
VmInstanceVO vm = Q.New(VmInstanceVO.class)
    .eq(VmInstanceVO_.uuid, vmUuid)
    .find();

// 条件查询
List<VmInstanceVO> vms = Q.New(VmInstanceVO.class)
    .eq(VmInstanceVO_.state, VmInstanceState.Running)
    .like(VmInstanceVO_.name, "test%")
    .list();

// 计数
long count = Q.New(VmInstanceVO.class)
    .eq(VmInstanceVO_.hostUuid, hostUuid)
    .count();

// 查询单个字段值
String name = Q.New(VmInstanceVO.class)
    .select(VmInstanceVO_.name)
    .eq(VmInstanceVO_.uuid, vmUuid)
    .findValue();

// 查询多个字段（返回 Tuple）
Tuple tuple = Q.New(VmInstanceVO.class)
    .select(VmInstanceVO_.uuid, VmInstanceVO_.name)
    .eq(VmInstanceVO_.state, VmInstanceState.Running)
    .findTuple();
```

> **注意**：`Q` 类使用 JPA 的 `SingularAttribute`（由 JPA Metamodel 生成，即 `VO_` 类中的静态字段），而非 QueryDSL 的 `Path` 类型。`SimpleQueryImpl` 内部使用 JPA Criteria API 构建查询。

### SimpleQueryImpl —— Q 类的底层实现

`SimpleQueryImpl` 是 `Q` 类的底层实现，使用 JPA Criteria API：

```java
@Configurable(preConstruction=true, autowire=Autowire.BY_TYPE, dependencyCheck=true)
public class SimpleQueryImpl<T> implements SimpleQuery<T> {
    private final Class<T> _entityClass;
    private Root<T> _root;
    private List<AttrInfo> _selects = new ArrayList<AttrInfo>();
    private List<Condition> _conditions = new ArrayList<Condition>();
    private List<OrderInfo> orderInfos = new ArrayList<OrderInfo>();
    private SingularAttribute groupByInfo = null;
    private CriteriaQuery _query;
    private final CriteriaBuilder _builder;
    private Integer limit;
    private Integer start;

    @Autowired
    private DatabaseFacade _dbf;

    SimpleQueryImpl(Class<T> vo) {
        _entityClass = vo;
        _builder = _dbf.getCriteriaBuilder();
    }
    ...
}
```

`SimpleQueryImpl` 通过 `@Configurable` 注解实现 Spring 依赖注入（而非通过 Spring 容器创建），这样可以在 `new SimpleQueryImpl()` 时自动注入 `DatabaseFacade`。

## 批量操作

IaaS 系统中经常需要批量操作大量记录（如批量查询 VM、批量更新状态）。`DatabaseFacadeImpl` 提供了专门的批量 API。

### persistCollection —— 批量插入

```java
@Override
@Transactional(propagation = Propagation.REQUIRES_NEW)
public void persistCollection(Collection entities) {
    for (Object e : entities) {
        this.entityForTranscationCallback(Operation.PERSIST, e.getClass());
        this.getEntityManager().persist(e);
    }
}
```

### updateCollection —— 批量更新

```java
@Transactional(propagation = Propagation.REQUIRES_NEW)
private void doUpdateCollection(Collection entities) {
    for (Object e : entities) {
        getEntityManager().merge(e);
    }
}

@Override
@DeadlockAutoRestart
public void updateCollection(Collection entities) {
    doUpdateCollection(entities);
}
```

> **注意**：与原文档描述不同，实际的批量操作方法中**没有**每 500 条 flush/clear 的逻辑。批量操作在单个事务中完成，依赖 `@DeadlockAutoRestart` 注解处理死锁重试。

## EntityManager 管理

`DatabaseFacadeImpl` 使用 Spring 管理的 `EntityManager`，通过 `@PersistenceContext` 注入：

```java
@PersistenceContext(unitName = "zstack.jpa")
private EntityManager entityManager;

public EntityManager getEntityManager() {
    return entityManager;
}
```

Spring 容器负责 `EntityManager` 的生命周期管理，包括线程安全的代理和事务绑定。`@PersistenceContext` 注入的是一个共享的、事务感知的代理对象，而非直接创建 `EntityManager` 实例。

## 生命周期回调

`DatabaseFacadeImpl` 支持通过 `EntityLifeCycleCallback` 在实体生命周期事件上执行自定义逻辑：

```java
public enum EntityEvent {
    PRE_PERSIST,
    POST_PERSIST,
    POST_LOAD,
    PRE_UPDATE,
    POST_UPDATE,
    PRE_REMOVE,
    POST_REMOVE
}

public interface EntityLifeCycleCallback {
    void entityLifeCycleEvent(EntityEvent evt, Object o);
}
```

注册回调：

```java
@Override
public void installEntityLifeCycleCallback(Class clz, EntityEvent evt, EntityLifeCycleCallback cb) {
    if (clz != null) {
        EntityInfo info = entityInfoMap.get(clz);
        DebugUtils.Assert(info != null, String.format("cannot find EntityInfo for the class[%s]", clz));
        info.installLifeCycleCallback(evt, cb);
    } else {
        for (EntityInfo info : entityInfoMap.values()) {
            info.installLifeCycleCallback(evt, cb);
        }
    }
}
```

触发回调：

```java
void entityEvent(EntityEvent evt, Object entity) {
    EntityInfo info = entityInfoMap.get(entity.getClass());
    if (info == null) {
        logger.warn(String.format("cannot find EntityInfo for the class[%s], not entity events will be fired", entity.getClass()));
        return;
    }

    info.fireLifeCycleEvent(evt, entity);
}
```

## 删除扩展点

ZStack 提供了三种删除扩展点，允许插件在删除操作后执行自定义逻辑：

### SoftDeleteEntityExtensionPoint —— 按 VO 类的软删除扩展

```java
public interface SoftDeleteEntityExtensionPoint {
    List<Class> getEntityClassForSoftDeleteEntityExtension();
    void postSoftDelete(Collection entityIds, Class entityClass);
}
```

### SoftDeleteEntityByEOExtensionPoint —— 按 EO 类的软删除扩展

```java
public interface SoftDeleteEntityByEOExtensionPoint {
    List<Class> getEOClassForSoftDeleteEntityExtension();
    void postSoftDelete(Collection entityIds, Class EOClass);
}
```

### HardDeleteEntityExtensionPoint —— 硬删除扩展

```java
public interface HardDeleteEntityExtensionPoint {
    List<Class> getEntityClassForHardDeleteEntityExtension();
    void postHardDelete(Collection entityIds, Class entityClass);
}
```

## EO 与 AO 模式

ZStack 的实体类采用 EO（Extended Object）/ AO（Abstract Object）/ VO（Value Object）三层设计：

- **AO（Abstract Object）**：抽象基类，定义字段和 getter/setter，不带 JPA 注解
- **VO（Value Object）**：继承 AO，添加 `@Entity`、`@Id` 等 JPA 注解，代表当前有效的业务数据
- **EO（Extended Object）**：继承 AO，添加 `@Entity`、`@Table`、软删除列等，包含所有数据（含已软删除的记录）

```java
// AO —— 抽象基类，不含 JPA 注解
public abstract class VmInstanceAO {
    private String uuid;
    private String name;
    private String state;
    private String hostUuid;
    ...
}

// VO —— JPA 实体，代表当前有效数据，通过 @EO 声明软删除
@Entity
@EO(EOClazz = VmInstanceEO.class, softDeletedColumn = "deleted")
public class VmInstanceVO extends VmInstanceAO {
    @Id
    @Column(name = "uuid", length = 32)
    private String uuid;
    ...
}

// EO —— JPA 实体，包含软删除列，存储所有数据（含已删除）
@Entity
@Table(name = "VmInstanceEO")
public class VmInstanceEO extends VmInstanceAO {
    @Id
    @Column(name = "uuid", length = 32)
    private String uuid;

    @Column(name = "deleted", updatable = false)
    private String deleted;
    ...
}
```

**设计意图**：
- VO 表只存储当前有效的数据，查询时无需过滤软删除记录
- EO 表存储所有数据（含已软删除的），软删除时将 `deleted` 列设为时间戳
- 删除操作先从 VO 表物理删除记录，再在 EO 表中标记 `deleted` 列
- AO 可以在非 JPA 上下文中使用（如构造 API 返回的 Inventory 对象），业务逻辑不直接依赖 JPA 注解

## 事务回调

`DatabaseFacadeImpl` 提供了事务回调机制，允许在事务提交后执行异步或同步回调：

```java
@Override
public void entityForTranscationCallback(Operation op, Class<?>... entityClass) {
    if (TransactionSynchronizationManager.isActualTransactionActive()) {
        for (TransactionalSyncCallback cb : getTransactionSyncCallbacks()) {
            TransactionSynchronizationSyncImpl tsi = new TransactionSynchronizationSyncImpl(cb, op, entityClass);
            TransactionSynchronizationManager.registerSynchronization(tsi);
        }

        for (TransactionalCallback cb : getTransactionAsyncCallbacks()) {
            TransactionSynchronizationAsyncImpl tsi = new TransactionSynchronizationAsyncImpl(cb, op, entityClass);
            TransactionSynchronizationManager.registerSynchronization(tsi);
        }
    } else {
        StringBuilder sb = new StringBuilder();
        for (Class<?> c : entityClass) {
            sb.append(c.getName()).append(",");
        }

        String err = String.format("entityForTranscationCallback is called but transcation is not active. Did you forget adding @Transactional to method??? [operation: %s, entity classes: %s]", op, sb.toString());
        logger.warn(err);
    }
}
```

回调操作类型定义在 `TransactionalCallback.Operation` 中（如 `PERSIST`），在 `persist()` 方法中自动触发。

## Spring XML 配置

> 源码位置：zstack/conf/springConfigXml/DatabaseFacade.xml

```xml
<bean id="databaseFacade" class="org.zstack.core.db.DatabaseFacadeImpl">
    <zstack:plugin>
        <zstack:extension interface="org.zstack.header.Component"/>
    </zstack:plugin>

    <property name="dataSource" ref="DbFacadeDataSource"/>
    <property name="extraDataSource" ref="ExtraDataSource"/>
</bean>
```

注意 bean id 为 `databaseFacade`（小写 d），而非 `DatabaseFacade`。`DatabaseFacadeImpl` 作为 `Component` 扩展点注册，在管理节点启动时自动初始化。XML 中还配置了 C3P0 数据源（`DbFacadeDataSource` 和 `ExtraDataSource`）、JPA `EntityManagerFactory`、事务管理器等。

完整的 Spring XML 配置包括：

```xml
<bean id="DbDeadlockAspect" class="org.zstack.core.aspect.DbDeadlockAspect" factory-method="aspectOf"/>

<bean id="transactionManager" class="org.springframework.orm.jpa.JpaTransactionManager">
    <property name="entityManagerFactory" ref="entityManagerFactory"/>
</bean>

<bean id="DbFacadeDataSource" class="com.mchange.v2.c3p0.ComboPooledDataSource" destroy-method="close">
    <property name="driverClass" value="com.mysql.jdbc.Driver"/>
    <property name="jdbcUrl" value="${DbFacadeDataSource.jdbcUrl:jdbc:mysql://localhost:3306/zstack}"/>
    <property name="user" value="${DbFacadeDataSource.user:root}"/>
    <property name="password" value="${DbFacadeDataSource.password:}"/>
    <property name="initialPoolSize" value="10"/>
    <property name="maxPoolSize" value="${DbFacadeDataSource.maxPoolSize:100}"/>
    ...
</bean>

<bean id="entityManagerFactory"
      class="org.springframework.orm.jpa.LocalContainerEntityManagerFactoryBean">
    <property name="persistenceUnitName" value="zstack.jpa"/>
    <property name="dataSource" ref="DbFacadeDataSource"/>
    <property name="jpaProperties">
        <props>
            <prop key="hibernate.dialect">org.hibernate.dialect.MySQLInnoDBDialect</prop>
            ...
        </props>
    </property>
</bean>
```

## 设计总结

| 设计决策 | 实现方式 | 优势 |
|---------|---------|------|
| 软删除 | `@EO` 注解 + `softDeletedColumn` 属性 + EO 表时间戳标记 | 保留审计数据，VO 表查询无需过滤 |
| UUID varchar(32) | `Platform.getUuid()` 去连字符 | 节省存储，提升索引效率 |
| EO/AO/VO 三层 | 抽象基类 + VO 有效数据 + EO 全量数据 | 业务逻辑与持久化解耦，查询性能优化 |
| Q 流式查询 | JPA Criteria API + `SingularAttribute` + `SimpleQueryImpl` | 类型安全，流式 API 易用 |
| 删除扩展点 | `SoftDeleteEntityExtensionPoint` / `HardDeleteEntityExtensionPoint` | 可扩展的删除后处理机制 |
| 死锁自动重试 | `@DeadlockAutoRestart` 注解 + AspectJ 切面 | 自动处理数据库死锁，提高可靠性 |
| 事务回调 | `TransactionalCallback` + Spring `TransactionSynchronization` | 事务提交后执行异步/同步回调 |
| EntityManager | `@PersistenceContext` Spring 注入 | 容器管理生命周期，线程安全 |
