# 12 - AO/VO/Inventory 三层模型

ZStack 中每个有状态的 IaaS 资源（VM、Host、Volume、Image 等）都遵循统一的数据模型三层架构：**AO → VO → Inventory**。这三层分别承担数据库列定义、JPA 实体关系和 API 响应的职责，层层递进，各司其职。

## 三层架构总览

```
┌─────────────────────────────────────────────────────┐
│  Inventory (POJO)                                    │
│  - API 响应对象，无 JPA 注解                           │
│  - 包含子资源列表（vmNics, allVolumes）                 │
│  - @Inventory, @ExpandedQueries                      │
├─────────────────────────────────────────────────────┤
│  VO (@Entity)                                        │
│  - 继承 AO，添加 @OneToMany/@OneToOne 关系             │
│  - @EntityGraph 声明 parents 和 friends               │
│  - @EO 关联软删除视图                                  │
├─────────────────────────────────────────────────────┤
│  AO (@MappedSuperclass)                              │
│  - 定义数据库列和 @ForeignKey                          │
│  - 继承 ResourceVO（uuid, resourceName, resourceType）│
│  - 纯粹的列定义，无关系映射                              │
└─────────────────────────────────────────────────────┘
```

## 第一层：AO — 数据库列定义

AO（Abstract Object）使用 `@MappedSuperclass` 注解，定义资源在数据库中的所有列。它不映射任何 JPA 关系（`@OneToMany`、`@OneToOne`），只包含基本字段和 `@ForeignKey` 外键约束。

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceAO.java

```java
@MappedSuperclass
public class VmInstanceAO extends ResourceVO {
    @Column
    @Index(length = 128)
    private String name;

    @Column
    private String description;

    @Column
    @ForeignKey(parentEntityClass = ZoneEO.class, onDeleteAction = ReferenceOption.SET_NULL)
    private String zoneUuid;

    @Column
    @ForeignKey(parentEntityClass = ClusterEO.class, onDeleteAction = ReferenceOption.SET_NULL)
    private String clusterUuid;

    @Column
    @ForeignKey(parentEntityClass = ImageEO.class, onDeleteAction = ReferenceOption.RESTRICT)
    private String imageUuid;

    @Column
    @ForeignKey(parentEntityClass = HostEO.class, onDeleteAction = ReferenceOption.SET_NULL)
    private String hostUuid;

    @Column
    @ForeignKey(parentEntityClass = InstanceOfferingEO.class, onDeleteAction = ReferenceOption.RESTRICT)
    private String instanceOfferingUuid;

    @Column
    @ForeignKey(parentEntityClass = VolumeEO.class, onDeleteAction = ReferenceOption.SET_NULL)
    private String rootVolumeUuid;

    @Column
    private Long internalId;

    @Column
    private String type;
    @Column
    private String hypervisorType;
    @Column
    private int cpuNum;
    @Column
    private long cpuSpeed;
    @Column
    private long memorySize;

    @Column
    @Enumerated(EnumType.STRING)
    private VmInstanceState state;

    @Column
    private Timestamp createDate;
    @Column
    private Timestamp lastOpDate;

    @PreUpdate
    private void preUpdate() {
        lastOpDate = null;
    }
}
```

### AO 的关键设计

1. **继承 ResourceVO**：所有 AO 都继承 `ResourceVO`，获得 `uuid`、`resourceName`、`resourceType`、`concreteResourceType` 四个公共字段

> 源码位置：zstack/header/src/main/java/org/zstack/header/vo/ResourceVO.java

```java
@Entity
@Table
@Inheritance(strategy = InheritanceType.JOINED)
public class ResourceVO {
    @Id
    @Column
    @Index
    protected String uuid;

    @Column
    private String resourceName;
    @Column
    private String resourceType;
    @Column
    private String concreteResourceType;

    @PrePersist
    private void prePersist() {
        resourceType = ResourceTypeMetadata.getBaseResourceTypeFromConcreteType(getClass()).getSimpleName();
        concreteResourceType = getClass().getName();
        resourceName = getValueOfNameField();
    }
}
```

2. **@ForeignKey 自定义注解**：ZStack 不使用 JPA 标准的 `@ManyToOne`，而是自研 `@ForeignKey` 注解，支持 `RESTRICT`（禁止删除父记录）和 `SET_NULL`（删除父记录时置空）两种策略

3. **@PreUpdate 自动更新时间**：`lastOpDate = null` 触发数据库自动填充当前时间

4. **UUID varchar(32) 设计**：ZStack 的 UUID 是标准 UUID v4 去掉连字符后的 32 字符字符串，而非标准的 36 字符格式

```java
// APICreateMessage 中的注释明确说明了这一点
/**
 * resource uuid which must be of version 4(random) with dash stripped.
 * For example, '5d94103e-1925-4d86-96c0-f05489c259ab'
 * is stripped as '5d94103e19254d8696c0f05489c259ab'.
 */
private String resourceUuid;
```

## 第二层：VO — JPA 实体与关系

VO（Value Object）继承 AO，添加 `@Entity` 注解成为 JPA 实体，并补充关系映射和 `@EntityGraph` 声明。

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceVO.java

```java
@Entity
@Table
@EO(EOClazz = VmInstanceEO.class)
@BaseResource
@EntityGraph(
        parents = {
                @EntityGraph.Neighbour(type = ZoneVO.class, myField = "zoneUuid", targetField = "uuid"),
                @EntityGraph.Neighbour(type = ClusterVO.class, myField = "clusterUuid", targetField = "uuid"),
                @EntityGraph.Neighbour(type = HostVO.class, myField = "hostUuid", targetField = "uuid"),
        },
        friends = {
                @EntityGraph.Neighbour(type = ImageVO.class, myField = "imageUuid", targetField = "uuid"),
                @EntityGraph.Neighbour(type = InstanceOfferingVO.class, myField = "instanceOfferingUuid", targetField = "uuid"),
                @EntityGraph.Neighbour(type = VolumeVO.class, myField = "rootVolumeUuid", targetField = "uuid"),
                @EntityGraph.Neighbour(type = VmNicVO.class, myField = "uuid", targetField = "vmInstanceUuid"),
        }
)
public class VmInstanceVO extends VmInstanceAO implements OwnedByAccount, ToInventory {
    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "vmInstanceUuid", insertable = false, updatable = false)
    @NoView
    private Set<VmNicVO> vmNics = new HashSet<VmNicVO>();

    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "vmInstanceUuid", insertable = false, updatable = false)
    @NoView
    private Set<VolumeVO> allVolumes = new HashSet<VolumeVO>();

    @OneToMany(fetch = FetchType.EAGER)
    @JoinColumn(name = "vmInstanceUuid", insertable = false, updatable = false)
    @NoView
    private Set<VmCdRomVO> vmCdRoms = new HashSet<VmCdRomVO>();

    @Transient
    private String accountUuid;
}
```

### @EntityGraph：parents 与 friends

`@EntityGraph` 是 ZStack 自研注解，用于声明资源间的关联关系，驱动级联删除和查询扩展：

> 源码位置：zstack/header/src/main/java/org/zstack/header/vo/EntityGraph.java

```java
@Target(ElementType.TYPE)
@Retention(RetentionPolicy.RUNTIME)
public @interface EntityGraph {
    @Target({ElementType.TYPE})
    @Retention(RetentionPolicy.RUNTIME)
    @interface Neighbour {
        Class type();
        String myField();
        String targetField();
        int weight() default -1;
    }

    Neighbour[] parents() default {};
    Neighbour[] friends() default {};
}
```

**parents（父节点）**：表示"属于"关系，用于 CascadeFacade 级联删除。删除 Zone 时会级联处理其下所有 Host：

```java
// HostVO 的 @EntityGraph
@EntityGraph(
    parents = {
        @EntityGraph.Neighbour(type = ClusterVO.class, myField = "clusterUuid", targetField = "uuid"),
        @EntityGraph.Neighbour(type = ZoneVO.class, myField = "zoneUuid", targetField = "uuid"),
    }
)
```

**friends（友节点）**：表示"关联"关系，不参与级联删除，但支持查询扩展。VmInstanceVO 的 `friends` 包括 Image、InstanceOffering、Volume、VmNic。

### @EO：软删除视图

`@EO` 注解关联一个 EO（Entity Object）类，用于软删除机制。EO 继承 AO 并添加 `deleted` 字段：

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceEO.java

```java
@Entity
@Table
public class VmInstanceEO extends VmInstanceAO {
    @Column
    private String deleted;
}
```

数据库中存在两张表：`VmInstanceVO`（当前数据视图）和 `VmInstanceEO`（包含已删除记录的全量视图）。删除操作不是物理删除，而是将记录标记为 `deleted`，VO 通过数据库视图自动过滤。

### Host 的 AO/VO 示例

> 源码位置：zstack/header/src/main/java/org/zstack/header/host/HostAO.java

```java
@MappedSuperclass
public class HostAO extends ResourceVO {
    @Column
    @ForeignKey(parentEntityClass = ZoneEO.class, onDeleteAction = ReferenceOption.RESTRICT)
    private String zoneUuid;

    @Column
    @ForeignKey(parentEntityClass = ClusterEO.class, onDeleteAction = ReferenceOption.RESTRICT)
    private String clusterUuid;

    @Column
    private String managementIp;

    @Column
    @Enumerated(EnumType.STRING)
    private HostState state;

    @Column
    @Enumerated(EnumType.STRING)
    private HostStatus status;
}
```

> 源码位置：zstack/header/src/main/java/org/zstack/header/host/HostVO.java

```java
@Entity
@Table
@EO(EOClazz = HostEO.class)
@AutoDeleteTag
@BaseResource
@EntityGraph(
    parents = {
        @EntityGraph.Neighbour(type = ClusterVO.class, myField = "clusterUuid", targetField = "uuid"),
        @EntityGraph.Neighbour(type = ZoneVO.class, myField = "zoneUuid", targetField = "uuid"),
    }
)
public class HostVO extends HostAO {
    @OneToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "uuid")
    @NoView
    private HostCapacityVO capacity;

    @OneToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "uuid")
    @NoView
    private HostIpmiVO ipmi;

    @OneToOne(fetch = FetchType.EAGER)
    @JoinColumn(name = "uuid")
    @NoView
    private HostHwMonitorStatusVO hwMonitorStatus;
}
```

## 第三层：Inventory — API 响应对象

Inventory 是纯 POJO，没有任何 JPA 注解，专门用于 API 响应序列化。它从 VO 构造，将 `@OneToMany` 的 `Set<>` 转为 `List<>`，将枚举转为 `String`。

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceInventory.java

```java
@Inventory(mappingVOClass = VmInstanceVO.class)
@PythonClassInventory
@ExpandedQueries({
    @ExpandedQuery(expandedField = "zone", inventoryClass = ZoneInventory.class,
            foreignKey = "zoneUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "cluster", inventoryClass = ClusterInventory.class,
            foreignKey = "clusterUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "host", inventoryClass = HostInventory.class,
            foreignKey = "hostUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "image", inventoryClass = ImageInventory.class,
            foreignKey = "imageUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "instanceOffering", inventoryClass = InstanceOfferingInventory.class,
            foreignKey = "instanceOfferingUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "rootVolume", inventoryClass = VolumeInventory.class,
            foreignKey = "rootVolumeUuid", expandedInventoryKey = "uuid"),
    @ExpandedQuery(expandedField = "vmNics", inventoryClass = VmNicInventory.class,
            foreignKey = "uuid", expandedInventoryKey = "vmInstanceUuid"),
    @ExpandedQuery(expandedField = "allVolumes", inventoryClass = VolumeInventory.class,
            foreignKey = "uuid", expandedInventoryKey = "vmInstanceUuid"),
})
public class VmInstanceInventory implements Serializable, Cloneable {
    private String uuid;
    private String name;
    private String state;           // 注意：String 而非 VmInstanceState 枚举
    private String zoneUuid;
    private String hostUuid;
    private List<VmNicInventory> vmNics;        // Set → List
    private List<VolumeInventory> allVolumes;   // Set → List
    private List<VmCdRomInventory> vmCdRoms;

    protected VmInstanceInventory(VmInstanceVO vo) {
        this.setState(vo.getState().toString());  // 枚举 → String
        this.setAllVolumes(VolumeInventory.valueOf(vo.getAllVolumes()));
        this.setVmNics(VmNicInventory.valueOf(vo.getVmNics()));
    }

    public static VmInstanceInventory valueOf(VmInstanceVO vo) {
        return new VmInstanceInventory(vo);
    }
}
```

### Inventory 的关键注解

- **@Inventory**：声明与 VO 的映射关系，框架自动生成 `valueOf()` 方法
- **@ExpandedQueries**：声明查询扩展字段，允许 API 用户通过 `expand=zone` 等参数获取关联资源
- **@PythonClassInventory**：标记该类需要生成 Python SDK 绑定
- **@TypeField**：标记资源类型字段，用于多态查询

### VO → Inventory 的转换规则

| VO 中的类型 | Inventory 中的类型 | 说明 |
|-------------|-------------------|------|
| `VmInstanceState`（枚举） | `String` | 枚举转字符串，方便 JSON 序列化 |
| `Set<VmNicVO>` | `List<VmNicInventory>` | Set 转 List，嵌套 VO 转 Inventory |
| `Set<VolumeVO>` | `List<VolumeInventory>` | 同上 |
| `long memorySize` | `Long memorySize` | 基本类型转包装类型 |
| `@APINoSee Long internalId` | `@APINoSee Long internalId` | 标记为 API 不可见 |

## VO_ 类：QueryDSL Q-type，不是 JPA 子类

ZStack 源码中存在大量 `VO_` 类，如 `VmInstanceVO_`、`VmInstanceAO_`。这些类 **不是** VO 的子类，而是 JPA Criteria API 的 Static Metamodel 和 QueryDSL 的 Q-type：

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceVO_.java

```java
@StaticMetamodel(VmInstanceVO.class)
public class VmInstanceVO_ extends VmInstanceAO_ {
}
```

> 源码位置：zstack/header/src/main/java/org/zstack/header/vm/VmInstanceAO_.java

```java
@StaticMetamodel(VmInstanceAO.class)
public class VmInstanceAO_ extends ResourceVO_ {
    public static volatile SingularAttribute<VmInstanceAO, String> name;
    public static volatile SingularAttribute<VmInstanceAO, String> zoneUuid;
    public static volatile SingularAttribute<VmInstanceAO, String> clusterUuid;
    public static volatile SingularAttribute<VmInstanceAO, String> hostUuid;
    public static volatile SingularAttribute<VmInstanceAO, VmInstanceState> state;
    public static volatile SingularAttribute<VmInstanceAO, Long> memorySize;
    public static volatile SingularAttribute<VmInstanceAO, Integer> cpuNum;
    // ... 更多字段
}
```

这些 `SingularAttribute` 字段由 JPA Metamodel 注解处理器在编译期自动填充，用于类型安全的 Criteria 查询：

```java
// 使用 VO_ 进行类型安全查询
criteriaQuery.where(cb.equal(root.get(VmInstanceVO_.state), VmInstanceState.Running));
```

**常见误解**：`VmInstanceVO_` 不是 `VmInstanceVO` 的子类。它只是编译期元数据容器，运行时通过 JPA provider 填充 `volatile` 字段。

## 三层模型的完整流转

```
数据库行 → VmInstanceVO (JPA 加载，含 EAGER 关系)
         → VmInstanceInventory.valueOf(vo)  (构造 Inventory)
         → APICreateVmInstanceEvent.setInventory(inv)  (放入 API Event)
         → JSON 序列化返回给客户端
```

```
API 请求 → APICreateVmInstanceMsg (反序列化)
         → 业务逻辑处理
         → new VmInstanceVO()  (创建 VO)
         → EntityManager.persist()  (持久化到数据库)
         → VmInstanceInventory.valueOf(vo)  (构造响应)
```

## 小结

AO/VO/Inventory 三层模型是 ZStack 数据建模的核心范式：

- **AO**：纯粹的数据库列定义，`@MappedSuperclass`，可被 VO 和 EO 复用
- **VO**：JPA 实体，添加关系映射和 `@EntityGraph`，是业务逻辑操作的对象
- **Inventory**：纯 POJO，API 响应专用，从 VO 转换而来，无 JPA 注解

这种分层确保了数据库模型、业务逻辑和 API 契约的清晰边界，使得每一层都可以独立演化而不影响其他层。
